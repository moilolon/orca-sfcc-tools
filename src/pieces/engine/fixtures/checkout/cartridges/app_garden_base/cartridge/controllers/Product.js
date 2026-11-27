'use strict';

/**
 * The base cartridge's product controller: a product page, a tile and a quick view.
 */
var server = require('server');
var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');
var collections = require('~/cartridge/scripts/util/collections');

server.get('Show', function (req, res, next) {
    var ProductMgr = require('dw/catalog/ProductMgr');
    var product = ProductMgr.getProduct(req.querystring.pid);
    res.render('product/productDetails', { product: product, price: priceHelper.price(product) });
    next();
});

server.get('Tile', function (req, res, next) {
    res.render('product/components/price', { list: collections.map([], String) });
    next();
});

server.post('QuickView', function (req, res, next) {
    res.render('product/quickView');
    next();
});

module.exports = server.exports();
