/** @odoo-module */
/**
 * delivery_lots_button.js
 *
 * Widget para visualizar los lotes (placas) asignados a cada movimiento
 * directamente en el albarán de entrega.
 *
 * Estrategia (igual que StoneExpandButton en sale_stone_selection):
 *  - Componente OWL mínimo: solo renderiza el botón toggle.
 *  - Al hacer clic → inyecta un <tr> con DOM puro bajo la fila actual.
 *  - Lee move_line_ids del record (stock.move) para obtener lotes y cantidades.
 *  - Una sola llamada ORM a stock.lot para enriquecer con campos x_.
 *  - Solo lectura: no modifica nada.
 */
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

        this.state = useState({
            isExpanded: false,
            lotCount: 0,
        });

        onWillStart(() => this._refreshCount());
        onWillUpdateProps((nextProps) => this._refreshCount(nextProps));
        onWillUnmount(() => this.removeDetailsRow());
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    _refreshCount(props = this.props) {
        this.state.lotCount = this._getMoveLineData(props).length;
    }

    /**
     * Extrae {lotId, lotName, qty, locationName} desde move_line_ids del record.
     * El record es un stock.move con sub-records OWL en move_line_ids.records[].
     */
    _getMoveLineData(props = this.props) {
        const lines = props?.record?.data?.move_line_ids;
        if (!lines?.records) return [];

        const data = [];
        for (const line of lines.records) {
            const lot = line.data?.lot_id;
            const lotId = Array.isArray(lot) ? lot[0] : (lot?.id || null);
            if (!lotId) continue;

            const lotName = Array.isArray(lot) ? (lot[1] || "") : (lot?.display_name || "");
            const loc = line.data?.location_id;
            const locationName = Array.isArray(loc) ? (loc[1] || "") : (loc?.display_name || "");
            const qty = line.data?.quantity || 0;
            data.push({ lotId, lotName, qty, locationName });
        }
        return data;
    }

    getProductName() {
        const pd = this.props.record?.data?.product_id;
        if (!pd) return "";
        if (Array.isArray(pd)) return pd[1] || "";
        return pd?.display_name || "";
    }

    // ─── Toggle ───────────────────────────────────────────────────────────────

    async handleToggle(ev) {
        ev.stopPropagation();

        if (this.state.isExpanded) {
            this.removeDetailsRow();
            this.state.isExpanded = false;
            return;
        }

        // Cerrar cualquier otro expandido en la misma vista
        document.querySelectorAll(".dlots-details-row").forEach((e) => e.remove());

        const tr = ev.currentTarget.closest("tr");
        if (!tr) return;

        this.state.isExpanded = true;
        await this.injectDetailsRow(tr);
    }

    // ─── Inyección DOM puro (igual que stone_line_list) ───────────────────────

    async injectDetailsRow(currentRow) {
        const newTr = document.createElement("tr");
        newTr.className = "dlots-details-row";

        const colCount = currentRow.querySelectorAll("td, th").length || 8;
        const td = document.createElement("td");
        td.colSpan = colCount;
        td.className = "dlots-details-cell";

        const moveLineData = this._getMoveLineData();
        const productName = this.getProductName();

        // Header
        const header = document.createElement("div");
        header.className = "dlots-header";
        header.innerHTML = `
            <span class="dlots-title">
                <i class="fa fa-th-large me-2"></i>
                Placas asignadas
                ${productName ? `<span class="dlots-product-name">— ${productName}</span>` : ""}
                <span class="dlots-badge">${moveLineData.length}</span>
            </span>
        `;

        // Body
        const body = document.createElement("div");
        body.className = "dlots-body";
        body.innerHTML = `
            <div class="dlots-loading">
                <i class="fa fa-circle-o-notch fa-spin me-2"></i> Cargando datos de placas...
            </div>`;

        const container = document.createElement("div");
        container.className = "dlots-container";
        container.appendChild(header);
        container.appendChild(body);
        td.appendChild(container);
        newTr.appendChild(td);
        currentRow.after(newTr);
        this._detailsRow = newTr;

        await this.renderLotsTable(body, moveLineData);
    }

    async renderLotsTable(container, moveLineData) {
        if (!moveLineData.length) {
            container.innerHTML = `
                <div class="dlots-empty">
                    <i class="fa fa-info-circle me-2 text-muted"></i>
                    <span class="text-muted">No hay placas asignadas a este movimiento.</span>
                </div>`;
            return;
        }

        const lotIds = moveLineData.map((d) => d.lotId);
        const lineMap = Object.fromEntries(moveLineData.map((d) => [d.lotId, d]));

        try {
            // Una sola llamada para todos los campos x_ de los lotes
            const lotsData = await this.orm.searchRead(
                "stock.lot",
                [["id", "in", lotIds]],
                [
                    "name",
                    "x_bloque", "x_atado", "x_grupo",
                    "x_alto", "x_ancho", "x_grosor",
                    "x_tipo", "x_color",
                    "x_pedimento", "x_contenedor", "x_origen",
                    "x_numero_placa", "x_referencia_proveedor",
                    "x_detalles_placa",
                ],
                { limit: lotIds.length }
            );

            const lotMap = Object.fromEntries(lotsData.map((l) => [l.id, l]));

            let totalQty = 0;
            for (const d of moveLineData) totalQty += d.qty;

            let rows = "";
            for (const lotId of lotIds) {
                const lot = lotMap[lotId];
                const line = lineMap[lotId];
                const qty = line?.qty || 0;
                // Solo el último segmento de la ruta de ubicación
                const loc = (line?.locationName || "").split("/").pop();

                if (!lot) {
                    rows += `<tr>
                        <td class="cell-lot text-muted">#${lotId}</td>
                        <td colspan="13" class="text-muted fst-italic">Datos no disponibles</td>
                    </tr>`;
                    continue;
                }

                rows += `
                    <tr>
                        <td class="cell-lot">${lot.name}</td>
                        <td>${lot.x_bloque || "-"}</td>
                        <td>${lot.x_atado || "-"}</td>
                        <td>${lot.x_grupo || "-"}</td>
                        <td class="col-num">${lot.x_alto ? lot.x_alto.toFixed(0) : "-"}</td>
                        <td class="col-num">${lot.x_ancho ? lot.x_ancho.toFixed(0) : "-"}</td>
                        <td class="col-num">${lot.x_grosor || "-"}</td>
                        <td class="col-num fw-bold">${qty.toFixed(2)}</td>
                        <td>${lot.x_tipo || "-"}</td>
                        <td>${lot.x_color || "-"}</td>
                        <td class="text-muted">${loc || "-"}</td>
                        <td class="text-muted font-mono">${lot.x_pedimento || "-"}</td>
                        <td class="text-muted">${lot.x_contenedor || "-"}</td>
                        <td class="text-center">
                            ${lot.x_detalles_placa
                                ? `<i class="fa fa-exclamation-triangle text-warning" title="${lot.x_detalles_placa}"></i>`
                                : '<span class="text-muted">-</span>'
                            }
                        </td>
                    </tr>`;
            }

            container.innerHTML = `
                <table class="dlots-table">
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
                            <th>Contenedor</th>
                            <th class="text-center">Notas</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                    <tfoot>
                        <tr class="dlots-total-row">
                            <td colspan="7" class="text-end fw-bold text-muted">
                                Total (${lotIds.length} placa${lotIds.length !== 1 ? "s" : ""}):
                            </td>
                            <td class="col-num fw-bold">${totalQty.toFixed(2)}</td>
                            <td colspan="6"></td>
                        </tr>
                    </tfoot>
                </table>`;

        } catch (err) {
            console.error("[DELIVERY LOTS] Error:", err);
            container.innerHTML = `
                <div class="dlots-empty text-danger">
                    <i class="fa fa-exclamation-triangle me-2"></i>
                    Error al cargar datos: ${err.message}
                </div>`;
        }
    }

    removeDetailsRow() {
        if (this._detailsRow) {
            this._detailsRow.remove();
            this._detailsRow = null;
        }
    }
}

registry.category("fields").add("delivery_lots_button", {
    component: DeliveryLotsButton,
    displayName: "Botón Lotes Albarán",
    supportedTypes: ["one2many"],
});
