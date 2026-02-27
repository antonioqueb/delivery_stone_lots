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
        return True