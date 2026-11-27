'use strict';

/**
 * Nothing wrong: known attributes and preferences, templates and keys that exist on every
 * storefront.
 */
var ProductMgr = require('dw/catalog/ProductMgr');
var Site = require('dw/system/Site');
var Resource = require('dw/web/Resource');

/**
 * @param {dw.catalog.Product} product - a product
 * @returns {Array} what the page shows
 */
function clean(product, res) {
    var found = ProductMgr.getProduct(product.ID);
    res.render('home/homePage');
    res.render('/product/components/price.isml');
    return [
        found.custom.gardenColour,
        product.custom.gardenBadge,
        Site.current.preferences.custom.gardenShowBadges,
        Site.getCurrent().getCustomPreferenceValue('gardenCurrency'),
        Resource.msg('label.price', 'product', null),
        Resource.msg('title.home', 'common', null),
        Resource.msgf('label.vat', 'product', null)
    ];
}

module.exports = { clean: clean };
