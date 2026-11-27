'use strict';

/**
 * An invented stand-in for SFRA's server module: enough for the index to find it by its bare
 * name. It declares no routes of its own.
 */
var routes = {};

module.exports = {
    get: function (name) { routes[name] = Array.prototype.slice.call(arguments, 1); },
    post: function (name) { routes[name] = Array.prototype.slice.call(arguments, 1); },
    use: function (name) { routes[name] = Array.prototype.slice.call(arguments, 1); },
    exports: function () { return { routes: routes }; }
};
