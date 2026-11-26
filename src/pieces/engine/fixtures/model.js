'use strict';

// An invented model that builds on the same model of a cartridge further down the path.
var base = module.superModule;
var collections = require('*/cartridge/scripts/util/collections');

/**
 * A cart with gift wrapping.
 * @param {dw.order.Basket} basket - the current basket
 * @constructor
 */
function CartModel(basket) {
    base.call(this, basket);
    this.giftWrap = !!(basket && basket.custom.giftWrap);
    this.lineCount = basket ? collections.map(basket.productLineItems, function (item) {
        return item.UUID;
    }).length : 0;
}

CartModel.prototype = Object.create(base.prototype);

/** Whether the cart can be wrapped. */
base.canWrap = function (basket) {
    return !!basket && basket.productLineItems.length > 0;
};

module.exports = base;
