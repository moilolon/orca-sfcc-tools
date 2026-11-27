'use strict';

/**
 * A controller with a route and no `module.exports = server.exports()`.
 */
var server = require('server');

server.get('Show', function (req, res, next) {
    next();
});
