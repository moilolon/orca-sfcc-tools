'use strict';

/**
 * Custom attributes and site preferences, each of a type the types know: the known ones, an unknown
 * attribute, an unknown one written as a literal member, two unknown site preferences, an unknown
 * attribute of a custom object type, and one of a type with no metadata.
 */
var ProductMgr = require('dw/catalog/ProductMgr');
var Site = require('dw/system/Site');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var OrderMgr = require('dw/order/OrderMgr');

function check(productId, orderNo) {
    var product = ProductMgr.getProduct(productId);
    var colour = product.custom.gardenColour;
    var size = product.custom.gardenSize;
    var badge = product.custom['gardenBadges'];
    var currency = Site.getCurrent().getCustomPreferenceValue('gardenCurrency');
    var shipping = Site.getCurrent().getCustomPreferenceValue('gardenFreeShipping');
    var shown = Site.current.preferences.custom.gardenShowBadge;
    var owner = CustomObjectMgr.getCustomObject('GardenWishlist', productId).custom.owner;
    var items = CustomObjectMgr.getCustomObject('GardenWishlist', productId).custom.items;
    var gift = OrderMgr.getOrder(orderNo).custom.gardenGift;
    return [colour, size, badge, currency, shipping, shown, owner, items, gift];
}

module.exports = { check: check };
