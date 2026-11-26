'use strict';

// Every require and export shape the facts know, on invented modules.
var Resource = require('dw/web/Resource');
const { getPrice, formatMoney: format } = require('*/cartridge/scripts/helpers/priceHelpers');
var URLUtils = require('dw/web').URLUtils;
var later;
later = require('~/cartridge/scripts/later');
require('./sideEffect');
var dynamic = require(Resource.msg('module.name', 'config', null));

function lookup(id) {
    var StoreMgr = require('dw/catalog/StoreMgr');
    const { lat, ...rest } = require('../geo');
    return StoreMgr.getStore(id) || lat || rest;
}

var local = 1;
var shared = { kind: 'shared' };

module.exports = {
    lookup: lookup,
    local,
    title: function () {
        return Resource.msg('title', 'common', null) + URLUtils.home();
    },
    describe() {
        return format(getPrice(local));
    },
    later: later,
    nested: require('*/cartridge/scripts/nested')
};

module.exports.extra = function () {
    return dynamic;
};

exports.direct = shared;

module.exports = Object.assign(module.exports, {
    assigned: true
});
