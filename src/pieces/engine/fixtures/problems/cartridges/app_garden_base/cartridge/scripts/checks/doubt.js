'use strict';

/**
 * When in doubt, nothing: a type not known (a parameter with no JSDoc, a name guessed), a name
 * read at run time, a `Resource` that is not the platform's, and metadata of a type nobody defines.
 */
var ProductMgr = require('dw/catalog/ProductMgr');
var Site = require('dw/system/Site');
var Texts = require('~/cartridge/scripts/util/collections');

function doubt(item, name, bundle, res, product) {
    var guessed = product.custom.gardenNothing;
    var unknown = item.custom.gardenNothing;
    var dynamic = ProductMgr.getProduct('x').custom[name];
    var preference = Site.getCurrent().getCustomPreferenceValue(name);
    var key = Resource.msg(name, 'product', null);
    var otherBundle = Resource.msg('label.nowhere', bundle, null);
    var notPlatform = Texts.msg('label.nowhere', 'gardenNotes');
    var category = ProductMgr.getProduct('x').getPrimaryCategory().custom.gardenAisle;
    res.render(name);
    res.render('checks/' + name);
    return [guessed, unknown, dynamic, preference, key, otherBundle, notPlatform, category];
}

module.exports = { doubt: doubt };
