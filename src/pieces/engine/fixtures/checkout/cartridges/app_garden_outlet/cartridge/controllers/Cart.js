'use strict';

/**
 * A controller of the outlet's own, with an append on a route nobody declares.
 */
var server = require('server');
var helper = require('*/cartridge/scripts/helpers/cartHelper');
var outlet = require('app_garden_outlet');

server.get('Show', function (req, res, next) {
    res.render('cart/cart', { label: Resource.msg('label.sale', 'product', null) });
    next();
});

server.append('Missing', function (req, res, next) {
    next();
});

module.exports = server.exports();
