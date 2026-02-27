# -*- coding: utf-8 -*-
from odoo import models, fields, api
import logging

_logger = logging.getLogger(__name__)


class StockMove(models.Model):
    _inherit = 'stock.move'

    # Campo dummy Boolean que sirve como trigger del widget en la lista del albarán.
    # Mismo patrón que is_stone_expanded en sale_stone_selection.
    # No almacena nada relevante; el widget lee los lotes vía ORM.
    is_dlots_expanded = fields.Boolean(
        string='Ver Placas',
        default=False,
        copy=False,
    )