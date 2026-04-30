# -*- coding: utf-8 -*-
from odoo import models, api
import logging

_logger = logging.getLogger(__name__)


class StockQuantDelivery(models.Model):
    _inherit = 'stock.quant'

    def _dlots_get_lot_field(self, lot, field_name, default=False):
        if field_name in lot._fields:
            return lot[field_name]
        return default

    def _dlots_build_lots_data(self, lot_ids):
        lots_data = {}
        if not lot_ids:
            return lots_data

        lots = self.env['stock.lot'].browse(lot_ids)

        for lot in lots:
            x_proveedor_value = self._dlots_get_lot_field(lot, 'x_proveedor', False)
            if x_proveedor_value:
                field = lot._fields.get('x_proveedor')
                if field and field.type == 'many2one':
                    x_proveedor_display = x_proveedor_value.name
                else:
                    x_proveedor_display = str(x_proveedor_value)
            else:
                x_proveedor_display = ''

            lots_data[lot.id] = {
                'name': lot.name,
                'x_grosor': self._dlots_get_lot_field(lot, 'x_grosor', 0) or 0,
                'x_alto': self._dlots_get_lot_field(lot, 'x_alto', 0) or 0,
                'x_ancho': self._dlots_get_lot_field(lot, 'x_ancho', 0) or 0,
                'x_peso': self._dlots_get_lot_field(lot, 'x_peso', 0) or 0,
                'x_tipo': self._dlots_get_lot_field(lot, 'x_tipo', '') or '',
                'x_numero_placa': self._dlots_get_lot_field(lot, 'x_numero_placa', '') or '',
                'x_bloque': self._dlots_get_lot_field(lot, 'x_bloque', '') or '',
                'x_atado': self._dlots_get_lot_field(lot, 'x_atado', '') or '',
                'x_grupo': self._dlots_get_lot_field(lot, 'x_grupo', '') or '',
                'x_color': self._dlots_get_lot_field(lot, 'x_color', '') or '',
                'x_pedimento': self._dlots_get_lot_field(lot, 'x_pedimento', '') or '',
                'x_contenedor': self._dlots_get_lot_field(lot, 'x_contenedor', '') or '',
                'x_referencia_proveedor': self._dlots_get_lot_field(lot, 'x_referencia_proveedor', '') or '',
                'x_proveedor': x_proveedor_display,
                'x_origen': self._dlots_get_lot_field(lot, 'x_origen', '') or '',
                'x_detalles_placa': self._dlots_get_lot_field(lot, 'x_detalles_placa', '') or '',
            }

        return lots_data

    def _dlots_quants_to_result(self, quants, lots_data):
        result = []

        for quant in quants:
            lot_id = quant.lot_id.id if quant.lot_id else False
            lot_info = lots_data.get(lot_id, {})

            result.append({
                'id': quant.id,
                'lot_id': [lot_id, lot_info.get('name', '')] if lot_id else False,
                'location_id': [quant.location_id.id, quant.location_id.display_name] if quant.location_id else False,
                'quantity': quant.quantity,
                'reserved_quantity': quant.reserved_quantity,
                'x_grosor': lot_info.get('x_grosor', 0) or 0,
                'x_alto': lot_info.get('x_alto', 0) or 0,
                'x_ancho': lot_info.get('x_ancho', 0) or 0,
                'x_peso': lot_info.get('x_peso', 0) or 0,
                'x_tipo': lot_info.get('x_tipo', '') or '',
                'x_numero_placa': lot_info.get('x_numero_placa', '') or '',
                'x_bloque': lot_info.get('x_bloque', '') or '',
                'x_atado': lot_info.get('x_atado', '') or '',
                'x_grupo': lot_info.get('x_grupo', '') or '',
                'x_color': lot_info.get('x_color', '') or '',
                'x_pedimento': lot_info.get('x_pedimento', '') or '',
                'x_contenedor': lot_info.get('x_contenedor', '') or '',
                'x_referencia_proveedor': lot_info.get('x_referencia_proveedor', '') or '',
                'x_proveedor': lot_info.get('x_proveedor', '') or '',
                'x_origen': lot_info.get('x_origen', '') or '',
                'x_detalles_placa': lot_info.get('x_detalles_placa', '') or '',
            })

        return result

    def _dlots_build_availability_domain(self, safe_current_ids):
        """
        Dominio de disponibilidad:
        - libres: reserved_quantity = 0 y sin hold,
        - o lotes ya seleccionados en este move actual.
        """
        free_conditions = [('reserved_quantity', '=', 0)]

        if 'x_tiene_hold' in self._fields:
            free_conditions.append(('x_tiene_hold', '=', False))

        if not safe_current_ids:
            return free_conditions

        current_condition = ('lot_id', 'in', safe_current_ids)

        if len(free_conditions) == 1:
            return ['|', current_condition, free_conditions[0]]

        # Equivalente: current OR (reserved_quantity = 0 AND x_tiene_hold = False)
        return ['|', current_condition, '&'] + free_conditions[:2]

    @api.model
    def search_stone_inventory_for_delivery(
        self,
        product_id,
        filters=None,
        current_lot_ids=None,
        move_id=None,
        page=0,
        page_size=35,
    ):
        """
        Inventario disponible para albarán de entrega.

        Reglas:
        - Muestra stock físico positivo en ubicaciones internas.
        - Excluye lotes comprometidos por otros movimientos activos.
        - Mantiene visibles los lotes ya seleccionados en el move actual.
        - Permite filtrar por lote, bloque, atado, dimensiones mínimas y tipo.
        """
        filters = filters or {}
        product_id = int(product_id)
        page = int(page or 0)
        page_size = int(page_size or 35)

        safe_current_ids = []
        if isinstance(current_lot_ids, list):
            safe_current_ids = [int(item) for item in current_lot_ids if isinstance(item, int)]

        committed_domain = [
            ('product_id', '=', product_id),
            ('lot_id', '!=', False),
            ('state', 'not in', ['done', 'cancel']),
        ]

        if move_id:
            committed_domain.append(('move_id', '!=', int(move_id)))

        committed_lines = self.env['stock.move.line'].search(committed_domain)
        committed_lot_ids = set(committed_lines.mapped('lot_id').ids)
        excluded_lot_ids = [lot_id for lot_id in committed_lot_ids if lot_id not in safe_current_ids]

        domain = [
            ('product_id', '=', product_id),
            ('location_id.usage', '=', 'internal'),
            ('quantity', '>', 0),
        ]

        if excluded_lot_ids:
            domain.append(('lot_id', 'not in', excluded_lot_ids))

        domain += self._dlots_build_availability_domain(safe_current_ids)

        if filters.get('bloque'):
            domain.append(('lot_id.x_bloque', 'ilike', filters['bloque']))

        if filters.get('atado'):
            domain.append(('lot_id.x_atado', 'ilike', filters['atado']))

        if filters.get('lot_name'):
            domain.append(('lot_id.name', 'ilike', filters['lot_name']))

        if filters.get('tipo'):
            domain.append(('lot_id.x_tipo', '=', filters['tipo']))

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
        offset = page * page_size

        quants = self.search(
            domain,
            limit=page_size,
            offset=offset,
            order='lot_id',
        )

        lot_ids = quants.mapped('lot_id').ids
        lots_data = self._dlots_build_lots_data(lot_ids)
        items = self._dlots_quants_to_result(quants, lots_data)

        _logger.info(
            "[DLOTS SEARCH] product=%s move=%s total=%s page=%s returned=%s current=%s excluded=%s filters=%s",
            product_id,
            move_id,
            total,
            page,
            len(items),
            len(safe_current_ids),
            len(excluded_lot_ids),
            filters,
        )

        return {
            'items': items,
            'total': total,
        }