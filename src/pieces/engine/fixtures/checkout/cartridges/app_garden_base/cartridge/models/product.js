'use strict';

/**
 * The base product model.
 * @param {dw.catalog.Product} apiProduct - the product
 */
function Product(apiProduct) {
    this.id = apiProduct.ID;
    this.name = apiProduct.name;
    this.colour = apiProduct.custom.gardenColour;
}

module.exports = Product;
