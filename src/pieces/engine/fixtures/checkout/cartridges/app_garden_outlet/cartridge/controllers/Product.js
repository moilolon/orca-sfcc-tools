'use strict';

/**
 * The outlet cartridge, on the outlet storefront only, adds the outlet price after the core and
 * base chain.
 */
var server = require('server');
server.extend(module.superModule);

server.append('Show', function (req, res, next) {
    res.setViewData({ outlet: true });
    next();
});

module.exports = server.exports();
