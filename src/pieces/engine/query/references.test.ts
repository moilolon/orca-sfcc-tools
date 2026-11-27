// References (phase 6.4) of a function a cartridge script exports, across every storefront's
// cartridge path, on the invented checkout: asked on the export, on the function it names, or on
// a read of it; each read labelled with the storefronts that reach the function; nothing for
// what is not an exported function.
import { assert, test } from 'orca/testing'
import { references, type References } from './references'
import { at, BASE, CORE, fixtureContext, fixtureText } from './testing'

const SCRIPT = `${BASE}/cartridge/scripts/helpers/garden.js`
const SHOPS = ['GardenOutlet', 'GardenShop']

async function referencesAt(marked: string, path = SCRIPT): Promise<{ found: References | null; text: string }> {
  const ctx = await fixtureContext()
  const { analysis, offset, text } = at(path, marked)
  return { found: references(ctx, analysis, offset), text }
}

const rows = (found: References | null) => (found?.references ?? []).map((each) => [each.kind, each.path, each.line, each.storefronts])

test('references 6. of the base price helper: its export, its declaration, and the core copy that calls it through module.superModule', async () => {
  const path = `${BASE}/cartridge/scripts/helpers/priceHelper.js`
  const text = fixtureText(path)
  const { found } = await referencesAt(text.replace('price: price', 'pri‸ce: price'), path)
  assert.equal(found?.name, 'price')
  assert.deepEqual(found?.defining, [path])
  assert.deepEqual(found?.range, { start: text.indexOf('price: price'), end: text.indexOf('price: price') + 5 })
  assert.deepEqual(rows(found), [
    ['definition', path, 15, null],
    ['definition', path, 10, null],
    ['use', `${CORE}/cartridge/scripts/helpers/priceHelper.js`, 12, SHOPS]
  ])
  // The same asked on the function's declaration.
  assert.deepEqual(rows((await referencesAt(text.replace('function price(', 'function pri‸ce('), path)).found), rows(found))
  // The base controller's `priceHelper.price` reaches the core copy on both storefronts, not this one.
  assert.ok(!rows(found).some((row) => String(row[1]).endsWith('controllers/Product.js')))
})

test('references 6. of the core copy, asked on a read: every read whose require reaches it, with the storefronts', async () => {
  const { found, text } = await referencesAt("var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\npriceHelper.pri‸ce(p);\nrequire('*/cartridge/scripts/helpers/priceHelper').price(q);")
  const core = `${CORE}/cartridge/scripts/helpers/priceHelper.js`
  assert.deepEqual(found?.defining, [core])
  assert.deepEqual(rows(found), [
    ['definition', core, 16, null],
    ['definition', core, 11, null],
    ['use', SCRIPT, 2, SHOPS],
    ['use', SCRIPT, 3, SHOPS],
    ['use', `${BASE}/cartridge/controllers/Product.js`, 13, SHOPS]
  ])
  // Positions in the text asked on.
  assert.deepEqual(found?.references.filter((each) => each.path === SCRIPT).map((each) => text.slice(each.start, each.end)), ['price', 'price'])
  assert.equal(found?.truncated, false)
})

test('references 6. reads through ~/, a relative path and a destructured name; a module only one storefront has', async () => {
  const collections = `${BASE}/cartridge/scripts/util/collections.js`
  const { found } = await referencesAt("var { map } = require('~/cartridge/scripts/util/collections');\nma‸p(list, f);")
  assert.deepEqual(found?.defining, [collections])
  assert.deepEqual(rows(found), [
    ['definition', collections, 6, null],
    ['use', SCRIPT, 2, null],
    ['use', `${BASE}/cartridge/controllers/Product.js`, 18, null],
    ['use', `${BASE}/cartridge/scripts/helpers/priceHelper.js`, 11, null]
  ])
  const outlet = (await referencesAt("var outlet = require('*/cartridge/scripts/outlet');\noutlet.disc‸ount();")).found
  assert.deepEqual(rows(outlet).filter((row) => row[0] === 'use'), [['use', SCRIPT, 2, ['GardenOutlet']]])
})

test('references 6. when in doubt, nothing: a dw method, a local function, an unknown value, a member nobody exports', async () => {
  for (const marked of [
    "var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getPro‸duct(x);",
    'function local() {}\nloc‸al();',
    'garden.pri‸ce(x);',
    "var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\npriceHelper.no‸ne();"
  ]) {
    assert.equal((await referencesAt(marked)).found, null, marked)
  }
  // An exported value that is no function still has references; one not exported has none.
  const path = `${BASE}/cartridge/scripts/helpers/other.js`
  assert.equal((await referencesAt('function hid‸den() {}\nmodule.exports = {};', path)).found, null)
  const own = (await referencesAt('function sho‸wn() {}\nmodule.exports = { shown: shown };', path)).found
  assert.deepEqual(rows(own), [
    ['definition', path, 2, null],
    ['definition', path, 1, null]
  ])
})
