'use strict';

/**
 * An invented SFRA controller: a product page and a quick view.
 */
var server = require('server');
var cache = require('*/cartridge/scripts/middleware/cache');
var consentTracking = require('*/cartridge/scripts/middleware/consentTracking');
var pageMetaData = require('*/cartridge/scripts/middleware/pageMetaData');

server.get(
    'Show',
    cache.applyPromotionSensitiveCache,
    consentTracking.consent,
    function (req, res, next) {
        var ProductFactory = require('*/cartridge/scripts/factories/product');
        var URLUtils = require('dw/web/URLUtils');
        var params = req.querystring;
        var product = ProductFactory.get(params);

        if (!product || !product.online) {
            res.setStatusCode(404);
            res.render('error/notFound');
            return next();
        }

        res.render('product/productDetails', {
            product: product,
            canonicalUrl: URLUtils.url('Product-Show', 'pid', product.id),
            breadcrumbs: []
        });
        return next();
    },
    pageMetaData.computedPageMetaData
);

server.get('ShowQuickView', cache.applyPromotionSensitiveCache, function (req, res, next) {
    var ProductFactory = require('*/cartridge/scripts/factories/product');
    var product = ProductFactory.get(req.querystring);
    var template = product.productType === 'set' ? 'product/setQuickView' : 'product/quickView';
    res.render(template, { product: product, closeButtonText: 'Close' });
    next();
});

module.exports = server.exports();
