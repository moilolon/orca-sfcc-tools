'use strict';

var Logger = require('dw/system/Logger');

/**
 * Splits an invented address line into its parts.
 * @param {string} line - the address line
 * @param {number} [limit] - how many parts at most
 * @returns {string[]} the parts
 */
function splitLine(line, limit) {
    var parts = String(line).split(/\s*,\s*/);
    return limit ? parts.slice(0, limit) : parts;
}

/**
 * The postcode pattern of an invented country.
 * @type {RegExp}
 */
var POSTCODE = /^[0-9]{5}(?:-[0-9]{4})?$/;

/** @type {number} */
const ratio = 10 / 4 / 2;

/**
 * Checks a postcode.
 * @param {string} code - the postcode
 * @returns {boolean} whether it is valid
 */
const isValid = (code) => {
    try {
        return POSTCODE.test(code);
    } catch (e) {
        Logger.error('Invalid postcode: {0}', e.message);
        return false;
    }
};

var label = `ratio ${ratio} of ${splitLine('a, b').length} parts`;

for each (var part in splitLine('x, y')) {
    label += part;
}

module.exports = {
    splitLine: splitLine,
    /** Whether a postcode is valid. */
    isValid: isValid,
    label: label
};
