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

    /**
     * Actualización suave: sincroniza la cantidad en el record local
     * sin hacer un reload completo del modelo (evita cerrar la UI).
     */
    async _softSyncQuantity() {
        const moveId = this.getMoveId();
        if (!moveId) return;
        try {
            // 1. Sincronizar en servidor
            await this.orm.call("stock.move", "action_update_quantity_from_lines", [moveId]);

            // 2. Leer la cantidad actualizada del servidor
            const moveData = await this.orm.read("stock.move", [moveId], ["quantity", "product_uom_qty"]);
            if (!moveData.length) return;

            const newQty = moveData[0].quantity ?? moveData[0].product_uom_qty ?? 0;

            // 3. Actualizar visualmente la celda de cantidad en la fila del move
            //    sin recargar el modelo completo
            this._updateQuantityInDOM(newQty);

            // 4. Si el record OWL tiene update, intentar parchear localmente
            this._patchRecordQuantity(newQty);

        } catch (e) {
            console.warn("[DLOTS] Error en _softSyncQuantity:", e);
        }
    }

    /**
     * Busca la celda de cantidad en la misma fila <tr> del botón
     * y actualiza su texto directamente en el DOM.
     */
    _updateQuantityInDOM(newQty) {
        try {
            // Encontrar la fila <tr> que contiene este widget
            const btnEl = this.__owl__?.bdom?.el || this.el;
            if (!btnEl) return;
            const row = btnEl.closest?.("tr");
            if (!row) return;

            // Buscar la celda del campo quantity o product_uom_qty
            // Odoo usa el atributo name en el <td> o data-field
            const qtyCell = row.querySelector('td[name="quantity"] .o_field_widget, td[name="product_uom_qty"] .o_field_widget')
                || row.querySelector('td.o_data_cell .o_field_float, td.o_data_cell .o_field_number');

            if (qtyCell) {
                // Buscar el span o input dentro del widget
                const span = qtyCell.querySelector('span, .o_field_float_toggle, .o_input');
                if (span) {
                    span.textContent = newQty.toFixed(2);
                }
            }

            // Enfoque alternativo: buscar por data-tooltip-info o por contenido
            // en caso de que la estructura DOM sea diferente
            row.querySelectorAll('td.o_data_cell').forEach((td) => {
                const field = td.getAttribute('name');
                if (field === 'quantity' || field === 'product_uom_qty') {
                    const inner = td.querySelector('.o_field_widget span') || td.querySelector('span');
                    if (inner) {
                        inner.textContent = newQty.toFixed(2);
                    }
                }
            });
        } catch (e) {
            console.warn("[DLOTS] _updateQuantityInDOM falló (no crítico):", e);
        }
    }

    /**
     * Intenta parchear el valor en el record OWL para mantener consistencia
     * sin disparar un reload completo.
     */
    _patchRecordQuantity(newQty) {
        try {
            const record = this.props.record;
            if (!record) return;

            // Intentar actualizar via record.update (OWL record)
            if (record.data) {
                if ('quantity' in record.data) {
                    record.data.quantity = newQty;
                }
                if ('product_uom_qty' in record.data) {
                    record.data.product_uom_qty = newQty;
                }
            }
        } catch (e) {
            console.warn("[DLOTS] _patchRecordQuantity falló (no crítico):", e);
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

    /**
     * Elimina un lote con animación suave:
     * - Anima la fila saliendo
     * - Elimina la move line en servidor
     * - Actualiza totales in-place sin recargar nada
     */
    async removeLot(lotId) {
        const moveId = this.getMoveId();
        if (!moveId) return;

        // 1. Animación de salida de la fila
        const row = this._detailsRow?.querySelector(`tr[data-lot-row="${lotId}"]`);
        let removedQty = 0;
        if (row) {
            // Capturar la cantidad de esta fila antes de animarla
            const qtyCells = row.querySelectorAll("td.col-num.fw-semibold");
            if (qtyCells.length) {
                removedQty = parseFloat(qtyCells[0].textContent) || 0;
            }
            row.style.transition = "opacity 0.25s ease, transform 0.25s ease";
            row.style.opacity = "0";
            row.style.transform = "translateX(-20px)";
        }

        try {
            // 2. Eliminar en servidor (en paralelo con la animación)
            const lines = await this.orm.searchRead(
                "stock.move.line",
                [["move_id", "=", moveId], ["lot_id", "=", lotId]],
                ["id"]
            );
            if (lines.length) {
                await this.orm.unlink("stock.move.line", lines.map((l) => l.id));
            }

            // 3. Quitar la fila del DOM después de la animación
            if (row) {
                await new Promise((r) => setTimeout(r, 260));
                row.remove();
            }

            // 4. Actualizar totales inline (sin re-render completo)
            this._updateSelectedTotals(removedQty);

            // 5. Sincronizar cantidad del move en servidor y actualizar DOM
            await this._softSyncQuantity();

            // 6. Actualizar el badge del botón
            await this._refreshCount();

            // 7. Si ya no hay filas, mostrar el mensaje vacío
            const tbody = this._detailsRow?.querySelector(".dlots-sel-table tbody");
            if (tbody && tbody.children.length === 0) {
                const body = this._detailsRow.querySelector(".dlots-selected-body");
                if (body) {
                    body.innerHTML = `
                        <div class="dlots-no-selection">
                            <i class="fa fa-info-circle me-2 text-muted"></i>
                            <span class="text-muted">Sin placas asignadas. Usa <strong>Agregar placa</strong> para comenzar.</span>
                        </div>`;
                }
            }
        } catch (err) {
            console.error("[DLOTS] Error eliminando lote:", err);
            // Si falló, re-renderizar la tabla para estado consistente
            await this.refreshSelectedTable();
        }
    }

    /**
     * Actualiza los totales de la tabla seleccionada in-place
     * sin reconstruir toda la tabla.
     */
    _updateSelectedTotals(removedQty) {
        if (!this._detailsRow) return;

        // Actualizar conteo en el footer
        const countEl = this._detailsRow.querySelector(".dlots-total-count");
        const qtyEl = this._detailsRow.querySelector(".dlots-total-qty");
        const badge = this._detailsRow.querySelector(".dlots-sel-badge");

        const tbody = this._detailsRow.querySelector(".dlots-sel-table tbody");
        const newCount = tbody ? tbody.children.length : 0;

        if (countEl) countEl.textContent = newCount;
        if (badge) badge.textContent = newCount;

        if (qtyEl && removedQty > 0) {
            const currentTotal = parseFloat(qtyEl.textContent) || 0;
            const newTotal = Math.max(0, currentTotal - removedQty);
            qtyEl.textContent = newTotal.toFixed(2);
        }

        // Actualizar texto del footer (singular/plural)
        const footerTd = this._detailsRow.querySelector(".dlots-total-row td:first-child");
        if (footerTd) {
            footerTd.innerHTML = `Total (<span class="dlots-total-count">${newCount}</span> placa${newCount !== 1 ? "s" : ""}):`;
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
        const locationId = this.getLocationId();
        const locationDestId = this.getLocationDestId();

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
                    <tr class="${sel ? "row-sel" : ""}" data-lot-id="${lotId}">
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
                        tag.className = sel ? "dlots-tag dlots-tag-ok" : "dlots-tag dlots-tag-free";
                        tag.textContent = sel ? "Selec." : "Libre";
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
                const currentLines = await this.orm.searchRead(
                    "stock.move.line",
                    [["move_id", "=", moveId]],
                    ["id", "lot_id"]
                );
                const currentLotMap = {};
                for (const l of currentLines) {
                    if (l.lot_id) currentLotMap[l.lot_id[0]] = l.id;
                }
                const currentLotIds = new Set(Object.keys(currentLotMap).map(Number));

                const toAdd = [...state.pendingIds].filter((id) => !currentLotIds.has(id));
                const toRemove = [...currentLotIds].filter((id) => !state.pendingIds.has(id));

                if (toRemove.length) {
                    const idsToUnlink = toRemove.map((lotId) => currentLotMap[lotId]);
                    await this.orm.unlink("stock.move.line", idsToUnlink);
                }

                for (const lotId of toAdd) {
                    let qty = 0;
                    let srcLocId = locationId;
                    try {
                        const quants = await this.orm.searchRead(
                            "stock.quant",
                            [
                                ["lot_id", "=", lotId],
                                ["product_id", "=", productId],
                                ["location_id.usage", "=", "internal"],
                                ["quantity", ">", 0],
                            ],
                            ["quantity", "location_id"],
                            { limit: 1 }
                        );
                        if (quants.length) {
                            qty = quants[0].quantity;
                            srcLocId = quants[0].location_id[0];
                        }
                    } catch (_e) {}

                    await this.orm.create("stock.move.line", [{
                        move_id: moveId,
                        lot_id: lotId,
                        quantity: qty,
                        product_id: productId,
                        location_id: srcLocId || locationId,
                        location_dest_id: locationDestId,
                    }]);
                }

                // Sincronizar cantidad del move suavemente
                await this._softSyncQuantity();
                await this._refreshCount();
                await this.refreshSelectedTable();

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
});