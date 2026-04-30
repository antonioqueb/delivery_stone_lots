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
            move.x_original_demand = move.sale_line_id.product_uom_qty if move.sale_line_id else 0.0

    def _get_delivery_quant_for_lot(self, lot_id):
        """
        Busca el quant físico real del lote para este movimiento.

        Prioridad:
        1. Ubicación origen del movimiento o sus hijas.
        2. Cualquier ubicación interna con stock positivo.
        """
        self.ensure_one()

        domain = [
            ('lot_id', '=', lot_id),
            ('product_id', '=', self.product_id.id),
            ('quantity', '>', 0),
        ]

        quant = self.env['stock.quant'].search(
            domain + [('location_id', 'child_of', self.location_id.id)],
            limit=1,
        )

        if quant:
            return quant

        return self.env['stock.quant'].search(
            domain + [('location_id.usage', '=', 'internal')],
            limit=1,
        )

    def _get_delivery_lot_qty(self, lot_id, full_qty, breakdown):
        """
        Determina la cantidad a asignar para un lote.

        - Placa: siempre toma la cantidad física completa del quant.
        - Formato / Pieza: toma breakdown si existe.
        - Si no existe breakdown, usa full_qty.
        """
        lot = self.env['stock.lot'].browse(lot_id)
        if not lot.exists():
            return full_qty

        tipo = (lot.x_tipo or 'placa').lower() if 'x_tipo' in lot._fields else 'placa'
        if tipo not in ('formato', 'pieza'):
            return full_qty

        lot_id_str = str(lot_id)
        if breakdown and lot_id_str in breakdown:
            partial_qty = float(breakdown[lot_id_str] or 0.0)
            return min(partial_qty, full_qty) if full_qty > 0 else partial_qty

        return full_qty

    def action_set_delivery_lots(self, lot_ids, breakdown=None):
        """
        Define exactamente qué lotes deben quedar asignados a este movimiento.

        lot_ids:
            Lista final de IDs de stock.lot que deben quedar en el movimiento.

        breakdown:
            Dict opcional {lot_id_str: qty}, usado para formatos/piezas con
            cantidades parciales.

        La acción:
        - elimina lotes deseleccionados,
        - crea líneas para lotes nuevos,
        - actualiza cantidades parciales,
        - fuerza que la demanda del move coincida con la suma de líneas.
        """
        self.ensure_one()

        if not breakdown:
            breakdown = {}

        lot_ids = [int(lid) for lid in (lot_ids or []) if lid]

        current_lines = self.move_line_ids.filtered(lambda line: line.lot_id)
        current_lot_ids = set(current_lines.mapped('lot_id').ids)
        final_lot_ids = set(lot_ids)

        to_remove = current_lot_ids - final_lot_ids
        to_add = final_lot_ids - current_lot_ids
        to_keep = current_lot_ids & final_lot_ids

        ctx = dict(
            self.env.context,
            skip_stone_sync_so=True,
            skip_stone_sync=True,
            skip_picking_clean=True,
            skip_hold_validation=True,
        )

        # 1. Eliminar placas deseleccionadas
        if to_remove:
            lines_to_unlink = current_lines.filtered(lambda line: line.lot_id.id in to_remove)
            _logger.info(
                "[DLOTS] Eliminando %s lote(s) del move %s: %s",
                len(lines_to_unlink),
                self.id,
                list(to_remove),
            )
            lines_to_unlink.with_context(ctx).unlink()

        # 2. Agregar placas nuevas
        if to_add:
            lines_vals = []

            for lot_id in to_add:
                quant = self._get_delivery_quant_for_lot(lot_id)
                full_qty = quant.quantity if quant else 0.0
                source_location_id = quant.location_id.id if quant else self.location_id.id

                qty = self._get_delivery_lot_qty(lot_id, full_qty, breakdown)

                lines_vals.append({
                    'move_id': self.id,
                    'picking_id': self.picking_id.id,
                    'product_id': self.product_id.id,
                    'product_uom_id': self.product_uom.id,
                    'lot_id': lot_id,
                    'quantity': qty,
                    'location_id': source_location_id,
                    'location_dest_id': self.location_dest_id.id,
                })

                _logger.info(
                    "[DLOTS] Preparando lote %s para move %s qty=%s loc=%s",
                    lot_id,
                    self.id,
                    qty,
                    source_location_id,
                )

            if lines_vals:
                self.env['stock.move.line'].with_context(ctx).create(lines_vals)

        # 3. Actualizar cantidades de lotes ya existentes
        if to_keep:
            refreshed_lines = self.move_line_ids.filtered(lambda line: line.lot_id)

            for lot_id in to_keep:
                line = refreshed_lines.filtered(lambda item: item.lot_id.id == lot_id)[:1]
                if not line:
                    continue

                quant = self._get_delivery_quant_for_lot(lot_id)
                full_qty = quant.quantity if quant else line.quantity
                source_location_id = quant.location_id.id if quant else line.location_id.id

                new_qty = self._get_delivery_lot_qty(lot_id, full_qty, breakdown)

                vals = {}

                if line.quantity != new_qty:
                    vals['quantity'] = new_qty

                if source_location_id and line.location_id.id != source_location_id:
                    vals['location_id'] = source_location_id

                if vals:
                    _logger.info(
                        "[DLOTS] Actualizando lote %s en move %s: %s",
                        lot_id,
                        self.id,
                        vals,
                    )
                    line.with_context(ctx).write(vals)

        # 4. Recalcular demanda del movimiento
        return self.action_update_quantity_from_lines()

    def action_update_quantity_from_lines(self):
        """
        Ajusta el move para que la demanda coincida con las placas asignadas.
        """
        self.ensure_one()

        total_qty = sum(self.move_line_ids.mapped('quantity'))

        _logger.info(
            "[DLOTS] Actualizando move %s: product_uom_qty=%s quantity=%s total_lines=%s lines=%s",
            self.id,
            self.product_uom_qty,
            self.quantity,
            total_qty,
            len(self.move_line_ids),
        )

        if self.state in ('draft', 'confirmed', 'waiting', 'assigned', 'partially_available'):
            vals = {'product_uom_qty': total_qty}
            if 'quantity' in self._fields:
                vals['quantity'] = total_qty
            self.write(vals)

        return True