'use strict';

/**
 * A controller SFRA refuses: a route declared twice, and a change of one nobody declares.
 */
var server = require('server');

server.get('Show', function (req, res, next) {
    next();
});

server.get('Show', function (req, res, next) {
    next();
});

server.append('Nope', function (req, res, next) {
    next();
});

module.exports = server.exports();
