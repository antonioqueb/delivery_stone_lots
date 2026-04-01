## ./__init__.py
```py
# -*- coding: utf-8 -*-
from . import models```

## ./__manifest__.py
```py
# -*- coding: utf-8 -*-
{
    'name': 'Delivery Stone Lots Viewer',
    'version': '19.0.2.0.0',
    'category': 'Inventory',
    'summary': 'Visualización y gestión de lotes (placas) en albarán de entrega',
    'author': 'Alphaqueb Consulting SAS',
    'website': 'https://alphaqueb.com',
    'depends': ['stock', 'stock_lot_dimensions'],
    'data': [
        'views/stock_picking_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'delivery_stone_lots/static/src/scss/delivery_lots_styles.scss',
            'delivery_stone_lots/static/src/components/delivery_lots_button/delivery_lots_button.xml',
            'delivery_stone_lots/static/src/components/delivery_lots_button/delivery_lots_button.js',
        ],
    },
    'installable': True,
    'application': False,
    'license': 'OPL-1',
}```

## ./models/__init__.py
```py
# -*- coding: utf-8 -*-
from . import stock_move
from . import stock_quant```

## ./models/stock_move.py
```py
# -*- coding: utf-8 -*-
from odoo import models, fields, api
import logging

_logger = logging.getLogger(__name__)

class StockMove(models.Model):
    _inherit = 'stock.move'

    is_dlots_expanded = fields.Boolean(
        string='Ver Placas',
        default=False,
        copy=False,
    )

    x_original_demand = fields.Float(
        string='Solicitud Original',
        compute='_compute_original_demand',
        store=False,
        digits='Product Unit of Measure',
        help='Cantidad demandada originalmente en la orden de venta.',
    )

    @api.depends('sale_line_id', 'sale_line_id.product_uom_qty')
    def _compute_original_demand(self):
        for move in self:
            if move.sale_line_id:
                move.x_original_demand = move.sale_line_id.product_uom_qty
            else:
                move.x_original_demand = 0.0

    def action_set_delivery_lots(self, lot_ids):
        """
        Recibe los IDs exactos que deben quedar asignados a este movimiento.
        Crea los faltantes, elimina los removidos y fuerza la sincronización.
        """
        self.ensure_one()
        current_lines = self.move_line_ids.filtered(lambda l: l.lot_id)
        current_lot_map = {line.lot_id.id: line for line in current_lines}
        current_lot_ids = set(current_lot_map.keys())
        new_lot_ids = set(lot_ids or [])

        to_remove = current_lot_ids - new_lot_ids
        to_add = new_lot_ids - current_lot_ids

        # 1. Eliminar placas deseleccionadas
        if to_remove:
            lines_to_unlink = self.env['stock.move.line'].browse([current_lot_map[lid].id for lid in to_remove])
            lines_to_unlink.unlink()

        # 2. Agregar placas nuevas seleccionadas
        if to_add:
            lines_vals = []
            for lot_id in to_add:
                quant = self.env['stock.quant'].search([
                    ('lot_id', '=', lot_id),
                    ('product_id', '=', self.product_id.id),
                    ('location_id.usage', '=', 'internal'),
                    ('quantity', '>', 0)
                ], limit=1)

                qty = quant.quantity if quant else 0.0
                loc_id = quant.location_id.id if quant else self.location_id.id

                lines_vals.append({
                    'move_id': self.id,
                    'picking_id': self.picking_id.id,
                    'product_id': self.product_id.id,
                    'lot_id': lot_id,
                    'quantity': qty,
                    'location_id': loc_id,
                    'location_dest_id': self.location_dest_id.id,
                })
            
            if lines_vals:
                self.env['stock.move.line'].create(lines_vals)

        # 3. Forzar actualización de cantidades
        return self.action_update_quantity_from_lines()

    def action_update_quantity_from_lines(self):
        self.ensure_one()
        total_qty = sum(self.move_line_ids.mapped('quantity'))
        _logger.info(
            "[DLOTS] Actualizando cantidad move %s: %s -> %s (lines: %s)",
            self.id, self.product_uom_qty, total_qty, len(self.move_line_ids)
        )
        if self.state in ('draft', 'confirmed', 'waiting', 'assigned'):
            self.write({'product_uom_qty': total_qty, 'quantity': total_qty})
        return True```

## ./models/stock_quant.py
```py
# -*- coding: utf-8 -*-
from odoo import models, api
import logging
_logger = logging.getLogger(__name__)


class StockQuantDelivery(models.Model):
    _inherit = 'stock.quant'

    @api.model
    def search_stone_inventory_for_delivery(self, product_id, filters=None, current_lot_ids=None, move_id=None, page=0, page_size=35):
        """
        Inventario disponible para albarán de entrega.
        - Muestra TODO el stock disponible en ubicaciones internas (qty > 0).
        - Excluye lotes comprometidos en move_lines de OTROS pickings/moves activos
          (no del move actual, para que los ya asignados sigan visibles y seleccionables).
        - NO excluye por SO lines: en entrega podemos enviar más de lo pedido.
        - current_lot_ids: lotes ya en este move — siempre aparecen en el popup,
          sin importar si están reservados, para que el usuario pueda des-seleccionarlos.
        """
        if not filters:
            filters = {}

        safe_current_ids = []
        if current_lot_ids:
            if isinstance(current_lot_ids, list):
                safe_current_ids = [x for x in current_lot_ids if isinstance(x, int)]

        product_id = int(product_id)

        # Lotes en move_lines de OTROS moves activos (no cancelados/hechos, no el move actual)
        committed_domain = [
            ('product_id', '=', product_id),
            ('lot_id', '!=', False),
            ('state', 'not in', ['done', 'cancel']),
        ]
        if move_id:
            committed_domain.append(('move_id', '!=', int(move_id)))

        committed_lines = self.env['stock.move.line'].search(committed_domain)
        committed_ids = set(committed_lines.mapped('lot_id').ids)

        # Los lotes de nuestro move actual nunca se excluyen
        excluded_lot_ids = [lid for lid in committed_ids if lid not in safe_current_ids]

        _logger.info(
            "[DLOTS SEARCH] product=%s move=%s committed_other=%s excluded=%s current=%s",
            product_id, move_id, len(committed_ids), len(excluded_lot_ids), len(safe_current_ids)
        )

        # Dominio base: stock físico positivo en ubicaciones internas
        base_domain = [
            ('product_id', '=', product_id),
            ('location_id.usage', '=', 'internal'),
            ('quantity', '>', 0),
        ]

        if excluded_lot_ids:
            base_domain.append(('lot_id', 'not in', excluded_lot_ids))

        # Condición de disponibilidad:
        # - libre (no reservado, sin hold) — placas nuevas que se pueden agregar
        # - O ya está en nuestro move actual — para que sigan visibles aunque estén reservadas
        free_conditions = [('reserved_quantity', '=', 0)]
        if 'x_tiene_hold' in self.env['stock.quant']._fields:
            free_conditions.append(('x_tiene_hold', '=', False))

        if safe_current_ids:
            # '|' lot_id in current  OR  (&  reserved=0  AND  no_hold)
            availability_domain = ['|', ('lot_id', 'in', safe_current_ids)] + ['&'] + free_conditions
        else:
            availability_domain = list(free_conditions)

        domain = base_domain + availability_domain

        # Filtros opcionales
        if filters.get('bloque'):
            domain.append(('lot_id.x_bloque', 'ilike', filters['bloque']))
        if filters.get('atado'):
            domain.append(('lot_id.x_atado', 'ilike', filters['atado']))
        if filters.get('lot_name'):
            domain.append(('lot_id.name', 'ilike', filters['lot_name']))
        if filters.get('alto_min'):
            try:
                domain.append(('lot_id.x_alto', '>=', float(filters['alto_min'])))
            except Exception:
                pass
        if filters.get('ancho_min'):
            try:
                domain.append(('lot_id.x_ancho', '>=', float(filters['ancho_min'])))
            except Exception:
                pass

        total = self.search_count(domain)
        offset = int(page) * int(page_size)
        quants = self.search(domain, limit=int(page_size), offset=offset, order='lot_id')

        lot_ids = quants.mapped('lot_id').ids
        lots_data = self._build_lots_data(lot_ids)
        items = self._quants_to_result(quants, lots_data)

        _logger.info(
            "[DLOTS SEARCH] total=%s page=%s returned=%s",
            total, page, len(items)
        )

        return {'items': items, 'total': total}```

## ./static/src/components/delivery_lots_button/delivery_lots_button.js
```js
/** @odoo-module */
import { registry } from "@web/core/registry";
import { standardFieldProps } from "@web/views/fields/standard_field_props";
import { Component, useState, onWillStart, onWillUpdateProps, onWillUnmount } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class DeliveryLotsButton extends Component {
    static template = "delivery_stone_lots.DeliveryLotsButton";
    static props = { ...standardFieldProps };

    setup() {
        this.orm = useService("orm");
        this._detailsRow = null;
        this._popupRoot = null;
        this._popupKeyHandler = null;
        this._popupObserver = null;

        this.state = useState({
            isExpanded: false,
            lotCount: 0,
        });

        onWillStart(() => this._refreshCount());
        onWillUpdateProps((nextProps) => this._refreshCount(nextProps));
        onWillUnmount(() => {
            this.removeDetailsRow();
            this.destroyPopup();
        });
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    getMoveId(props = this.props) {
        const record = props?.record;
        if (!record) return null;
        if (record.resId && record.resId > 0) return record.resId;
        const dataId = record.data?.id;
        if (dataId && typeof dataId === 'number' && dataId > 0) return dataId;
        if (record.id && typeof record.id === 'number' && record.id > 0) return record.id;
        return null;
    }

    getProductId(props = this.props) {
        const pd = props?.record?.data?.product_id;
        if (!pd) return null;
        if (Array.isArray(pd)) return pd[0];
        if (typeof pd === "number") return pd;
        if (pd?.id) return pd.id;
        return null;
    }

    getProductName(props = this.props) {
        const pd = props?.record?.data?.product_id;
        if (!pd) return "";
        if (Array.isArray(pd)) return pd[1] || "";
        return pd?.display_name || "";
    }

    getLocationId(props = this.props) {
        const loc = props?.record?.data?.location_id;
        if (!loc) return null;
        if (Array.isArray(loc)) return loc[0];
        if (loc?.id) return loc.id;
        return null;
    }

    getLocationDestId(props = this.props) {
        const loc = props?.record?.data?.location_dest_id;
        if (!loc) return null;
        if (Array.isArray(loc)) return loc[0];
        if (loc?.id) return loc.id;
        return null;
    }

    getPickingId(props = this.props) {
        const p = props?.record?.data?.picking_id;
        if (!p) return null;
        if (Array.isArray(p)) return p[0];
        if (p?.id) return p.id;
        return null;
    }

    async _syncOdooState() {
        try {
            const wasExpanded = this.state.isExpanded;

            if (this.props.record && this.props.record.model && this.props.record.model.root) {
                await this.props.record.model.root.load();
            }

            await this._refreshCount();

            if (wasExpanded) {
                const btnEl = this.__owl__?.bdom?.el || this.el;
                if (btnEl) {
                    const tr = btnEl.closest("tr");
                    if (tr) {
                        if (!tr.nextElementSibling?.classList.contains("dlots-selected-row")) {
                            this._detailsRow = null;
                            await this.injectSelectedTable(tr);
                        } else {
                            await this.refreshSelectedTable();
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("[DLOTS] Error sincronizando estado Odoo:", e);
        }
    }

    async _refreshCount(props = this.props) {
        const moveId = this.getMoveId(props);
        if (!moveId) {
            this.state.lotCount = 0;
            return;
        }
        try {
            const lines = await this.orm.searchRead(
                "stock.move.line",
                [["move_id", "=", moveId], ["lot_id", "!=", false]],
                ["lot_id"],
                { limit: 200 }
            );
            const uniqueLots = new Set(lines.map((l) => l.lot_id[0]));
            this.state.lotCount = uniqueLots.size;
        } catch (e) {
            console.error("[DLOTS] Error refreshCount:", e);
            this.state.lotCount = 0;
        }
    }

    async _loadCurrentLotData() {
        const moveId = this.getMoveId();
        if (!moveId) return [];
        try {
            const lines = await this.orm.searchRead(
                "stock.move.line",
                [["move_id", "=", moveId], ["lot_id", "!=", false]],
                ["lot_id", "quantity", "location_id"],
                { limit: 500 }
            );
            const map = {};
            for (const l of lines) {
                const lotId = l.lot_id[0];
                if (!map[lotId]) {
                    map[lotId] = { lotId, lotName: l.lot_id[1], qty: 0, locationName: l.location_id?.[1] || "" };
                }
                map[lotId].qty += l.quantity || 0;
            }
            return Object.values(map);
        } catch (e) {
            console.error("[DLOTS] Error _loadCurrentLotData:", e);
            return [];
        }
    }

    async _getCurrentLotIds() {
        const data = await this._loadCurrentLotData();
        return data.map((d) => d.lotId);
    }

    // ─── Toggle principal ─────────────────────────────────────────────────────

    async handleToggle(ev) {
        ev.stopPropagation();
        ev.preventDefault();

        if (this.state.isExpanded) {
            this.removeDetailsRow();
            this.state.isExpanded = false;
            return;
        }

        const moveId = this.getMoveId();
        if (!moveId) {
            console.warn("[DLOTS] No hay moveId disponible — ¿El picking está guardado?");
            alert("Guarda el albarán antes de gestionar las placas.");
            return;
        }

        document.querySelectorAll(".dlots-selected-row").forEach((e) => e.remove());
        document.querySelectorAll(".stone-selected-row").forEach((e) => e.remove());

        const tr = ev.currentTarget.closest("tr");
        if (!tr) return;

        this.state.isExpanded = true;
        await this.injectSelectedTable(tr);
    }

    // ─── Tabla inline de seleccionadas ────────────────────────────────────────

    async injectSelectedTable(currentRow) {
        const newTr = document.createElement("tr");
        newTr.className = "dlots-selected-row";

        const colCount = currentRow.querySelectorAll("td").length || 10;
        const td = document.createElement("td");
        td.colSpan = colCount;
        td.className = "dlots-selected-cell";

        const container = document.createElement("div");
        container.className = "dlots-selected-container";

        const header = document.createElement("div");
        header.className = "dlots-selected-header";
        const currentLotIds = await this._getCurrentLotIds();
        header.innerHTML = `
            <span class="dlots-selected-title">
                <i class="fa fa-check-circle me-2"></i>
                Placas asignadas
                <span class="dlots-sel-badge" id="dlots-sel-badge">${currentLotIds.length}</span>
            </span>
            <button class="dlots-add-btn dlots-add-btn-trigger">
                <i class="fa fa-plus me-1"></i> Agregar placa
            </button>
        `;

        const body = document.createElement("div");
        body.className = "dlots-selected-body";

        container.appendChild(header);
        container.appendChild(body);
        td.appendChild(container);
        newTr.appendChild(td);
        currentRow.after(newTr);
        this._detailsRow = newTr;

        await this.renderSelectedTable(body);

        header.querySelector(".dlots-add-btn-trigger").addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.openPopup();
        });
    }

    async renderSelectedTable(container) {
        container.innerHTML = `<div class="dlots-table-loading"><i class="fa fa-circle-o-notch fa-spin me-2"></i> Cargando datos...</div>`;

        const moveLineData = await this._loadCurrentLotData();

        if (!moveLineData.length) {
            container.innerHTML = `
                <div class="dlots-no-selection">
                    <i class="fa fa-info-circle me-2 text-muted"></i>
                    <span class="text-muted">Sin placas asignadas. Usa <strong>Agregar placa</strong> para comenzar.</span>
                </div>`;
            return;
        }

        try {
            const lotIds = moveLineData.map((d) => d.lotId);
            const lotsData = await this.orm.searchRead(
                "stock.lot",
                [["id", "in", lotIds]],
                ["name", "x_bloque", "x_atado", "x_grupo", "x_alto", "x_ancho", "x_grosor",
                 "x_tipo", "x_color", "x_pedimento", "x_contenedor", "x_detalles_placa"],
                { limit: lotIds.length }
            );

            const lotMap = Object.fromEntries(lotsData.map((l) => [l.id, l]));
            const qtyMap = Object.fromEntries(moveLineData.map((d) => [d.lotId, d.qty]));
            const locMap = Object.fromEntries(moveLineData.map((d) => [d.lotId, d.locationName]));

            let totalQty = 0;
            let rows = "";
            for (const lotId of lotIds) {
                const lot = lotMap[lotId];
                if (!lot) continue;
                const qty = qtyMap[lotId] || 0;
                const loc = (locMap[lotId] || "").split("/").pop();
                totalQty += qty;

                rows += `
                    <tr data-lot-row="${lotId}">
                        <td class="cell-lot">${lot.name}</td>
                        <td>${lot.x_bloque || "-"}</td>
                        <td>${lot.x_atado || "-"}</td>
                        <td>${lot.x_grupo || "-"}</td>
                        <td class="col-num">${lot.x_alto ? lot.x_alto.toFixed(0) : "-"}</td>
                        <td class="col-num">${lot.x_ancho ? lot.x_ancho.toFixed(0) : "-"}</td>
                        <td class="col-num">${lot.x_grosor || "-"}</td>
                        <td class="col-num fw-semibold">${qty.toFixed(2)}</td>
                        <td>${lot.x_tipo || "-"}</td>
                        <td>${lot.x_color || "-"}</td>
                        <td class="text-muted">${loc || "-"}</td>
                        <td class="text-muted dlots-font-mono">${lot.x_pedimento || "-"}</td>
                        <td class="text-center">
                            ${lot.x_detalles_placa
                                ? `<i class="fa fa-exclamation-triangle text-warning" title="${lot.x_detalles_placa}"></i>`
                                : '<span class="text-muted">-</span>'}
                        </td>
                        <td class="col-act">
                            <button class="dlots-remove-btn" data-lot-id="${lotId}" title="Quitar">
                                <i class="fa fa-times"></i>
                            </button>
                        </td>
                    </tr>`;
            }

            container.innerHTML = `
                <table class="dlots-sel-table">
                    <thead>
                        <tr>
                            <th>Lote</th>
                            <th>Bloque</th>
                            <th>Atado</th>
                            <th>Grupo</th>
                            <th class="col-num">Alto</th>
                            <th class="col-num">Ancho</th>
                            <th class="col-num">Esp.</th>
                            <th class="col-num">M²</th>
                            <th>Tipo</th>
                            <th>Color</th>
                            <th>Ubicación</th>
                            <th>Pedimento</th>
                            <th class="text-center">Notas</th>
                            <th class="col-act"></th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                    <tfoot>
                        <tr class="dlots-total-row">
                            <td colspan="7" class="text-end fw-bold text-muted">
                                Total (<span class="dlots-total-count">${lotIds.length}</span> placa${lotIds.length !== 1 ? "s" : ""}):
                            </td>
                            <td class="col-num fw-bold dlots-total-qty">${totalQty.toFixed(2)}</td>
                            <td colspan="6"></td>
                        </tr>
                    </tfoot>
                </table>`;

            container.querySelectorAll(".dlots-remove-btn").forEach((btn) => {
                btn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    await this.removeLot(parseInt(btn.dataset.lotId));
                });
            });
        } catch (err) {
            console.error("[DLOTS] Error renderizando tabla:", err);
            container.innerHTML = `<div class="text-danger p-2"><i class="fa fa-exclamation-triangle me-2"></i>Error: ${err.message}</div>`;
        }
    }

    async removeLot(lotId) {
        const moveId = this.getMoveId();
        if (!moveId) return;

        const row = this._detailsRow?.querySelector(`tr[data-lot-row="${lotId}"]`);
        if (row) {
            row.style.transition = "opacity 0.25s ease, transform 0.25s ease";
            row.style.opacity = "0";
            row.style.transform = "translateX(-20px)";
        }

        try {
            const currentIds = await this._getCurrentLotIds();
            const newIds = currentIds.filter(id => id !== lotId);

            await this.orm.call("stock.move", "action_set_delivery_lots", [moveId, newIds]);

            if (row) {
                await new Promise((r) => setTimeout(r, 260));
                row.remove();
            }

            await this._syncOdooState();

        } catch (err) {
            console.error("[DLOTS] Error eliminando lote:", err);
            await this.refreshSelectedTable();
        }
    }

    async refreshSelectedTable() {
        if (!this._detailsRow) return;
        const body = this._detailsRow.querySelector(".dlots-selected-body");
        if (!body) return;
        const lotIds = await this._getCurrentLotIds();
        const badge = this._detailsRow.querySelector(".dlots-sel-badge");
        if (badge) badge.textContent = lotIds.length;
        await this.renderSelectedTable(body);
    }

    removeDetailsRow() {
        if (this._detailsRow) {
            this._detailsRow.remove();
            this._detailsRow = null;
        }
    }

    // ─── POPUP fullscreen ─────────────────────────────────────────────────────

    async openPopup() {
        this.destroyPopup();
        const productId = this.getProductId();
        if (!productId) return;

        this._popupRoot = document.createElement("div");
        this._popupRoot.className = "dlots-popup-root";
        document.body.appendChild(this._popupRoot);

        await this._renderPopupDOM(productId);
    }

    async _renderPopupDOM(productId) {
        const root = this._popupRoot;
        const PAGE_SIZE = 35;
        const moveId = this.getMoveId();

        const currentLotIds = await this._getCurrentLotIds();

        const state = {
            quants: [],
            totalCount: 0,
            hasMore: false,
            isLoading: false,
            isLoadingMore: false,
            page: 0,
            pendingIds: new Set(currentLotIds),
            filters: { lot_name: "", bloque: "", atado: "", alto_min: "", ancho_min: "" },
        };

        let searchTimeout = null;

        root.innerHTML = `
            <div class="dlots-popup-overlay" id="dlots-overlay">
                <div class="dlots-popup-container">

                    <div class="dlots-popup-header">
                        <div class="dlots-popup-title">
                            <i class="fa fa-th me-2"></i>
                            Placas disponibles para entrega
                            <span class="dlots-popup-subtitle">${this.getProductName() ? "— " + this.getProductName() : ""}</span>
                        </div>
                        <div class="dlots-popup-header-actions">
                            <span class="dlots-badge-selected">
                                <i class="fa fa-check-circle me-1"></i>
                                <span id="dp-badge-count">${state.pendingIds.size}</span> seleccionadas
                            </span>
                            <button class="dlots-btn dlots-btn-accent" id="dp-confirm-top">
                                <i class="fa fa-check me-1"></i> Confirmar
                            </button>
                            <button class="dlots-btn dlots-btn-ghost" id="dp-close">
                                <i class="fa fa-times"></i>
                            </button>
                        </div>
                    </div>

                    <div class="dlots-popup-filters">
                        <div class="dlots-filter-group">
                            <label>Lote</label>
                            <input type="text" class="dlots-filter-input" id="df-lot" placeholder="Buscar lote..."/>
                        </div>
                        <div class="dlots-filter-group">
                            <label>Bloque</label>
                            <input type="text" class="dlots-filter-input" id="df-bloque" placeholder="Bloque..."/>
                        </div>
                        <div class="dlots-filter-group">
                            <label>Atado</label>
                            <input type="text" class="dlots-filter-input" id="df-atado" placeholder="Atado..."/>
                        </div>
                        <div class="dlots-filter-group">
                            <label>Alto mín.</label>
                            <input type="number" class="dlots-filter-input dlots-filter-sm" id="df-alto" placeholder="0"/>
                        </div>
                        <div class="dlots-filter-group">
                            <label>Ancho mín.</label>
                            <input type="number" class="dlots-filter-input dlots-filter-sm" id="df-ancho" placeholder="0"/>
                        </div>
                        <div class="dlots-filter-actions">
                            <button class="dlots-btn dlots-btn-select-all" id="dp-select-all" title="Seleccionar todas las placas visibles">
                                <i class="fa fa-check-square-o me-1"></i> Seleccionar todo
                            </button>
                            <button class="dlots-btn dlots-btn-clear-all" id="dp-clear-all" title="Borrar toda la selección">
                                <i class="fa fa-square-o me-1"></i> Borrar selección
                            </button>
                        </div>
                        <div class="dlots-filter-spacer"></div>
                        <div class="dlots-filter-stats">
                            <span id="dp-stat" class="dlots-filter-stat-loading">
                                <i class="fa fa-circle-o-notch fa-spin me-1"></i> Buscando...
                            </span>
                        </div>
                    </div>

                    <div class="dlots-popup-body" id="dp-body">
                        <div class="dlots-empty-state">
                            <i class="fa fa-circle-o-notch fa-spin fa-2x text-muted"></i>
                            <div class="dlots-empty-text mt-2">Cargando inventario...</div>
                        </div>
                    </div>

                    <div class="dlots-popup-footer">
                        <span class="dlots-footer-info" id="dp-footer-info">—</span>
                        <div class="dlots-footer-actions">
                            <button class="dlots-btn dlots-btn-outline" id="dp-cancel">Cancelar</button>
                            <button class="dlots-btn dlots-btn-primary-dark" id="dp-confirm-bottom">
                                <i class="fa fa-check me-1"></i> Agregar selección
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const overlay = root.querySelector("#dlots-overlay");
        const body = root.querySelector("#dp-body");
        const stat = root.querySelector("#dp-stat");
        const footerInfo = root.querySelector("#dp-footer-info");
        const badgeCount = root.querySelector("#dp-badge-count");

        const updateBadge = () => { badgeCount.textContent = state.pendingIds.size; };

        const updateStats = () => {
            stat.className = "dlots-filter-stat-count";
            stat.innerHTML = `${state.totalCount} placas disponibles`;
            footerInfo.innerHTML = `Mostrando <strong>${state.quants.length}</strong> de <strong>${state.totalCount}</strong>`;
        };

        // ─── Seleccionar todo (visibles/cargadas) ────────────────────────────
        const doSelectAll = () => {
            for (const q of state.quants) {
                const lotId = q.lot_id ? q.lot_id[0] : 0;
                if (lotId) state.pendingIds.add(lotId);
            }
            updateBadge();
            body.querySelectorAll("tr[data-lot-id]").forEach((tr) => {
                const lotId = parseInt(tr.dataset.lotId);
                if (!lotId) return;
                tr.className = "row-sel";
                const chk = tr.querySelector(".dlots-chkbox");
                if (chk) {
                    chk.className = "dlots-chkbox checked";
                    chk.innerHTML = '<i class="fa fa-check"></i>';
                }
                const tag = tr.querySelector(".dlots-tag");
                if (tag) {
                    tag.className = "dlots-tag dlots-tag-ok";
                    tag.textContent = "Selec.";
                }
            });
        };

        // ─── Borrar selección ────────────────────────────────────────────────
        const doClearAll = () => {
            state.pendingIds.clear();
            updateBadge();
            body.querySelectorAll("tr[data-lot-id]").forEach((tr) => {
                tr.className = "";
                const chk = tr.querySelector(".dlots-chkbox");
                if (chk) {
                    chk.className = "dlots-chkbox";
                    chk.innerHTML = "";
                }
                const tag = tr.querySelector(".dlots-tag");
                if (tag) {
                    const reserved = tr.dataset.reserved === "1";
                    if (reserved) {
                        tag.className = "dlots-tag dlots-tag-warn";
                        tag.textContent = "Reservado";
                    } else {
                        tag.className = "dlots-tag dlots-tag-free";
                        tag.textContent = "Libre";
                    }
                }
            });
        };

        const renderTable = () => {
            if (state.quants.length === 0 && !state.isLoading) {
                body.innerHTML = `
                    <div class="dlots-empty-state">
                        <i class="fa fa-inbox fa-3x text-muted"></i>
                        <div class="dlots-empty-text mt-2">No hay placas con estos filtros</div>
                    </div>`;
                updateStats();
                return;
            }

            let rows = "";
            for (const q of state.quants) {
                const lotId = q.lot_id ? q.lot_id[0] : 0;
                const lotName = q.lot_id ? q.lot_id[1] : "-";
                const loc = q.location_id ? q.location_id[1].split("/").pop() : "-";
                const sel = state.pendingIds.has(lotId);
                const reserved = q.reserved_quantity > 0;

                let statusBadge = `<span class="dlots-tag dlots-tag-free">Libre</span>`;
                if (sel) statusBadge = `<span class="dlots-tag dlots-tag-ok">Selec.</span>`;
                else if (reserved) statusBadge = `<span class="dlots-tag dlots-tag-warn">Reservado</span>`;

                rows += `
                    <tr class="${sel ? "row-sel" : ""}" data-lot-id="${lotId}" data-reserved="${reserved ? "1" : "0"}">
                        <td class="col-chk">
                            <div class="dlots-chkbox ${sel ? "checked" : ""}">
                                ${sel ? '<i class="fa fa-check"></i>' : ""}
                            </div>
                        </td>
                        <td class="cell-lot">${lotName}</td>
                        <td>${q.x_bloque || "-"}</td>
                        <td>${q.x_atado || "-"}</td>
                        <td class="col-num">${q.x_alto ? q.x_alto.toFixed(0) : "-"}</td>
                        <td class="col-num">${q.x_ancho ? q.x_ancho.toFixed(0) : "-"}</td>
                        <td class="col-num">${q.x_grosor || "-"}</td>
                        <td class="col-num fw-semibold">${q.quantity ? q.quantity.toFixed(2) : "-"}</td>
                        <td>${q.x_tipo || "-"}</td>
                        <td>${q.x_color || "-"}</td>
                        <td class="cell-loc">${loc}</td>
                        <td>${statusBadge}</td>
                    </tr>`;
            }

            const sentinel = `
                <div id="dp-sentinel" class="dlots-scroll-sentinel">
                    ${state.isLoadingMore ? '<div class="dlots-loading-more"><i class="fa fa-circle-o-notch fa-spin me-2"></i> Cargando más...</div>' : ""}
                    ${state.hasMore && !state.isLoadingMore ? '<div class="dlots-scroll-hint"><i class="fa fa-chevron-down me-1"></i> Desplázate para cargar más</div>' : ""}
                </div>`;

            body.innerHTML = `
                <table class="dlots-popup-table">
                    <thead>
                        <tr>
                            <th class="col-chk">✓</th>
                            <th>Lote</th>
                            <th>Bloque</th>
                            <th>Atado</th>
                            <th class="col-num">Alto</th>
                            <th class="col-num">Ancho</th>
                            <th class="col-num">Gros.</th>
                            <th class="col-num">M²</th>
                            <th>Tipo</th>
                            <th>Color</th>
                            <th>Ubicación</th>
                            <th>Estado</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                ${sentinel}`;

            updateStats();

            body.querySelectorAll("tr[data-lot-id]").forEach((tr) => {
                tr.style.cursor = "pointer";
                tr.addEventListener("click", () => {
                    const lotId = parseInt(tr.dataset.lotId);
                    if (!lotId) return;
                    if (state.pendingIds.has(lotId)) {
                        state.pendingIds.delete(lotId);
                    } else {
                        state.pendingIds.add(lotId);
                    }
                    const sel = state.pendingIds.has(lotId);
                    tr.className = sel ? "row-sel" : "";
                    const chk = tr.querySelector(".dlots-chkbox");
                    if (chk) {
                        chk.className = "dlots-chkbox" + (sel ? " checked" : "");
                        chk.innerHTML = sel ? '<i class="fa fa-check"></i>' : "";
                    }
                    const tag = tr.querySelector(".dlots-tag");
                    if (tag) {
                        if (sel) {
                            tag.className = "dlots-tag dlots-tag-ok";
                            tag.textContent = "Selec.";
                        } else {
                            const reserved = tr.dataset.reserved === "1";
                            tag.className = reserved ? "dlots-tag dlots-tag-warn" : "dlots-tag dlots-tag-free";
                            tag.textContent = reserved ? "Reservado" : "Libre";
                        }
                    }
                    updateBadge();
                });
            });

            // Infinite scroll
            if (this._popupObserver) {
                this._popupObserver.disconnect();
                this._popupObserver = null;
            }
            const sentinelEl = body.querySelector("#dp-sentinel");
            if (sentinelEl && state.hasMore) {
                this._popupObserver = new IntersectionObserver(
                    (entries) => {
                        if (entries[0].isIntersecting && state.hasMore && !state.isLoadingMore) {
                            loadPage(state.page + 1, false);
                        }
                    },
                    { root: body, rootMargin: "100px", threshold: 0.1 }
                );
                this._popupObserver.observe(sentinelEl);
            }
        };

        const loadPage = async (page, reset) => {
            if (reset) {
                state.isLoading = true;
                state.quants = [];
                body.innerHTML = `
                    <div class="dlots-empty-state">
                        <i class="fa fa-circle-o-notch fa-spin fa-2x text-muted"></i>
                        <div class="dlots-empty-text mt-2">Buscando...</div>
                    </div>`;
                stat.className = "dlots-filter-stat-loading";
                stat.innerHTML = `<i class="fa fa-circle-o-notch fa-spin me-1"></i> Buscando...`;
            } else {
                state.isLoadingMore = true;
            }

            try {
                const result = await this.orm.call(
                    "stock.quant",
                    "search_stone_inventory_for_delivery",
                    [],
                    {
                        product_id: productId,
                        filters: state.filters,
                        current_lot_ids: Array.from(state.pendingIds),
                        move_id: moveId,
                        page,
                        page_size: PAGE_SIZE,
                    }
                );

                const items = result.items || [];
                if (reset || page === 0) {
                    state.quants = items;
                } else {
                    state.quants = [...state.quants, ...items];
                }
                state.totalCount = result.total || 0;
                state.page = page;
                state.hasMore = state.quants.length < state.totalCount;
            } catch (err) {
                console.error("[DLOTS POPUP] Error llamando search_stone_inventory_for_delivery:", err);
                body.innerHTML = `
                    <div class="dlots-empty-state">
                        <i class="fa fa-exclamation-triangle fa-2x text-danger"></i>
                        <div class="dlots-empty-text mt-2 text-danger">Error: ${err.message}</div>
                    </div>`;
                return;
            } finally {
                state.isLoading = false;
                state.isLoadingMore = false;
            }

            renderTable();
        };

        // ─── Confirmar ────────────────────────────────────────────────────────
        const doConfirm = async () => {
            this.destroyPopup();

            if (!moveId) return;

            try {
                const finalLotIds = Array.from(state.pendingIds);
                await this.orm.call("stock.move", "action_set_delivery_lots", [moveId, finalLotIds]);
                await this._syncOdooState();
            } catch (err) {
                console.error("[DLOTS] Error confirmando selección:", err);
                alert(`Error al guardar: ${err.message}`);
            }
        };

        const doClose = () => this.destroyPopup();

        root.querySelector("#dp-close").addEventListener("click", doClose);
        root.querySelector("#dp-cancel").addEventListener("click", doClose);
        root.querySelector("#dp-confirm-top").addEventListener("click", doConfirm);
        root.querySelector("#dp-confirm-bottom").addEventListener("click", doConfirm);
        root.querySelector("#dp-select-all").addEventListener("click", doSelectAll);
        root.querySelector("#dp-clear-all").addEventListener("click", doClearAll);
        overlay.addEventListener("click", (e) => { if (e.target === overlay) doClose(); });

        const onKeyDown = (e) => { if (e.key === "Escape") doClose(); };
        document.addEventListener("keydown", onKeyDown);
        this._popupKeyHandler = onKeyDown;

        const bindFilter = (id, key) => {
            const input = root.querySelector(`#${id}`);
            if (!input) return;
            input.addEventListener("input", (e) => {
                state.filters[key] = e.target.value;
                if (searchTimeout) clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => loadPage(0, true), 350);
            });
        };
        bindFilter("df-lot", "lot_name");
        bindFilter("df-bloque", "bloque");
        bindFilter("df-atado", "atado");
        bindFilter("df-alto", "alto_min");
        bindFilter("df-ancho", "ancho_min");

        loadPage(0, true);
    }

    destroyPopup() {
        if (this._popupObserver) {
            this._popupObserver.disconnect();
            this._popupObserver = null;
        }
        if (this._popupKeyHandler) {
            document.removeEventListener("keydown", this._popupKeyHandler);
            this._popupKeyHandler = null;
        }
        if (this._popupRoot) {
            this._popupRoot.remove();
            this._popupRoot = null;
        }
    }
}

registry.category("fields").add("delivery_lots_button", {
    component: DeliveryLotsButton,
    displayName: "Botón Lotes Albarán",
    supportedTypes: ["boolean"],
});```

## ./static/src/components/delivery_lots_button/delivery_lots_button.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<templates xml:space="preserve">
    <t t-name="delivery_stone_lots.DeliveryLotsButton" owl="1">
        <div class="dlots-field-wrapper" t-on-click.stop="handleToggle">
            <button
                class="dlots-toggle-btn"
                t-att-class="state.isExpanded ? 'active' : ''"
                title="Ver/gestionar placas asignadas"
            >
                <i class="fa fa-th-large" t-if="!state.isExpanded"/>
                <i class="fa fa-chevron-up" t-if="state.isExpanded"/>
                <span
                    t-if="state.lotCount > 0 and !state.isExpanded"
                    class="dlots-count-badge"
                >
                    <t t-esc="state.lotCount"/>
                </span>
            </button>
        </div>
    </t>
</templates>```

## ./static/src/scss/delivery_lots_styles.scss
```scss
// ═══════════════════════════════════════════════════════════════════════════
// DELIVERY STONE LOTS — Estilos
// Paleta idéntica a sale_stone_selection (stone_styles.scss)
// ═══════════════════════════════════════════════════════════════════════════

$dl-primary:       #2c5282;
$dl-primary-light: #3182ce;
$dl-accent:        #68d391;
$dl-bg:            #f7fafc;
$dl-border:        #e2e8f0;
$dl-text:          #2d3748;
$dl-muted:         #718096;
$dl-danger:        #fc8181;
$dl-radius:        8px;
$dl-radius-sm:     5px;

// ── Botón toggle en la lista ──────────────────────────────────────────────
.dlots-field-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
}

.dlots-toggle-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1.5px solid $dl-border;
    border-radius: $dl-radius-sm;
    background: white;
    color: $dl-primary;
    cursor: pointer;
    transition: all 0.15s ease;
    position: relative;
    padding: 0;

    &:hover {
        border-color: $dl-primary-light;
        background: #ebf8ff;
        color: $dl-primary-light;
        transform: scale(1.08);
    }

    &.active {
        background: $dl-primary;
        border-color: $dl-primary;
        color: white;
    }

    i { font-size: 13px; }
}

.dlots-count-badge {
    position: absolute;
    top: -6px;
    right: -6px;
    background: $dl-accent;
    color: #1a202c;
    font-size: 9px;
    font-weight: 700;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 3px;
    line-height: 1;
    border: 1.5px solid white;
}

// ── Fila inline de seleccionadas ──────────────────────────────────────────
.dlots-selected-row td.dlots-selected-cell {
    padding: 0 !important;
    background: #f0f7ff;
    border-top: 2px solid $dl-primary;
    border-bottom: 2px solid $dl-border;
}

.dlots-selected-container {
    background: white;
    overflow: hidden;
}

.dlots-selected-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: $dl-bg;
    border-bottom: 1px solid $dl-border;
}

.dlots-selected-title {
    font-size: 12px;
    font-weight: 600;
    color: $dl-primary;
    display: flex;
    align-items: center;

    i { color: $dl-accent; }
}

.dlots-sel-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: $dl-primary;
    color: white;
    font-size: 10px;
    font-weight: 700;
    min-width: 18px;
    height: 18px;
    border-radius: 9px;
    padding: 0 4px;
    margin-left: 6px;
}

.dlots-add-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    background: $dl-primary;
    color: white;
    border: none;
    border-radius: $dl-radius-sm;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;

    &:hover { background: $dl-primary-light; }
    i { font-size: 10px; }
}

.dlots-selected-body {
    max-height: 300px;
    overflow-y: auto;
    overflow-x: auto;

    &::-webkit-scrollbar { width: 6px; height: 6px; }
    &::-webkit-scrollbar-thumb { background: #cbd5e0; border-radius: 3px; }
}

.dlots-no-selection {
    padding: 16px 14px;
    font-size: 12px;
    color: $dl-muted;
    display: flex;
    align-items: center;
    gap: 6px;
}

.dlots-table-loading {
    padding: 20px;
    text-align: center;
    color: $dl-muted;
    font-size: 12px;
}

// Tabla inline de seleccionadas
.dlots-sel-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11.5px;

    thead tr { background: #f8fafc; }

    th {
        padding: 6px 8px;
        text-align: left;
        font-weight: 600;
        font-size: 10.5px;
        text-transform: uppercase;
        color: $dl-muted;
        border-bottom: 1px solid $dl-border;
        white-space: nowrap;

        &.col-num { text-align: right; }
        &.col-act { text-align: center; width: 36px; }
        &.text-center { text-align: center; }
    }

    tbody tr {
        transition: background 0.1s;
        &:hover { background: #f7fafc; }
        &:not(:last-child) td { border-bottom: 1px solid #f0f4f8; }
    }

    td {
        padding: 6px 8px;
        color: $dl-text;
        vertical-align: middle;

        &.col-num { text-align: right; font-variant-numeric: tabular-nums; }
        &.col-act { text-align: center; }
        &.text-center { text-align: center; }
    }

    .cell-lot {
        font-family: 'Courier New', monospace;
        font-size: 11px;
        font-weight: 700;
        color: $dl-primary;
        white-space: nowrap;
    }

    tfoot .dlots-total-row {
        background: $dl-bg;
        td {
            padding: 7px 8px;
            border-top: 2px solid $dl-border;
            font-size: 12px;
        }
    }
}

.dlots-font-mono { font-family: 'Courier New', monospace; font-size: 11px; }
.fw-semibold { font-weight: 600; }
.fw-bold { font-weight: 700; }

.dlots-remove-btn {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #fed7d7;
    border-radius: 4px;
    background: #fff5f5;
    color: #e53e3e;
    cursor: pointer;
    transition: all 0.12s;
    padding: 0;

    &:hover {
        background: #fc8181;
        border-color: #fc8181;
        color: white;
    }

    i { font-size: 10px; }
}

// ── POPUP fullscreen ──────────────────────────────────────────────────────
.dlots-popup-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    z-index: 10500;
    display: flex;
    align-items: stretch;
    justify-content: stretch;
    padding: 16px;
    box-sizing: border-box;
}

.dlots-popup-container {
    background: white;
    border-radius: 12px;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
    animation: dlotsPopupIn 0.2s ease;
}

@keyframes dlotsPopupIn {
    from { opacity: 0; transform: scale(0.97) translateY(8px); }
    to   { opacity: 1; transform: scale(1)    translateY(0);   }
}

.dlots-popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    background: $dl-primary;
    color: white;
    flex: 0 0 auto;
}

.dlots-popup-title {
    font-size: 15px;
    font-weight: 700;
    display: flex;
    align-items: center;
    i { font-size: 16px; }
}

.dlots-popup-subtitle {
    font-size: 13px;
    font-weight: 400;
    opacity: 0.85;
    margin-left: 4px;
}

.dlots-popup-header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
}

.dlots-badge-selected {
    background: rgba(255, 255, 255, 0.2);
    color: white;
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 4px;
}

.dlots-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 7px 14px;
    border-radius: $dl-radius-sm;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    border: none;

    i { font-size: 11px; }

    &.dlots-btn-accent {
        background: $dl-accent;
        color: #1a202c;
        &:hover { background: darken(#68d391, 8%); }
    }

    &.dlots-btn-ghost {
        background: rgba(255,255,255,0.15);
        color: white;
        border: 1px solid rgba(255,255,255,0.3);
        &:hover { background: rgba(255,255,255,0.25); }
    }

    &.dlots-btn-outline {
        background: white;
        color: $dl-muted;
        border: 1.5px solid $dl-border;
        &:hover { background: $dl-bg; color: $dl-text; }
    }

    &.dlots-btn-primary-dark {
        background: $dl-primary;
        color: white;
        &:hover { background: $dl-primary-light; }
    }
}

.dlots-popup-filters {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    padding: 10px 16px;
    background: $dl-bg;
    border-bottom: 1px solid $dl-border;
    flex: 0 0 auto;
    flex-wrap: wrap;
}

.dlots-filter-group {
    display: flex;
    flex-direction: column;
    gap: 3px;

    label {
        font-size: 9.5px;
        font-weight: 700;
        text-transform: uppercase;
        color: $dl-muted;
        letter-spacing: 0.03em;
    }
}

.dlots-filter-input {
    padding: 5px 8px;
    border: 1.5px solid $dl-border;
    border-radius: $dl-radius-sm;
    font-size: 12px;
    width: 130px;
    color: $dl-text;
    transition: border-color 0.15s;
    background: white;

    &.dlots-filter-sm { width: 70px; }

    &:focus {
        outline: none;
        border-color: $dl-primary-light;
        box-shadow: 0 0 0 2px rgba($dl-primary-light, 0.2);
    }

    &::placeholder { color: #a0aec0; }
}

.dlots-filter-spacer { flex: 1; }

.dlots-filter-stats {
    display: flex;
    align-items: center;
    padding-bottom: 2px;
}

.dlots-filter-stat-loading,
.dlots-filter-stat-count {
    font-size: 11.5px;
    color: $dl-muted;
    display: flex;
    align-items: center;
    gap: 4px;
}

.dlots-filter-stat-count {
    color: $dl-primary;
    font-weight: 600;
}

.dlots-popup-body {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: auto;
    min-height: 0;
    background: white;

    &::-webkit-scrollbar { width: 8px; height: 8px; }
    &::-webkit-scrollbar-thumb { background: #cbd5e0; border-radius: 4px; }
    &::-webkit-scrollbar-track { background: #f7fafc; }
}

.dlots-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 60%;
    min-height: 250px;
    color: #a0aec0;
    gap: 12px;

    i { font-size: 40px; }
}

.dlots-empty-text {
    font-size: 14px;
    color: $dl-muted;
}

.dlots-popup-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 12px;

    thead {
        position: sticky;
        top: 0;
        z-index: 10;

        tr { background: $dl-bg; }

        th {
            padding: 9px 10px;
            text-align: left;
            font-size: 10.5px;
            font-weight: 700;
            text-transform: uppercase;
            color: $dl-muted;
            letter-spacing: 0.04em;
            border-bottom: 2px solid $dl-border;
            white-space: nowrap;
            background: $dl-bg;

            &.col-chk { width: 44px; text-align: center; }
            &.col-num { text-align: right; width: 60px; }
        }
    }

    tbody tr {
        cursor: pointer;
        transition: background 0.08s;

        &:hover { background: #f0f7ff; }

        &.row-sel {
            background: #ebfaf1;
            &:hover { background: #d4f4e0; }
            td:first-child { border-left: 3px solid $dl-accent; }
        }

        td {
            padding: 8px 10px;
            border-bottom: 1px solid #f0f4f8;
            vertical-align: middle;
            color: $dl-text;

            &.col-chk { text-align: center; width: 44px; }
            &.col-num { text-align: right; font-variant-numeric: tabular-nums; }

            &.cell-lot {
                font-family: 'Courier New', monospace;
                font-size: 11.5px;
                font-weight: 700;
                color: $dl-primary;
            }

            &.cell-loc { color: $dl-muted; font-size: 11px; }
        }
    }
}

.dlots-chkbox {
    width: 18px;
    height: 18px;
    border: 2px solid #cbd5e0;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto;
    transition: all 0.12s;
    background: white;

    i { font-size: 10px; color: white; }

    &.checked {
        background: $dl-accent;
        border-color: darken(#68d391, 10%);
    }
}

.dlots-tag {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;

    &.dlots-tag-ok   { background: #c6f6d5; color: #276749; }
    &.dlots-tag-warn { background: #fefcbf; color: #744210; }
    &.dlots-tag-free { background: #edf2f7; color: #718096; border: 1px solid #e2e8f0; }
}

.dlots-scroll-sentinel { padding: 16px; text-align: center; }

.dlots-loading-more {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: $dl-muted;
    font-size: 12px;
    padding: 8px;
}

.dlots-scroll-hint {
    color: #a0aec0;
    font-size: 11px;
    animation: dlotsHintBounce 2s infinite;
}

@keyframes dlotsHintBounce {
    0%, 100% { opacity: 0.5; transform: translateY(0); }
    50%       { opacity: 1;   transform: translateY(3px); }
}

.dlots-popup-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: $dl-bg;
    border-top: 1px solid $dl-border;
    flex: 0 0 auto;
}

.dlots-footer-info {
    font-size: 12px;
    color: $dl-muted;
}

.dlots-footer-actions {
    display: flex;
    gap: 8px;
    align-items: center;
}

// ═══════════════════════════════════════════════════════════════════════════
// ESTILOS ADICIONALES: Agregar al final de delivery_lots_styles.scss
// ═══════════════════════════════════════════════════════════════════════════

// Botones Seleccionar todo / Borrar selección en filtros del popup
.dlots-filter-actions {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding-bottom: 1px;
}

.dlots-btn-select-all,
.dlots-btn-clear-all {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    border: 1.5px solid;
    white-space: nowrap;

    i { font-size: 11px; }
}

.dlots-btn-select-all {
    background: #ebf8ff;
    color: #2c5282;
    border-color: #bee3f8;

    &:hover {
        background: #2c5282;
        color: white;
        border-color: #2c5282;
    }
}

.dlots-btn-clear-all {
    background: #fff5f5;
    color: #c53030;
    border-color: #fed7d7;

    &:hover {
        background: #c53030;
        color: white;
        border-color: #c53030;
    }
}```

## ./views/stock_picking_views.xml
```xml
<?xml version="1.0" encoding="utf-8"?>
<odoo>
    <record id="view_picking_form_delivery_lots" model="ir.ui.view">
        <field name="name">stock.picking.form.delivery.lots</field>
        <field name="model">stock.picking</field>
        <field name="inherit_id" ref="stock.view_picking_form"/>
        <field name="arch" type="xml">

            <xpath expr="//field[@name='move_ids']/list/field[@name='product_id']" position="before">
                <field
                    name="is_dlots_expanded"
                    widget="delivery_lots_button"
                    string=" "
                    nolabel="1"
                    class="p-0 text-center"
                />
            </xpath>

            <!-- Columna Solicitud Original después de quantity -->
            <xpath expr="//field[@name='move_ids']/list/field[@name='quantity']" position="after">
                <field
                    name="x_original_demand"
                    string="Solicitud Original"
                    readonly="1"
                    optional="show"
                />
            </xpath>

        </field>
    </record>
</odoo>```

