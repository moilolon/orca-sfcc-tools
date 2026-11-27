'use strict';

var collections = require('../util/collections');

/**
 * The base price helper.
 * @param {dw.catalog.Product} product - the product
 * @returns {string} its price
 */
function price(product) {
    return collections.map([product], String).join('');
}

module.exports = {
    price: price
};
