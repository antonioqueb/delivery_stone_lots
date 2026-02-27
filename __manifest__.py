# -*- coding: utf-8 -*-
{
    'name': 'Delivery Stone Lots Viewer',
    'version': '19.0.1.0.0',
    'category': 'Inventory',
    'summary': 'Visualización de lotes (placas) asignados en el albarán de entrega',
    'author': 'Alphaqueb Consulting SAS',
    'website': 'https://alphaqueb.com',
    'depends': ['stock', 'stock_lot_dimensions'],
    'data': [
        'views/stock_picking_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'delivery_stone_lots/static/src/scss/delivery_lots_styles.scss',
            'delivery_stone_lots/static/src/components/delivery_lots_button/delivery_lots_button.xml',
            'delivery_stone_lots/static/src/components/delivery_lots_button/delivery_lots_button.js',
        ],
    },
    'installable': True,
    'application': False,
    'license': 'OPL-1',
}
