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

        return {'items': items, 'total': total}