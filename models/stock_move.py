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

    def action_update_quantity_from_lines(self):
        """
        Recalcula la cantidad del move basándose en las move lines asignadas.
        Llamado desde el JS después de confirmar selección de placas.
        """
        self.ensure_one()
        total_qty = sum(self.move_line_ids.mapped('quantity'))
        _logger.info(
            "[DLOTS] Actualizando cantidad move %s: %s -> %s (lines: %s)",
            self.id, self.product_uom_qty, total_qty, len(self.move_line_ids)
        )
        if self.state in ('draft', 'confirmed', 'waiting', 'assigned'):
            self.write({'product_uom_qty': total_qty, 'quantity': total_qty})
        return True