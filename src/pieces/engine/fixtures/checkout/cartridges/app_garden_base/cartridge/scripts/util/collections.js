'use strict';

var ArrayList = require('dw/util/ArrayList');

module.exports = {
    map: function (list, callback) {
        var out = new ArrayList();
        list.forEach(function (item) { out.push(callback(item)); });
        return out.toArray();
    }
};
