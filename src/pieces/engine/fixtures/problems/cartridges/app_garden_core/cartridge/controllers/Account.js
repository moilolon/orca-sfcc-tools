'use strict';

/**
 * The core cartridge extends an account controller no cartridge after it has.
 */
var server = require('server');
server.extend(module.superModule);

server.append('Show', function (req, res, next) {
    next();
});

module.exports = server.exports();
