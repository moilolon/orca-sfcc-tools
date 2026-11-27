'use strict';

var base = module.superModule;
var Site = require('dw/system/Site');

/**
 * The core price helper: the base one, with the site's currency first.
 * @param {dw.catalog.Product} product - the product
 * @returns {string} its price
 */
function price(product) {
    return Site.current.getCustomPreferenceValue('gardenCurrency') + base.price(product);
}

module.exports = {
    price: price
};
