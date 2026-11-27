// Go to definition (phase 6.4) on the invented checkout: template names, `require()`, resource
// keys, members of a cartridge module along each path and `module.superModule`, routes, custom
// attributes, custom tags and local declarations; one place per copy, each labelled with the
// storefronts it serves; positions in the text asked on and in the file reached.
import { assert, test } from 'orca/testing'
import { CheckoutIndex } from '../checkout/checkout'
import { fixtureFiles } from '../checkout/testing'
import { definition, type Definition, type Target } from './definition'
import { at, BASE, committedDw, CORE, dwLookup, fixtureContext, fixtureText, OUTLET } from './testing'

const SCRIPT = `${BASE}/cartridge/scripts/helpers/garden.js`
const TEMPLATE = `${BASE}/cartridge/templates/default/garden/page.isml`
const SHOPS = ['GardenOutlet', 'GardenShop']

async function definitionAt(marked: string, path = SCRIPT): Promise<{ found: Definition | null; text: string }> {
  const ctx = await fixtureContext()
  const { analysis, offset, text } = at(path, marked)
  return { found: definition(ctx, analysis, offset), text }
}

/** The place of `snippet` in a fixture file: its range and line. */
function placeOf(path: string, around: string, name = around): Pick<Target, 'path' | 'start' | 'end' | 'line'> {
  const text = fixtureText(path)
  const found = text.indexOf(around)
  const start = found + around.indexOf(name)
  assert.ok(found !== -1, `${around} in ${path}`)
  return { path, start, end: start + name.length, line: text.slice(0, start).split('\n').length }
}

const file = (path: string, storefronts: string[] | null): Target => ({ path, start: 0, end: 0, line: 1, storefronts })

test('definition 5. a template name goes to the copy each storefront renders, in a tag or a call', async () => {
  const { found, text } = await definitionAt('<isinclude template="product/components/pr‸ice" />', TEMPLATE)
  assert.equal(found?.kind, 'template')
  assert.deepEqual(found?.range, { start: text.indexOf('product/'), end: text.indexOf('" />') })
  assert.deepEqual(found?.targets, [
    file(`${OUTLET}/cartridge/templates/default/product/components/price.isml`, ['GardenOutlet']),
    file(`${CORE}/cartridge/templates/default/product/components/price.isml`, ['GardenShop'])
  ])
  for (const marked of ["res.render('home/home‸Page');", "var ISML = require('dw/template/ISML');\nISML.renderTemplate('home/home‸Page');", "var Template = require('dw/util/Template');\nnew Template('home/home‸Page');"]) {
    assert.deepEqual((await definitionAt(marked)).found?.targets, [file(`${BASE}/cartridge/templates/default/home/homePage.isml`, SHOPS)], marked)
  }
  // A custom tag goes to the template of its <ismodule>.
  const tag = (await definitionAt('<isinclude template="components/modules" />\n<isba‸dge label="new" />', TEMPLATE)).found
  assert.deepEqual([tag?.kind, tag?.targets], ['tag', [file(`${BASE}/cartridge/templates/default/components/badge.isml`, SHOPS)]])
  // A template no cartridge has: nothing.
  assert.equal((await definitionAt("res.render('product/quick‸View');")).found, null)
})

test('definition 5. require() goes to the file each storefront loads; a relative one to the file it names', async () => {
  const { found, text } = await definitionAt("var priceHelper = require('*/cartridge/scripts/helpers/price‸Helper');")
  assert.equal(found?.kind, 'module')
  assert.deepEqual(found?.range, { start: text.indexOf('*/'), end: text.indexOf("');") })
  assert.deepEqual(found?.targets, [file(`${CORE}/cartridge/scripts/helpers/priceHelper.js`, SHOPS)])
  assert.deepEqual((await definitionAt("require('*/cartridge/scripts/outl‸et');")).found?.targets, [file(`${OUTLET}/cartridge/scripts/outlet.js`, ['GardenOutlet'])])
  assert.deepEqual((await definitionAt("require('../util/colle‸ctions');")).found?.targets, [file(`${BASE}/cartridge/scripts/util/collections.js`, null)])
  assert.deepEqual((await definitionAt("require('ser‸ver');")).found?.targets, [file('modules/server.js', null)])
  // A dw module, or one the checkout lacks: nowhere to go.
  assert.equal((await definitionAt("require('dw/catalog/Product‸Mgr');")).found, null)
  assert.equal((await definitionAt("require('*/cartridge/scripts/helpers/cart‸Helper');")).found, null)
})

test('definition 5. a Resource.msg key goes to its line in the bundle each storefront reads', async () => {
  const price = (await definitionAt("Resource.msg('label.pr‸ice', 'product', null);")).found
  assert.equal(price?.kind, 'resource')
  assert.deepEqual(price?.targets, [{ ...placeOf(`${CORE}/cartridge/templates/resources/product.properties`, 'label.price'), storefronts: SHOPS }])
  // A key only one storefront has.
  const sale = (await definitionAt("<span>${Resource.msg('label.sa‸le', 'product', null)}</span>", TEMPLATE)).found
  assert.deepEqual(sale?.targets, [{ ...placeOf(`${OUTLET}/cartridge/templates/resources/product.properties`, 'label.sale'), storefronts: ['GardenOutlet'] }])
  assert.equal((await definitionAt("Resource.msg('label.no‸ne', 'product', null);")).found, null)
})

test('definition 5. a module’s member goes to its declaration in each copy, along the path and module.superModule', async () => {
  const price = (await definitionAt("var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\npriceHelper.pri‸ce(p);")).found
  assert.equal(price?.kind, 'member')
  assert.deepEqual(price?.targets, [{ ...placeOf(`${CORE}/cartridge/scripts/helpers/priceHelper.js`, 'function price', 'price'), storefronts: SHOPS }])
  // Declared in the base file: the core copy only adds `first` to it.
  const map = (await definitionAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.ma‸p(list, f);")).found
  assert.deepEqual(map?.targets, [{ ...placeOf(`${BASE}/cartridge/scripts/util/collections.js`, 'map:', 'map'), storefronts: SHOPS }])
  const first = (await definitionAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.fir‸st(list);")).found
  assert.deepEqual(first?.targets, [{ ...placeOf(`${CORE}/cartridge/scripts/util/collections.js`, 'base.first', 'first'), storefronts: SHOPS }])
  // Through module.superModule, and module.superModule itself.
  const core = `${CORE}/cartridge/scripts/helpers/priceHelper.js`
  const base = (await definitionAt(fixtureText(core).replace('base.price(product)', 'base.pri‸ce(product)'), core)).found
  assert.deepEqual(base?.targets, [{ ...placeOf(`${BASE}/cartridge/scripts/helpers/priceHelper.js`, 'function price', 'price'), storefronts: SHOPS }])
  const superModule = (await definitionAt(fixtureText(core).replace('module.superModule', 'module.super‸Module'), core)).found
  assert.deepEqual([superModule?.kind, superModule?.targets], ['super-module', [file(`${BASE}/cartridge/scripts/helpers/priceHelper.js`, SHOPS)]])
  // A destructured member reads as the member.
  assert.equal((await definitionAt("var { price } = require('*/cartridge/scripts/helpers/priceHelper');\npri‸ce(p);")).found?.kind, 'declaration')
})

test('definition 5. a route goes to the declaration that serves it on each storefront; a custom attribute to its metadata', async () => {
  const route = (await definitionAt("URLUtils.url('Product-Sh‸ow');")).found
  assert.deepEqual([route?.kind, route?.targets], ['route', [{ ...placeOf(`${BASE}/cartridge/controllers/Product.js`, "get('Show'", 'Show'), storefronts: SHOPS }]])
  const controller = `${CORE}/cartridge/controllers/Product.js`
  const tile = (await definitionAt(fixtureText(controller).replace("server.prepend('Show'", "server.prepend('Sh‸ow'"), controller)).found
  assert.deepEqual(tile?.targets, [{ ...placeOf(`${BASE}/cartridge/controllers/Product.js`, "get('Show'", 'Show'), storefronts: SHOPS }])
  const replaced = (await definitionAt("URLUtils.url('Product-Ti‸le');")).found
  assert.deepEqual(replaced?.targets, [{ ...placeOf(controller, "replace('Tile'", 'Tile'), storefronts: SHOPS }])
  const attribute = (await definitionAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id).custom.gardenCol‸our;")).found
  const meta = 'sites/site_template/meta/system-objecttype-extensions.xml'
  assert.deepEqual([attribute?.kind, attribute?.targets], ['attribute', [{ ...placeOf(meta, 'gardenColour'), storefronts: null }]])
  assert.deepEqual((await definitionAt("var Site = require('dw/system/Site');\nSite.current.getCustomPreferenceValue('gardenCur‸rency');")).found?.targets, [{ ...placeOf(meta, 'gardenCurrency'), storefronts: null }])
})

test('definition 5. with no storefront path, a route goes to every cartridge’s declaration of it', async () => {
  const files = fixtureFiles()
  files.delete('sites')
  const index = new CheckoutIndex(files, { dw: dwLookup })
  await index.build()
  const { analysis, offset } = at(SCRIPT, "URLUtils.url('Product-Ti‸le');")
  const found = definition({ index, dw: committedDw() }, analysis, offset)
  assert.deepEqual(found?.targets, [
    { ...placeOf(`${BASE}/cartridge/controllers/Product.js`, "get('Tile'", 'Tile'), storefronts: null },
    { ...placeOf(`${CORE}/cartridge/controllers/Product.js`, "replace('Tile'", 'Tile'), storefronts: null }
  ])
})

test('definition 5. a name goes to its declaration in the file; when in doubt, nothing', async () => {
  const { found, text } = await definitionAt('var total = 0;\nfunction add(n) {\n    total = total + n;\n    return to‸tal;\n}')
  assert.deepEqual(found, { kind: 'declaration', range: { start: text.lastIndexOf('total'), end: text.lastIndexOf('total') + 5 }, targets: [{ path: SCRIPT, start: 4, end: 9, line: 1, storefronts: null }] })
  const param = (await definitionAt('function add(n) {\n    return n‸ + 1;\n}')).found
  assert.deepEqual(param?.targets, [{ path: SCRIPT, start: 13, end: 14, line: 1, storefronts: null }])
  // In a template: a name of an isscript, an isset.
  const isset = (await definitionAt('<isset name="label" value="${1}" scope="page" />\n<span>${lab‸el}</span>', TEMPLATE)).found
  assert.deepEqual(isset?.targets.map((each) => [each.start, each.line]), [[13, 1]])
  for (const marked of ['garden.pro‸duct', 'pdict.pro‸duct', 'unknownGlobal‸', 'function f(module) { return module.super‸Module; }', 'var product = { custom: {} };\nproduct.custom.garden‸Colour;', "var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getPro‸duct(x);", '// a comm‸ent']) {
    assert.equal((await definitionAt(marked)).found, null, marked)
  }
})
