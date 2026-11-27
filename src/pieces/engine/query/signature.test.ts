// Signature help (phase 6.4) on the invented checkout: a `dw.*` method of a known type with its
// overloads, a `dw.*` constructor, a cartridge module's function along each path, a model's
// constructor, a function of the file; the active parameter; and nothing outside a call the
// engine knows.
import { assert, test } from 'orca/testing'
import { signatureHelp, type SignatureHelp } from './signature'
import { at, BASE, CORE, fixtureContext } from './testing'

const SCRIPT = `${BASE}/cartridge/scripts/helpers/garden.js`
const TEMPLATE = `${BASE}/cartridge/templates/default/garden/page.isml`

async function helpAt(marked: string, path = SCRIPT): Promise<{ found: SignatureHelp | null; text: string; offset: number }> {
  const ctx = await fixtureContext()
  const { analysis, offset, text } = at(path, marked)
  return { found: signatureHelp(ctx, analysis, offset), text, offset }
}

const labels = (found: SignatureHelp | null) => (found?.signatures ?? []).map((each) => each.label)

test('signature 7. a dw method of a known type: its overloads, the one that fits, the active parameter', async () => {
  const { found, text, offset } = await helpAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(‸);")
  assert.deepEqual(labels(found), ['static getProduct(productID: String): Product'])
  assert.deepEqual(found?.signatures[0].parameters, [{ label: 'productID', type: 'String' }])
  assert.deepEqual([found?.activeSignature, found?.activeParameter], [0, 0])
  assert.deepEqual(found?.range, { start: offset, end: text.lastIndexOf(');') })
  assert.equal(found?.signatures[0].source, 'dw')
  assert.deepEqual(found?.signatures[0].describe, { classId: 'dw.catalog.ProductMgr', memberKey: 'getProduct(String)' })
  assert.match(found?.signatures[0].link ?? '', /dw\.catalog\.ProductMgr\.html#getproductstring$/)
  const image = (await helpAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id).getImage('small', ‸);")).found
  assert.equal(image?.signatures.length, 3)
  assert.equal(image?.activeParameter, 1)
  assert.equal(image?.signatures[image.activeSignature].parameters.length, 2)
  // Unclosed, with white space after the comma.
  const open = (await helpAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id).getImage('small',  ‸")).found
  assert.equal(open?.activeParameter, 1)
  // A global function, a constructor of a dw class.
  assert.deepEqual(labels((await helpAt('if (empty(‸)) {}')).found), ['static empty(obj: Object): Boolean'])
  const list = (await helpAt("var ArrayList = require('dw/util/ArrayList');\nvar list = new ArrayList(‸);")).found
  assert.ok(labels(list).includes('ArrayList()'))
  assert.ok(list && list.signatures.every((each) => each.source === 'dw'))
  // In a template.
  assert.ok(labels((await helpAt('<a href="${URLUtils.url(‸)}">', TEMPLATE)).found).some((label) => label.startsWith('static url(')))
})

test('signature 7. a cartridge function: the copy each storefront reaches, with where it is declared and its JSDoc', async () => {
  const price = (await helpAt("var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\npriceHelper.price(‸);")).found
  assert.deepEqual(price?.signatures.map((each) => [each.label, each.source, each.path, each.line, each.storefronts]), [
    ['price(product)', 'module', `${CORE}/cartridge/scripts/helpers/priceHelper.js`, 11, ['GardenOutlet', 'GardenShop']]
  ])
  assert.match(price?.signatures[0].doc ?? '', /^The core price helper/)
  const map = (await helpAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.map(list, ‸);")).found
  assert.deepEqual([labels(map), map?.activeParameter], [['map(list, callback)'], 1])
  // A model's constructor: the module itself is the function.
  const model = (await helpAt("var Product = require('*/cartridge/models/product');\nvar product = new Product(‸);")).found
  assert.deepEqual(model?.signatures.map((each) => [each.label, each.path, each.line]), [['Product(apiProduct)', `${CORE}/cartridge/models/product.js`, 14]])
  // A function of the file.
  const local = (await helpAt('/** Adds two numbers. */\nfunction add(a, b) { return a + b; }\nadd(1, ‸);')).found
  assert.deepEqual([labels(local), local?.activeParameter, local?.signatures[0].source, local?.signatures[0].doc, local?.signatures[0].line], [['add(a, b)'], 1, 'local', 'Adds two numbers.', 2])
})

test('signature 7. the call around the offset is the innermost; nothing in a function written as an argument, or for an unknown callee', async () => {
  const nested = (await helpAt("var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\nvar ProductMgr = require('dw/catalog/ProductMgr');\npriceHelper.price(ProductMgr.getProduct(‸));")).found
  assert.deepEqual(labels(nested), ['static getProduct(productID: String): Product'])
  const outer = (await helpAt("var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\nvar ProductMgr = require('dw/catalog/ProductMgr');\npriceHelper.price(ProductMgr.getProduct(id)‸);")).found
  assert.deepEqual(labels(outer), ['price(product)'])
  for (const marked of [
    "var server = require('server');\nserver.get('Show', function (req, res, next) {\n    ‸\n});",
    'unknown(‸);',
    'garden.helper(‸);',
    "var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct‸(id);",
    "var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id);‸",
    'var f = function () {};\nf = other;\nf(‸);',
    'function g(a) {}\nvar g = 1;\ng(‸);'
  ]) {
    assert.equal((await helpAt(marked)).found, null, marked)
  }
})
