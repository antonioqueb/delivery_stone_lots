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

    // ─────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────

    _escapeHtml(value) {
        const raw = value === null || value === undefined ? "" : String(value);
        return raw
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    _fmt(num) {
        const value = parseFloat(num);
        if (Number.isNaN(value)) return "0.00";
        return value.toFixed(2);
    }

    _fmtDim(num) {
        const value = parseFloat(num);
        if (!value || Number.isNaN(value)) return "-";
        return value % 1 === 0 ? value.toFixed(0) : value.toFixed(2);
    }

    _tipoLabel(tipo) {
        const clean = (tipo || "placa").toLowerCase();
        return clean.charAt(0).toUpperCase() + clean.slice(1);
    }

    _qtyLabel(tipo) {
        return (tipo || "").toLowerCase() === "pieza" ? "pzas" : "m²";
    }

    _isPartialType(tipo) {
        const clean = (tipo || "placa").toLowerCase();
        return clean === "formato" || clean === "pieza";
    }

    getMoveId(props = this.props) {
        const record = props?.record;
        if (!record) return null;

        if (record.resId && record.resId > 0) return record.resId;

        const dataId = record.data?.id;
        if (dataId && typeof dataId === "number" && dataId > 0) return dataId;

        if (record.id && typeof record.id === "number" && record.id > 0) return record.id;

        return null;
    }

    getProductId(props = this.props) {
        const product = props?.record?.data?.product_id;
        if (!product) return null;
        if (Array.isArray(product)) return product[0];
        if (typeof product === "number") return product;
        if (product?.id) return product.id;
        return null;
    }

    getProductName(props = this.props) {
        const product = props?.record?.data?.product_id;
        if (!product) return "";
        if (Array.isArray(product)) return product[1] || "";
        return product?.display_name || product?.name || "";
    }

    async _syncOdooState() {
        try {
            const wasExpanded = this.state.isExpanded;

            if (this.props.record?.model?.root) {
                await this.props.record.model.root.load();
            }

            await this._refreshCount();

            if (wasExpanded) {
                await this.refreshSelectedTable();
            }
        } catch (error) {
            console.warn("[DLOTS] Error sincronizando estado Odoo:", error);
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
                { limit: 500 }
            );

            const uniqueLots = new Set(lines.map((line) => line.lot_id?.[0]).filter(Boolean));
            this.state.lotCount = uniqueLots.size;
        } catch (error) {
            console.error("[DLOTS] Error _refreshCount:", error);
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

            for (const line of lines) {
                const lotId = line.lot_id?.[0];
                if (!lotId) continue;

                if (!map[lotId]) {
                    map[lotId] = {
                        lotId,
                        lotName: line.lot_id?.[1] || "",
                        qty: 0,
                        locationName: line.location_id?.[1] || "",
                    };
                }

                map[lotId].qty += line.quantity || 0;
            }

            return Object.values(map);
        } catch (error) {
            console.error("[DLOTS] Error _loadCurrentLotData:", error);
            return [];
        }
    }

    async _getCurrentLotIds() {
        const data = await this._loadCurrentLotData();
        return data.map((item) => item.lotId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Toggle principal
    // ─────────────────────────────────────────────────────────────────────

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
            alert("Guarda el albarán antes de gestionar las placas.");
            return;
        }

        document.querySelectorAll(".dlots-selected-row").forEach((row) => row.remove());
        document.querySelectorAll(".stone-selected-row").forEach((row) => row.remove());

        const tr = ev.currentTarget.closest("tr");
        if (!tr) return;

        this.state.isExpanded = true;
        await this.injectSelectedTable(tr);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Tabla inline de placas asignadas
    // ─────────────────────────────────────────────────────────────────────

    async injectSelectedTable(currentRow) {
        const newTr = document.createElement("tr");
        newTr.className = "dlots-selected-row";

        const colCount = currentRow.querySelectorAll("td").length || 10;

        const td = document.createElement("td");
        td.colSpan = colCount;
        td.className = "dlots-selected-cell";

        const container = document.createElement("div");
        container.className = "dlots-selected-container";

        const currentLotIds = await this._getCurrentLotIds();

        const header = document.createElement("div");
        header.className = "dlots-selected-header";
        header.innerHTML = `
            <button class="dlots-add-btn dlots-add-btn-trigger dlots-add-btn-prominent">
                <i class="fa fa-plus me-1"></i>
                Agregar placas
            </button>
            <span class="dlots-selected-title">
                <i class="fa fa-check-circle me-2"></i>
                Placas asignadas
                <span class="dlots-sel-badge" id="dlots-sel-badge">${currentLotIds.length}</span>
            </span>
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

        header.querySelector(".dlots-add-btn-trigger").addEventListener("click", (event) => {
            event.stopPropagation();
            event.preventDefault();
            this.openPopup();
        });
    }

    async renderSelectedTable(container) {
        container.innerHTML = `
            <div class="dlots-table-loading">
                <i class="fa fa-circle-o-notch fa-spin me-2"></i>
                Cargando placas asignadas...
            </div>
        `;

        const moveLineData = await this._loadCurrentLotData();

        if (!moveLineData.length) {
            container.innerHTML = `
                <div class="dlots-no-selection">
                    <i class="fa fa-info-circle me-2 text-muted"></i>
                    <span class="text-muted">
                        Sin placas asignadas. Usa <strong>Agregar placas</strong> para comenzar.
                    </span>
                </div>
            `;
            return;
        }

        try {
            const lotIds = moveLineData.map((item) => item.lotId);

            const [lotsData, quantsData] = await Promise.all([
                this.orm.searchRead(
                    "stock.lot",
                    [["id", "in", lotIds]],
                    [
                        "name",
                        "x_bloque",
                        "x_atado",
                        "x_grupo",
                        "x_alto",
                        "x_ancho",
                        "x_grosor",
                        "x_tipo",
                        "x_color",
                        "x_pedimento",
                        "x_contenedor",
                        "x_detalles_placa",
                    ],
                    { limit: lotIds.length }
                ),
                this.orm.searchRead(
                    "stock.quant",
                    [["lot_id", "in", lotIds], ["location_id.usage", "=", "internal"], ["quantity", ">", 0]],
                    ["lot_id", "quantity"],
                    { limit: lotIds.length * 3 }
                ),
            ]);

            const lotMap = Object.fromEntries(lotsData.map((lot) => [lot.id, lot]));

            const qtyMap = {};
            const locMap = {};
            for (const item of moveLineData) {
                qtyMap[item.lotId] = item.qty;
                locMap[item.lotId] = item.locationName;
            }

            const availQtyMap = {};
            for (const quant of quantsData) {
                const lotId = quant.lot_id?.[0];
                if (!lotId) continue;
                availQtyMap[lotId] = (availQtyMap[lotId] || 0) + (quant.quantity || 0);
            }

            let totalQty = 0;
            let rows = "";

            for (const lotId of lotIds) {
                const lot = lotMap[lotId];
                if (!lot) continue;

                const assignedQty = qtyMap[lotId] || 0;
                const availableQty = Math.max(availQtyMap[lotId] || 0, assignedQty);
                const locationName = (locMap[lotId] || "").split("/").pop();
                const tipo = (lot.x_tipo || "placa").toLowerCase();
                const isPartial = this._isPartialType(tipo);
                const qtyLabel = this._qtyLabel(tipo);
                const inputStep = tipo === "pieza" ? "1" : "0.01";

                totalQty += assignedQty;

                let qtyCell = "";
                if (isPartial) {
                    qtyCell = `
                        <input type="number"
                               class="dlots-qty-input"
                               data-lot-id="${lotId}"
                               data-max="${availableQty}"
                               step="${inputStep}"
                               min="0"
                               max="${availableQty}"
                               value="${assignedQty}" />
                        <span class="dlots-qty-avail text-muted">/ ${this._fmt(availableQty)} ${qtyLabel}</span>
                    `;
                } else {
                    qtyCell = `<span class="fw-semibold">${this._fmt(assignedQty)} ${qtyLabel}</span>`;
                }

                const noteCell = lot.x_detalles_placa
                    ? `<i class="fa fa-exclamation-triangle text-warning" title="${this._escapeHtml(lot.x_detalles_placa)}"></i>`
                    : `<span class="text-muted">—</span>`;

                rows += `
                    <tr data-lot-row="${lotId}">
                        <td class="cell-lot">${this._escapeHtml(lot.name)}</td>
                        <td>${this._escapeHtml(lot.x_bloque || "—")}</td>
                        <td>${this._escapeHtml(lot.x_atado || "—")}</td>
                        <td>${this._escapeHtml(lot.x_grupo || "—")}</td>
                        <td class="col-num">${this._fmtDim(lot.x_alto)}</td>
                        <td class="col-num">${this._fmtDim(lot.x_ancho)}</td>
                        <td class="col-num">${this._fmtDim(lot.x_grosor)}</td>
                        <td>
                            <span class="dlots-tag dlots-tag-tipo-${this._escapeHtml(tipo)}">
                                ${this._escapeHtml(this._tipoLabel(tipo))}
                            </span>
                        </td>
                        <td class="col-num col-qty-inline">${qtyCell}</td>
                        <td>${this._escapeHtml(lot.x_color || "—")}</td>
                        <td class="text-muted">${this._escapeHtml(locationName || "—")}</td>
                        <td class="text-muted dlots-font-mono">${this._escapeHtml(lot.x_pedimento || "—")}</td>
                        <td class="text-center">${noteCell}</td>
                        <td class="col-act">
                            <button class="dlots-remove-btn" data-lot-id="${lotId}" title="Quitar placa">
                                <i class="fa fa-times"></i>
                            </button>
                        </td>
                    </tr>
                `;
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
                            <th>Tipo</th>
                            <th class="col-num col-qty-inline">Cantidad</th>
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
                            <td colspan="8" class="text-end fw-bold text-muted">
                                Total (<span class="dlots-total-count">${lotIds.length}</span> placa${lotIds.length !== 1 ? "s" : ""}):
                            </td>
                            <td class="col-num fw-bold dlots-total-qty">${this._fmt(totalQty)}</td>
                            <td colspan="5"></td>
                        </tr>
                    </tfoot>
                </table>
            `;

            container.querySelectorAll(".dlots-remove-btn").forEach((btn) => {
                btn.addEventListener("click", async (event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    await this.removeLot(parseInt(btn.dataset.lotId, 10));
                });
            });

            container.querySelectorAll(".dlots-qty-input").forEach((input) => {
                let debounceTimer = null;

                const save = () => {
                    if (debounceTimer) clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        this._onInlineQtyChange(input);
                    }, 500);
                };

                input.addEventListener("input", save);
                input.addEventListener("blur", () => {
                    if (debounceTimer) clearTimeout(debounceTimer);
                    this._onInlineQtyChange(input);
                });
            });
        } catch (error) {
            console.error("[DLOTS] Error renderSelectedTable:", error);
            container.innerHTML = `
                <div class="text-danger p-2">
                    <i class="fa fa-exclamation-triangle me-2"></i>
                    Error: ${this._escapeHtml(error.message)}
                </div>
            `;
        }
    }

    async _onInlineQtyChange(input) {
        const lotId = parseInt(input.dataset.lotId, 10);
        const maxQty = parseFloat(input.dataset.max) || 0;

        let value = parseFloat(input.value) || 0;
        if (value < 0) value = 0;
        if (maxQty > 0 && value > maxQty) value = maxQty;

        input.value = value;

        const moveId = this.getMoveId();
        if (!moveId) return;

        const currentData = await this._loadCurrentLotData();
        const allLotIds = currentData.map((item) => item.lotId);

        const breakdown = {};
        breakdown[String(lotId)] = value;

        try {
            await this.orm.call("stock.move", "action_set_delivery_lots", [moveId, allLotIds, breakdown]);
            this._recalcInlineTotal();
            await this._refreshCount();
        } catch (error) {
            console.error("[DLOTS] Error guardando cantidad parcial:", error);
        }
    }

    _recalcInlineTotal() {
        if (!this._detailsRow) return;

        const totalEl = this._detailsRow.querySelector(".dlots-total-qty");
        if (!totalEl) return;

        let total = 0;

        this._detailsRow.querySelectorAll(".dlots-qty-input").forEach((input) => {
            total += parseFloat(input.value) || 0;
        });

        this._detailsRow.querySelectorAll("td.col-qty-inline .fw-semibold").forEach((span) => {
            const match = span.textContent.match(/([\d.]+)/);
            if (match) total += parseFloat(match[1]) || 0;
        });

        totalEl.textContent = this._fmt(total);
    }

    async removeLot(lotId) {
        const moveId = this.getMoveId();
        if (!moveId) return;

        const row = this._detailsRow?.querySelector(`tr[data-lot-row="${lotId}"]`);

        if (row) {
            row.style.transition = "opacity 0.22s ease, transform 0.22s ease";
            row.style.opacity = "0";
            row.style.transform = "translateX(-16px)";
        }

        try {
            const currentIds = await this._getCurrentLotIds();
            const newIds = currentIds.filter((id) => id !== lotId);

            await this.orm.call("stock.move", "action_set_delivery_lots", [moveId, newIds]);

            if (row) {
                await new Promise((resolve) => setTimeout(resolve, 240));
                row.remove();
            }

            await this._syncOdooState();
        } catch (error) {
            console.error("[DLOTS] Error eliminando placa:", error);
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

    // ─────────────────────────────────────────────────────────────────────
    // Popup fullscreen
    // ─────────────────────────────────────────────────────────────────────

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

        const currentLotData = await this._loadCurrentLotData();
        const currentLotIds = currentLotData.map((item) => item.lotId);

        const currentQtyMap = {};
        for (const item of currentLotData) {
            currentQtyMap[String(item.lotId)] = item.qty;
        }

        const state = {
            quants: [],
            totalCount: 0,
            hasMore: false,
            isLoading: false,
            isLoadingMore: false,
            page: 0,
            pendingIds: new Set(currentLotIds),
            pendingBreakdown: { ...currentQtyMap },
            pendingQtyMap: { ...currentQtyMap },
            pendingTypeMap: {},
            filters: {
                lot_name: "",
                bloque: "",
                atado: "",
                alto_min: "",
                ancho_min: "",
                tipo: "",
            },
        };

        let searchTimeout = null;

        root.innerHTML = `
            <div class="dlots-popup-overlay" id="dlots-overlay">
                <div class="dlots-popup-container">

                    <div class="dlots-popup-header">
                        <div class="dlots-popup-title">
                            <i class="fa fa-th me-2"></i>
                            Placas disponibles para entrega
                            <span class="dlots-popup-subtitle">
                                ${this.getProductName() ? "— " + this._escapeHtml(this.getProductName()) : ""}
                            </span>
                        </div>

                        <div class="dlots-popup-header-actions">
                            <span class="dlots-badge-selected">
                                <i class="fa fa-check-circle me-1"></i>
                                <span id="dp-badge-count">${state.pendingIds.size}</span> seleccionadas
                            </span>

                            <span class="dlots-badge-qty-total">
                                <i class="fa fa-balance-scale me-1"></i>
                                <span id="dp-badge-qty">0.00</span>
                                <span id="dp-badge-unit">m²</span>
                            </span>

                            <button class="dlots-btn dlots-btn-accent" id="dp-confirm-top">
                                <i class="fa fa-check me-1"></i>
                                Confirmar
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
                            <input type="number" class="dlots-filter-input dlots-filter-sm" id="df-alto" placeholder="0" step="0.01"/>
                        </div>

                        <div class="dlots-filter-group">
                            <label>Ancho mín.</label>
                            <input type="number" class="dlots-filter-input dlots-filter-sm" id="df-ancho" placeholder="0" step="0.01"/>
                        </div>

                        <div class="dlots-filter-group">
                            <label>Tipo</label>
                            <select class="dlots-filter-input" id="df-tipo">
                                <option value="">Todos</option>
                                <option value="placa">Placa</option>
                                <option value="formato">Formato</option>
                                <option value="pieza">Pieza</option>
                            </select>
                        </div>

                        <div class="dlots-filter-actions">
                            <button class="dlots-btn dlots-btn-select-all" id="dp-select-all" title="Seleccionar todas las placas visibles">
                                <i class="fa fa-check-square-o me-1"></i>
                                Todo
                            </button>

                            <button class="dlots-btn dlots-btn-clear-all" id="dp-clear-all" title="Borrar toda la selección">
                                <i class="fa fa-square-o me-1"></i>
                                Limpiar
                            </button>
                        </div>

                        <div class="dlots-filter-spacer"></div>

                        <div class="dlots-filter-stats">
                            <span id="dp-stat" class="dlots-filter-stat-loading">
                                <i class="fa fa-circle-o-notch fa-spin me-1"></i>
                                Buscando...
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

                        <div class="dlots-footer-qty-summary" id="dp-footer-qty">
                            <span id="dp-footer-qty-text">0.00 m²</span>
                        </div>

                        <div class="dlots-footer-actions">
                            <button class="dlots-btn dlots-btn-outline" id="dp-cancel">
                                Cancelar
                            </button>

                            <button class="dlots-btn dlots-btn-primary-dark" id="dp-confirm-bottom">
                                <i class="fa fa-check me-1"></i>
                                Agregar selección
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
        const badgeQty = root.querySelector("#dp-badge-qty");
        const badgeUnit = root.querySelector("#dp-badge-unit");
        const footerQtyText = root.querySelector("#dp-footer-qty-text");

        const getQuantByLotId = (lotId) => {
            return state.quants.find((quant) => quant.lot_id && quant.lot_id[0] === lotId);
        };

        const getQtyForLot = (lotId) => {
            const lotIdStr = String(lotId);
            const quant = getQuantByLotId(lotId);
            const tipo = (quant?.x_tipo || state.pendingTypeMap[lotIdStr] || "placa").toLowerCase();

            if (this._isPartialType(tipo) && state.pendingBreakdown[lotIdStr] !== undefined) {
                return parseFloat(state.pendingBreakdown[lotIdStr]) || 0;
            }

            if (state.pendingQtyMap[lotIdStr] !== undefined) {
                return parseFloat(state.pendingQtyMap[lotIdStr]) || 0;
            }

            return quant ? quant.quantity || 0 : 0;
        };

        const computeSelectedTotals = () => {
            let totalM2 = 0;
            let totalPiezas = 0;
            let hasM2 = false;
            let hasPiezas = false;

            for (const lotId of state.pendingIds) {
                const lotIdStr = String(lotId);
                const quant = getQuantByLotId(lotId);
                const tipo = (quant?.x_tipo || state.pendingTypeMap[lotIdStr] || "placa").toLowerCase();
                const qty = getQtyForLot(lotId);

                if (tipo === "pieza") {
                    totalPiezas += qty;
                    hasPiezas = true;
                } else {
                    totalM2 += qty;
                    hasM2 = true;
                }
            }

            return { totalM2, totalPiezas, hasM2, hasPiezas };
        };

        const updateQtyDisplay = () => {
            const { totalM2, totalPiezas, hasM2, hasPiezas } = computeSelectedTotals();

            if (hasM2 && hasPiezas) {
                badgeQty.textContent = this._fmt(totalM2);
                badgeUnit.textContent = `m² + ${this._fmt(totalPiezas)} pzas`;
            } else if (hasPiezas && !hasM2) {
                badgeQty.textContent = this._fmt(totalPiezas);
                badgeUnit.textContent = "pzas";
            } else {
                badgeQty.textContent = this._fmt(totalM2);
                badgeUnit.textContent = "m²";
            }

            const parts = [];
            if (hasM2) parts.push(`${this._fmt(totalM2)} m²`);
            if (hasPiezas) parts.push(`${this._fmt(totalPiezas)} pzas`);

            footerQtyText.textContent = parts.length ? parts.join(" + ") : "0.00 m²";
        };

        const updateBadge = () => {
            badgeCount.textContent = state.pendingIds.size;
            updateQtyDisplay();
        };

        const updateStats = () => {
            stat.className = "dlots-filter-stat-count";
            stat.innerHTML = `${state.totalCount} placas`;
            footerInfo.innerHTML = `Mostrando <strong>${state.quants.length}</strong> de <strong>${state.totalCount}</strong>`;
        };

        const rememberQuant = (quant) => {
            const lotId = quant.lot_id ? quant.lot_id[0] : 0;
            if (!lotId) return;

            const lotIdStr = String(lotId);
            const tipo = (quant.x_tipo || "placa").toLowerCase();

            state.pendingTypeMap[lotIdStr] = tipo;

            if (this._isPartialType(tipo)) {
                if (state.pendingBreakdown[lotIdStr] === undefined) {
                    state.pendingBreakdown[lotIdStr] = quant.quantity || 0;
                }
                state.pendingQtyMap[lotIdStr] = parseFloat(state.pendingBreakdown[lotIdStr]) || 0;
            } else {
                state.pendingQtyMap[lotIdStr] = quant.quantity || 0;
            }
        };

        const doSelectAll = () => {
            for (const quant of state.quants) {
                const lotId = quant.lot_id ? quant.lot_id[0] : 0;
                if (!lotId) continue;
                state.pendingIds.add(lotId);
                rememberQuant(quant);
            }

            updateBadge();
            renderTable();
        };

        const doClearAll = () => {
            state.pendingIds.clear();
            state.pendingBreakdown = {};
            state.pendingQtyMap = {};
            updateBadge();
            renderTable();
        };

        const renderTable = () => {
            if (state.quants.length === 0 && !state.isLoading) {
                body.innerHTML = `
                    <div class="dlots-empty-state">
                        <i class="fa fa-inbox fa-3x text-muted"></i>
                        <div class="dlots-empty-text mt-2">No hay placas con estos filtros</div>
                    </div>
                `;
                updateStats();
                updateBadge();
                return;
            }

            let rows = "";

            for (const quant of state.quants) {
                const lotId = quant.lot_id ? quant.lot_id[0] : 0;
                const lotName = quant.lot_id ? quant.lot_id[1] : "—";
                const locationName = quant.location_id ? quant.location_id[1].split("/").pop() : "—";
                const selected = state.pendingIds.has(lotId);
                const reserved = quant.reserved_quantity > 0;
                const tipo = (quant.x_tipo || "placa").toLowerCase();
                const isPartial = this._isPartialType(tipo);
                const lotIdStr = String(lotId);
                const qtyLabel = this._qtyLabel(tipo);
                const inputStep = tipo === "pieza" ? "1" : "0.01";

                state.pendingTypeMap[lotIdStr] = tipo;

                let statusBadge = "";
                if (selected) {
                    statusBadge = `<span class="dlots-tag dlots-tag-ok">Selec.</span>`;
                } else if (reserved) {
                    statusBadge = `<span class="dlots-tag dlots-tag-warn">Reservado</span>`;
                } else {
                    statusBadge = `<span class="dlots-tag dlots-tag-free">Libre</span>`;
                }

                let qtyCell = "";
                if (isPartial && selected) {
                    const currentValue = state.pendingBreakdown[lotIdStr] !== undefined
                        ? state.pendingBreakdown[lotIdStr]
                        : quant.quantity || 0;

                    qtyCell = `
                        <input type="number"
                               class="dlots-popup-qty-input"
                               data-lot-id="${lotId}"
                               data-max="${quant.quantity || 0}"
                               step="${inputStep}"
                               min="0"
                               max="${quant.quantity || 0}"
                               value="${currentValue}" />
                    `;
                } else if (isPartial && !selected) {
                    qtyCell = `<span class="text-muted">—</span>`;
                } else {
                    qtyCell = `<span>${this._fmt(quant.quantity)} ${qtyLabel}</span>`;
                }

                rows += `
                    <tr class="${selected ? "row-sel" : ""}"
                        data-lot-id="${lotId}"
                        data-reserved="${reserved ? "1" : "0"}"
                        data-tipo="${this._escapeHtml(tipo)}">
                        <td class="col-chk">
                            <div class="dlots-chkbox ${selected ? "checked" : ""}">
                                ${selected ? '<i class="fa fa-check"></i>' : ""}
                            </div>
                        </td>
                        <td class="cell-lot">${this._escapeHtml(lotName)}</td>
                        <td>${this._escapeHtml(quant.x_bloque || "—")}</td>
                        <td>${this._escapeHtml(quant.x_atado || "—")}</td>
                        <td class="col-num">${this._fmtDim(quant.x_alto)}</td>
                        <td class="col-num">${this._fmtDim(quant.x_ancho)}</td>
                        <td class="col-num">${this._fmtDim(quant.x_grosor)}</td>
                        <td class="col-num fw-semibold">${this._fmt(quant.quantity)}</td>
                        <td>
                            <span class="dlots-tag dlots-tag-tipo-${this._escapeHtml(tipo)}">
                                ${this._escapeHtml(this._tipoLabel(tipo))}
                            </span>
                        </td>
                        <td class="col-num col-popup-qty">${qtyCell}</td>
                        <td>${this._escapeHtml(quant.x_color || "—")}</td>
                        <td class="cell-loc">${this._escapeHtml(locationName)}</td>
                        <td>${statusBadge}</td>
                    </tr>
                `;
            }

            const sentinel = `
                <div id="dp-sentinel" class="dlots-scroll-sentinel">
                    ${state.isLoadingMore
                        ? '<div class="dlots-loading-more"><i class="fa fa-circle-o-notch fa-spin me-2"></i> Cargando más...</div>'
                        : ""}
                    ${state.hasMore && !state.isLoadingMore
                        ? '<div class="dlots-scroll-hint"><i class="fa fa-chevron-down me-1"></i> Desplázate para cargar más</div>'
                        : ""}
                </div>
            `;

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
                            <th class="col-num">Esp.</th>
                            <th class="col-num">Disponible</th>
                            <th>Tipo</th>
                            <th class="col-num">A entregar</th>
                            <th>Color</th>
                            <th>Ubicación</th>
                            <th>Estado</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                ${sentinel}
            `;

            updateStats();
            updateBadge();

            body.querySelectorAll("tr[data-lot-id]").forEach((tr) => {
                tr.addEventListener("click", (event) => {
                    if (event.target.closest(".dlots-popup-qty-input")) return;

                    const lotId = parseInt(tr.dataset.lotId, 10);
                    if (!lotId) return;

                    const tipo = tr.dataset.tipo || "placa";
                    const quant = getQuantByLotId(lotId);

                    if (state.pendingIds.has(lotId)) {
                        state.pendingIds.delete(lotId);
                        delete state.pendingBreakdown[String(lotId)];
                        delete state.pendingQtyMap[String(lotId)];
                    } else {
                        state.pendingIds.add(lotId);
                        if (quant) {
                            rememberQuant(quant);
                        } else if (this._isPartialType(tipo)) {
                            state.pendingBreakdown[String(lotId)] = 0;
                            state.pendingQtyMap[String(lotId)] = 0;
                        }
                    }

                    updateBadge();
                    renderTable();
                });
            });

            body.querySelectorAll(".dlots-popup-qty-input").forEach((input) => {
                input.addEventListener("click", (event) => event.stopPropagation());

                input.addEventListener("input", () => {
                    const lotId = parseInt(input.dataset.lotId, 10);
                    const max = parseFloat(input.dataset.max) || 0;

                    let value = parseFloat(input.value) || 0;
                    if (value < 0) value = 0;
                    if (max > 0 && value > max) value = max;

                    input.value = value;

                    state.pendingBreakdown[String(lotId)] = value;
                    state.pendingQtyMap[String(lotId)] = value;

                    updateQtyDisplay();
                });
            });

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
                    </div>
                `;

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

                for (const quant of items) {
                    const lotId = quant.lot_id ? quant.lot_id[0] : 0;
                    if (lotId && state.pendingIds.has(lotId)) {
                        rememberQuant(quant);
                    }
                }
            } catch (error) {
                console.error("[DLOTS POPUP] Error:", error);
                body.innerHTML = `
                    <div class="dlots-empty-state">
                        <i class="fa fa-exclamation-triangle fa-2x text-danger"></i>
                        <div class="dlots-empty-text mt-2 text-danger">
                            Error: ${this._escapeHtml(error.message)}
                        </div>
                    </div>
                `;
                return;
            } finally {
                state.isLoading = false;
                state.isLoadingMore = false;
            }

            renderTable();
        };

        const doConfirm = async () => {
            this.destroyPopup();

            if (!moveId) return;

            try {
                const finalLotIds = Array.from(state.pendingIds);

                const cleanBreakdown = {};
                for (const [lotIdStr, qty] of Object.entries(state.pendingBreakdown)) {
                    if (state.pendingIds.has(parseInt(lotIdStr, 10))) {
                        cleanBreakdown[lotIdStr] = qty;
                    }
                }

                await this.orm.call(
                    "stock.move",
                    "action_set_delivery_lots",
                    [moveId, finalLotIds, cleanBreakdown]
                );

                await this._syncOdooState();
            } catch (error) {
                console.error("[DLOTS] Error confirmando selección:", error);
                alert(`Error al guardar: ${error.message}`);
            }
        };

        const doClose = () => this.destroyPopup();

        root.querySelector("#dp-close").addEventListener("click", doClose);
        root.querySelector("#dp-cancel").addEventListener("click", doClose);
        root.querySelector("#dp-confirm-top").addEventListener("click", doConfirm);
        root.querySelector("#dp-confirm-bottom").addEventListener("click", doConfirm);
        root.querySelector("#dp-select-all").addEventListener("click", doSelectAll);
        root.querySelector("#dp-clear-all").addEventListener("click", doClearAll);

        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) doClose();
        });

        const onKeyDown = (event) => {
            if (event.key === "Escape") doClose();
        };

        document.addEventListener("keydown", onKeyDown);
        this._popupKeyHandler = onKeyDown;

        const bindFilter = (id, key) => {
            const input = root.querySelector(`#${id}`);
            if (!input) return;

            const handler = (event) => {
                state.filters[key] = event.target.value;
                if (searchTimeout) clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => loadPage(0, true), 350);
            };

            input.addEventListener("input", handler);
            input.addEventListener("change", handler);
        };

        bindFilter("df-lot", "lot_name");
        bindFilter("df-bloque", "bloque");
        bindFilter("df-atado", "atado");
        bindFilter("df-alto", "alto_min");
        bindFilter("df-ancho", "ancho_min");
        bindFilter("df-tipo", "tipo");

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