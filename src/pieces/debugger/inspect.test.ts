// The guard of what the editor's hover may evaluate: plain names and chains of property reads pass,
// rebuilt from the tree; anything that could run code with a side effect is refused. Every
// expression here is invented.
import { assert, test } from 'orca/testing'
import { MAX_INSPECT_LENGTH, MAX_INSPECT_LINKS, plainRead } from './inspect'

test('a name, `this`, and chains of property reads pass, rebuilt from the tree', () => {
  const accepted: [string, string][] = [
    ['basket', 'basket'],
    ['basket.totalGrossPrice', 'basket.totalGrossPrice'],
    ['basket.totalGrossPrice.value', 'basket.totalGrossPrice.value'],
    ['  pdict . product\n.ID  ', 'pdict.product.ID'],
    ['this', 'this'],
    ['this.orderNo', 'this.orderNo'],
    ['items[0]', 'items[0]'],
    ['items[0].productID', 'items[0].productID'],
    ["map['shipping-method']", 'map["shipping-method"]'],
    ['map["a\\"b"]', 'map["a\\"b"]'],
    ['$', '$'],
    // Parentheses read nothing: what is sent is rebuilt without them.
    ['(a)', 'a'],
    // A function's name is read, never called.
    ['getBasket', 'getBasket'],
    ['_cache.$entry', '_cache.$entry'],
    ['customer.profile.custom.loyaltyTier', 'customer.profile.custom.loyaltyTier']
  ]
  for (const [text, sent] of accepted) assert.equal(plainRead(text), sent, text)
})

test('calls, new, assignments, updates, deletes, operators and expression indexes are refused', () => {
  const refused = [
    '',
    '   ',
    'basket.getTotalGrossPrice()',
    'f()',
    'a.b()',
    'a.b().c',
    'new Date',
    'new dw.util.ArrayList()',
    'a = 1',
    'a.b = c',
    'a += 1',
    'a++',
    '--a.b',
    'delete a.b',
    'void a',
    'typeof a',
    '!a',
    '-a',
    'a + b',
    'a.b || c',
    'a && a.b',
    'a ? b : c',
    'a, b',
    'a[b]',
    'a[i + 1]',
    'a[f()]',
    'a[-1]',
    'a[1.5]',
    'a?.b',
    '`x`',
    'tag`x`',
    '"text"',
    '42',
    'null',
    'function () {}',
    '() => a',
    'a /* note */ .b',
    'a // note',
    'a.b;',
    'a; b',
    'a.',
    'a..b',
    'eval',
    'super.x',
    '[a]',
    '({ a: 1 })',
    'a.b = function () { return 1 }',
    'a .b = 1',
    'x'.repeat(MAX_INSPECT_LENGTH + 1)
  ]
  for (const text of refused) assert.equal(plainRead(text), null, text)
  assert.equal(plainRead(undefined), null)
  assert.equal(plainRead(42), null)
})

test('a chain longer than the limit is refused; one at it passes', () => {
  const chain = (links: number) => ['a', ...Array.from({ length: links }, (_, i) => `p${i}`)].join('.')
  assert.equal(plainRead(chain(MAX_INSPECT_LINKS)), chain(MAX_INSPECT_LINKS))
  assert.equal(plainRead(chain(MAX_INSPECT_LINKS + 1)), null)
})
