'use strict';

/**
 * Templates, resource keys and bundles: some that exist everywhere, some nowhere, some on the
 * outlet only.
 */
var Resource = require('dw/web/Resource');
var ISML = require('dw/template/ISML');

function names(res) {
    res.render('product/productDetails');
    res.render('checks/nowhere');
    ISML.renderTemplate('outlet/banner', {});
    var labels = [
        Resource.msg('label.price', 'product', null),
        Resource.msg('label.nowhere', 'product', null),
        Resource.msg('label.sale', 'product', null),
        Resource.msgf('label.stock', 'product', null, 3),
        Resource.msg('label.any', 'gardenNotes', null)
    ];
    return labels;
}

module.exports = { names: names };
