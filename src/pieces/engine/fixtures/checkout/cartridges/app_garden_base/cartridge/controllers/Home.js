'use strict';

var server = require('server');
var Resource = require('dw/web/Resource');

server.get('Show', function (req, res, next) {
    res.render('home/homePage', { title: Resource.msg('title.home', 'common', null) });
    next();
});

module.exports = server.exports();
