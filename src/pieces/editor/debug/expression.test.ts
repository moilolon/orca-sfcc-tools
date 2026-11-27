// The name under the pointer while halted: the chain of property reads that ends at it, read with
// the engine's parser, and nothing for anything else. The script is invented.
import { assert, test } from 'orca/testing'
import { HoverReader } from './expression'

const SCRIPT = [
  "var BasketMgr = require('dw/order/BasketMgr');",
  'function total(items) {',
  '  var basket = BasketMgr.getCurrentBasket();',
  '  var gross = basket.totalGrossPrice.value; // basket.note',
  "  var label = 'basket.name';",
  '  var first = items[0].productID + items[i].quantity;',
  '  var options = { currency: basket.currencyCode, shipping: this.shipping };',
  '  loop: for (var i = 0; i < 2; i++) { continue loop; }',
  '  return getTotal().net;',
  '}'
].join('\n')

/** What the reader answers with the pointer on the `nth` (0-based) occurrence of `word`, `at` characters into it. */
function hovered(word: string, nth = 0, at = 1): string | null {
  let offset = -1
  for (let i = 0; i <= nth; i++) offset = SCRIPT.indexOf(word, offset + 1)
  assert.ok(offset >= 0, `${word} is in the script`)
  const target = new HoverReader().at(SCRIPT, offset + at)
  if (target) assert.equal(SCRIPT.slice(target.from, target.to), target.expression)
  return target?.expression ?? null
}

test('a name, or the chain of reads that ends at it', () => {
  assert.equal(hovered('basket', 0), 'basket')
  assert.equal(hovered('basket', 1), 'basket')
  assert.equal(hovered('totalGrossPrice'), 'basket.totalGrossPrice')
  assert.equal(hovered('value'), 'basket.totalGrossPrice.value')
  assert.equal(hovered('productID'), 'items[0].productID')
  assert.equal(hovered('currencyCode'), 'basket.currencyCode')
  assert.equal(hovered('shipping', 1), 'this.shipping')
  assert.equal(hovered('items', 0), 'items')
  // A function's name is read, never called.
  assert.equal(hovered('getCurrentBasket'), 'BasketMgr.getCurrentBasket')
})

test('nothing inside a string or a comment, on a key, a label, a keyword, or after a call or an expression index', () => {
  assert.equal(hovered('basket.note', 0, 2), null, 'a comment')
  assert.equal(hovered('basket.name', 0, 2), null, 'a string')
  assert.equal(hovered('currency:'), null, 'an object key')
  assert.equal(hovered('loop:'), null, 'a label')
  assert.equal(hovered('loop;'), null, 'a label after continue')
  assert.equal(hovered('quantity'), null, 'read through an expression index')
  assert.equal(hovered('net'), null, 'read on a call’s result')
  assert.equal(hovered('return'), null, 'a keyword')
})

test('one parse per text: the same reader answers again without reading the text again', () => {
  const reader = new HoverReader()
  const offset = SCRIPT.indexOf('totalGrossPrice') + 2
  assert.equal(reader.at(SCRIPT, offset)?.expression, 'basket.totalGrossPrice')
  assert.equal(reader.at(SCRIPT, offset)?.expression, 'basket.totalGrossPrice')
  assert.equal(reader.at(`${SCRIPT}\n`, offset)?.expression, 'basket.totalGrossPrice')
})
