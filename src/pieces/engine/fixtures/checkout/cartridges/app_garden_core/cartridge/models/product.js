'use strict';

var base = module.superModule;

/**
 * The core product model: the base one, with a badge.
 * @param {dw.catalog.Product} apiProduct - the product
 */
function Product(apiProduct) {
    base.call(this, apiProduct);
    this.badge = apiProduct.custom.gardenBadge;
}

module.exports = Product;
