'use strict';

var base = module.superModule;

/**
 * The first product of a list: the core cartridge adds it to the base collections.
 * @param {dw.util.Collection} list - the products
 * @returns {dw.catalog.Product} the first one
 */
base.first = function (list) {
    return list.iterator().next();
};

module.exports = base;
