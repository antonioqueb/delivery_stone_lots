# -*- coding: utf-8 -*-
from odoo import models, api
import logging
_logger = logging.getLogger(__name__)


class StockQuantDelivery(models.Model):
    _inherit = 'stock.quant'

    @api.model
    def search_stone_inventory_for_delivery(self, product_id, filters=None, current_lot_ids=None, move_id=None, page=0, page_size=35):
        """
        Versión para albarán de entrega.
        Diferencia clave vs search_stone_inventory_for_so:
        - No excluye lotes comprometidos en el picking/move actual (current_lot_ids).
        - Sí excluye lotes comprometidos en OTROS pickings confirmados.
        - Si move_id se pasa, excluye lotes de OTROS moves del mismo picking 
          para evitar asignar la misma placa a dos movimientos distintos.
        """
        if not filters:
            filters = {}

        safe_current_ids = []
        if current_lot_ids:
            if isinstance(current_lot_ids, list):
                safe_current_ids = [x for x in current_lot_ids if isinstance(x, int)]

        product_id = int(product_id)

        # Lotes comprometidos en move_lines de pickings activos vinculados a ventas confirmadas
        # EXCEPTO los que ya están en nuestro move actual (safe_current_ids)
        committed_domain = [
            ('product_id', '=', product_id),
            ('lot_id', '!=', False),
            ('state', 'not in', ['done', 'cancel']),
        ]

        if move_id:
            # Excluir lotes de OTROS moves (no el nuestro)
            committed_domain.append(('move_id', '!=', int(move_id)))

        committed_lines = self.env['stock.move.line'].search(committed_domain)
        committed_ids = set(committed_lines.mapped('lot_id').ids)

        # También lotes en sale.order.line de órdenes confirmadas que no son del move actual
        committed_sol = self.env['sale.order.line'].search([
            ('product_id', '=', product_id),
            ('lot_ids', '!=', False),
            ('order_id.state', 'in', ['sale', 'done']),
        ])
        for sol in committed_sol:
            committed_ids.update(sol.lot_ids.ids)

        # Los lotes que ya tenemos en nuestro move NO se excluyen (están disponibles para re-seleccionar)
        excluded_lot_ids = [lid for lid in committed_ids if lid not in safe_current_ids]

        _logger.info(
            "[DLOTS SEARCH] product=%s move=%s committed=%s excluded=%s current=%s",
            product_id, move_id, len(committed_ids), len(excluded_lot_ids), len(safe_current_ids)
        )

        # Dominio base
        base_domain = [
            ('product_id', '=', product_id),
            ('location_id.usage', '=', 'internal'),
            ('quantity', '>', 0),
        ]

        if excluded_lot_ids:
            base_domain.append(('lot_id', 'not in', excluded_lot_ids))

        # Lotes libres O los que ya tenemos seleccionados
        free_domain = [('reserved_quantity', '=', 0)]
        if 'x_tiene_hold' in self.env['stock.quant']._fields:
            free_domain.append(('x_tiene_hold', '=', False))

        if safe_current_ids:
            availability_domain = ['|', ('lot_id', 'in', safe_current_ids)] + ['&'] + free_domain
        else:
            availability_domain = free_domain

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

        # Contar total
        total = self.search_count(domain)

        # Página
        offset = int(page) * int(page_size)
        quants = self.search(domain, limit=int(page_size), offset=offset, order='lot_id')

        lot_ids = quants.mapped('lot_id').ids
        lots_data = self._build_lots_data(lot_ids)
        items = self._quants_to_result(quants, lots_data)

        _logger.info(
            "[DLOTS SEARCH] total=%s page=%s got=%s",
            total, page, len(items)
        )

        return {'items': items, 'total': total}