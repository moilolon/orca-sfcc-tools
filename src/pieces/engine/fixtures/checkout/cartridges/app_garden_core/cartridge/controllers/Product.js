'use strict';

/**
 * The core cartridge extends the base product controller: a check before the page, data after
 * it, its own tile, and a page of its own.
 */
var server = require('server');
var page = module.superModule;
server.extend(page);

server.prepend('Show', function (req, res, next) {
    next();
});

server.append('Show', function (req, res, next) {
    res.setViewData({ badge: true });
    next();
});

server.replace('Tile', function (req, res, next) {
    res.render('product/components/price');
    next();
});

server.get('Compare', function (req, res, next) {
    res.render('product/compare');
    next();
});

module.exports = server.exports();
