'use strict';

var Transaction = require('dw/system/Transaction');

function save(order, note) {
    Transaction.wrap(function () {
        order.custom.note = `saved ${note
