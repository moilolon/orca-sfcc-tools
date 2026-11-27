// Hover (phase 6.4) on the invented checkout: a `dw.*` member and class (the description is the
// worker's), a cartridge module and the copy each storefront runs, a module's member and where it
// is defined, `module.superModule`, an SFRA route (who declares it, in which order, which one
// serves), a template, a resource key, a custom attribute, an ISML tag; a completion item by its
// id; and nothing where nothing is known.
import { assert, test } from 'orca/testing'
import { analyse } from './analysis'
import { complete } from './complete'
import { hover, hoverItem, type Hover } from './hover'
import { CheckoutIndex } from '../checkout/checkout'
import { fixtureFiles } from '../checkout/testing'
import { at, BASE, committedDw, CORE, dwLookup, fixtureContext, fixtureText, OUTLET } from './testing'

const SCRIPT = `${BASE}/cartridge/scripts/helpers/garden.js`
const TEMPLATE = `${BASE}/cartridge/templates/default/garden/page.isml`

async function hoverAt(marked: string, path = SCRIPT): Promise<{ hover: Hover | null; text: string; offset: number }> {
  const ctx = await fixtureContext()
  const { analysis, offset, text } = at(path, marked)
  return { hover: hover(ctx, analysis, offset), text, offset }
}

function as<K extends Hover['kind']>(found: Hover | null, kind: K): Extract<Hover, { kind: K }> {
  assert.ok(found, `a hover of kind ${kind}`)
  assert.equal((found as Hover).kind, kind)
  return found as Extract<Hover, { kind: K }>
}

test('hover 1. a dw member: its signatures, deprecation, link, and the section the worker describes', async () => {
  const { hover: found, text } = await hoverAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getPro‸duct(pid);")
  const member = as(found, 'dw-member')
  assert.deepEqual(member.range, { start: text.indexOf('getProduct'), end: text.indexOf('getProduct') + 'getProduct'.length })
  assert.equal(member.classId, 'dw.catalog.ProductMgr')
  assert.deepEqual(member.members, [
    {
      kind: 'method',
      owner: 'dw.catalog.ProductMgr',
      key: 'getProduct(String)',
      signature: 'static getProduct(productID: String): Product',
      static: true,
      deprecated: false,
      link: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/b2c-script-api/dw.catalog.ProductMgr.html#getproductstring'
    }
  ])
  assert.deepEqual(member.describe, { classId: 'dw.catalog.ProductMgr', memberKey: 'getProduct(String)' })
  // Overloads together; an inherited member keeps its owner; a deprecated one says so.
  const image = as((await hoverAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(pid).getIm‸age('small');")).hover, 'dw-member')
  assert.equal(image.members.length, 3)
  const login = as((await hoverAt("var CustomerMgr = require('dw/customer/CustomerMgr');\nCustomerMgr.loginCust‸omer(a, b, c);")).hover, 'dw-member')
  assert.deepEqual(login.members.map((each) => each.deprecated), [false, true])
  const id = as((await hoverAt('request.httpParameterMap.get‸ParameterNames();')).hover, 'dw-member')
  assert.equal(id.classId, 'dw.web.HttpParameterMap')
  // A global function.
  assert.equal(as((await hoverAt('if (empt‸y(x)) {}')).hover, 'dw-member').classId, 'TopLevel.global')
})

test('hover 1. a dw class, read as the class or as a value’s type; a package', async () => {
  const cls = as((await hoverAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProduct‸Mgr.getProduct(pid);")).hover, 'dw-class')
  assert.deepEqual([cls.classId, cls.instance, cls.super, cls.deprecated], ['dw.catalog.ProductMgr', false, 'TopLevel.Object', false])
  assert.deepEqual(cls.describe, { classId: 'dw.catalog.ProductMgr' })
  assert.equal(cls.link, 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/b2c-script-api/dw.catalog.ProductMgr.html')
  const value = as((await hoverAt("var ProductMgr = require('dw/catalog/ProductMgr');\nvar product = ProductMgr.getProduct(pid);\nprod‸uct.name;")).hover, 'dw-class')
  assert.deepEqual([value.classId, value.instance], ['dw.catalog.Product', true])
  assert.equal(as((await hoverAt('var x = dw.catalog.Product‸Mgr;')).hover, 'dw-class').classId, 'dw.catalog.ProductMgr')
  const pkg = as((await hoverAt('var x = dw.cata‸log;')).hover, 'dw-package')
  assert.equal(pkg.name, 'dw.catalog')
  assert.ok(pkg.classes > 10)
  // A require of a dw class is the class.
  assert.equal(as((await hoverAt("var ProductMgr = require('dw/catalog/Product‸Mgr');")).hover, 'dw-class').classId, 'dw.catalog.ProductMgr')
})

test('hover 2. which copy of a */ module runs on each storefront, with every candidate', async () => {
  const { hover: found, text } = await hoverAt("var priceHelper = require('*/cartridge/scripts/helpers/price‸Helper');")
  const module = as(found, 'module')
  assert.deepEqual(module.range, { start: text.indexOf('*/'), end: text.indexOf("');") })
  assert.equal(module.form, 'path')
  assert.deepEqual(module.copies, [
    { storefront: 'GardenOutlet', path: `${CORE}/cartridge/scripts/helpers/priceHelper.js` },
    { storefront: 'GardenShop', path: `${CORE}/cartridge/scripts/helpers/priceHelper.js` }
  ])
  assert.deepEqual(module.candidates, [`${BASE}/cartridge/scripts/helpers/priceHelper.js`, `${CORE}/cartridge/scripts/helpers/priceHelper.js`])
  // A module the outlet alone has: the shop runs none.
  const outlet = as((await hoverAt("require('*/cartridge/scripts/outl‸et');")).hover, 'module')
  assert.deepEqual(outlet.copies, [
    { storefront: 'GardenOutlet', path: `${OUTLET}/cartridge/scripts/outlet.js` },
    { storefront: 'GardenShop', path: null }
  ])
  // A relative one: the file it names.
  const relative = as((await hoverAt("require('../util/colle‸ctions');")).hover, 'module')
  assert.deepEqual([relative.form, relative.copies], ['relative', [{ storefront: null, path: `${BASE}/cartridge/scripts/util/collections.js` }]])
  // The variable bound to it hovers as the module too.
  assert.equal(as((await hoverAt("var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\nprice‸Helper.price(p);")).hover, 'module').module, '*/cartridge/scripts/helpers/priceHelper')
})

test('hover 2. a module’s member: where each copy defines it, with its parameters and JSDoc', async () => {
  const price = as((await hoverAt("var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\npriceHelper.pri‸ce(p);")).hover, 'module-member')
  assert.deepEqual(price.definitions, [
    {
      storefronts: ['GardenOutlet', 'GardenShop'],
      path: `${CORE}/cartridge/scripts/helpers/priceHelper.js`,
      line: 11,
      kind: 'function',
      params: ['product'],
      doc: "The core price helper: the base one, with the site's currency first.\n@param {dw.catalog.Product} product - the product\n@returns {string} its price"
    }
  ])
  // A member the core copy adds to the base one through module.superModule, and one it inherits.
  const first = as((await hoverAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.fir‸st(list);")).hover, 'module-member')
  assert.deepEqual(first.definitions.map((each) => [each.path, each.line]), [[`${CORE}/cartridge/scripts/util/collections.js`, 10]])
  const map = as((await hoverAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.ma‸p(list, f);")).hover, 'module-member')
  assert.deepEqual(map.definitions.map((each) => [each.storefronts, each.path, each.line]), [[['GardenOutlet', 'GardenShop'], `${BASE}/cartridge/scripts/util/collections.js`, 6]])
  // A member nobody exports: nothing.
  assert.equal((await hoverAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.no‸ne(list);")).hover, null)
})

test('hover 3. module.superModule: the next copy after the file’s own on each storefront', async () => {
  const path = `${CORE}/cartridge/models/product.js`
  const found = as((await hoverAt(fixtureText(path).replace('module.superModule', 'module.super‸Module'), path)).hover, 'super-module')
  assert.equal(found.module, 'cartridge/models/product.js')
  assert.deepEqual(found.copies, [
    { storefront: 'GardenOutlet', path: `${BASE}/cartridge/models/product.js`, onPath: true },
    { storefront: 'GardenShop', path: `${BASE}/cartridge/models/product.js`, onPath: true }
  ])
  // The name bound to it hovers the same; a member of it, where the next copy defines it.
  const bound = as((await hoverAt(fixtureText(path).replace('base.call', 'ba‸se.call'), path)).hover, 'super-module')
  assert.deepEqual(bound.copies, found.copies)
  const helpers = `${CORE}/cartridge/scripts/util/collections.js`
  const map = as((await hoverAt('var base = module.superModule;\nbase.ma‸p(list, f);', helpers)).hover, 'module-member')
  assert.deepEqual(map.definitions.map((each) => [each.storefronts, each.path, each.line]), [[['GardenOutlet', 'GardenShop'], `${BASE}/cartridge/scripts/util/collections.js`, 6]])
})

test('hover 4. an SFRA route: its declarations per storefront, the order they run, the one that serves', async () => {
  const path = `${CORE}/cartridge/controllers/Product.js`
  const { hover: found, text } = await hoverAt(fixtureText(path).replace("server.append('Show'", "server.append('Sh‸ow'"), path)
  const route = as(found, 'route')
  assert.equal(route.id, 'Product-Show')
  assert.deepEqual(route.range, { start: text.indexOf("append('Show'") + 8, end: text.indexOf("append('Show'") + 12 })
  const shop = route.storefronts.find((each) => each.storefront === 'GardenShop')
  const outlet = route.storefronts.find((each) => each.storefront === 'GardenOutlet')
  assert.ok(shop && outlet)
  assert.equal(shop?.controller, path)
  assert.deepEqual(
    shop?.steps.map((step) => [step.method, step.cartridge, step.line]),
    [
      ['prepend', 'app_garden_core', 11],
      ['get', 'app_garden_base', 10],
      ['append', 'app_garden_core', 15]
    ]
  )
  assert.deepEqual(shop?.serves && [shop.serves.method, shop.serves.path], ['get', `${BASE}/cartridge/controllers/Product.js`])
  assert.equal(outlet?.controller, `${OUTLET}/cartridge/controllers/Product.js`)
  assert.deepEqual(outlet?.steps.map((step) => step.cartridge), ['app_garden_core', 'app_garden_base', 'app_garden_core', 'app_garden_outlet'])
  // A replace serves the request in place of the declaration.
  const tile = as((await hoverAt("var server = require('server');\nserver.replace('Ti‸le', function () {});", path)).hover, 'route')
  assert.deepEqual(tile.storefronts.map((each) => [each.storefront, each.serves?.method, each.serves?.cartridge]), [
    ['GardenOutlet', 'replace', 'app_garden_core'],
    ['GardenShop', 'replace', 'app_garden_core']
  ])
  // A route named in URLUtils.url, and a problem SFRA would raise.
  const cart = as((await hoverAt("URLUtils.url('Cart-Miss‸ing');")).hover, 'route')
  assert.deepEqual(cart.storefronts.find((each) => each.storefront === 'GardenOutlet')?.problems.map((problem) => problem.code), ['route_missing'])
  assert.deepEqual(cart.storefronts.find((each) => each.storefront === 'GardenOutlet')?.steps, [])
  // Not a controller, or not the server module: no route.
  assert.equal((await hoverAt("var server = require('server');\nserver.get('Sh‸ow', function () {});")).hover, null)
  assert.equal((await hoverAt("var router = require('garden-router');\nrouter.get('Sh‸ow', function () {});", path)).hover, null)
})

test('hover 5. a template, a resource key along each path, a custom attribute, an ISML tag', async () => {
  const template = as((await hoverAt('<isinclude template="product/components/pr‸ice" />', TEMPLATE)).hover, 'template')
  assert.deepEqual(template.copies, [
    { storefront: 'GardenOutlet', path: `${OUTLET}/cartridge/templates/default/product/components/price.isml`, locale: 'default' },
    { storefront: 'GardenShop', path: `${CORE}/cartridge/templates/default/product/components/price.isml`, locale: 'default' }
  ])
  assert.equal(template.candidates.length, 3)
  assert.equal(as((await hoverAt("res.render('home/home‸Page');")).hover, 'template').name, 'home/homePage')
  const key = as((await hoverAt("Resource.msg('label.pr‸ice', 'product', null);")).hover, 'resource')
  assert.deepEqual([key.key, key.bundle, key.candidates], ['label.price', 'product', 3])
  assert.deepEqual(key.copies.map((copy) => [copy.storefront, copy.cartridge, copy.line, copy.value]), [
    ['GardenOutlet', 'app_garden_core', 2, 'Our price'],
    ['GardenShop', 'app_garden_core', 2, 'Our price']
  ])
  // The bundle argument hovers as the key too.
  assert.equal(as((await hoverAt("Resource.msg('label.sale', 'prod‸uct', null);")).hover, 'resource').copies.find((copy) => copy.storefront === 'GardenShop')?.value, null)
  const attribute = as((await hoverAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id).custom.gardenCol‸our;")).hover, 'attribute')
  assert.deepEqual([attribute.typeId, attribute.id, attribute.type, attribute.objectKind, attribute.source, attribute.guessed, attribute.line], ['Product', 'gardenColour', 'string', 'system', 'checkout', false, 10])
  assert.equal(attribute.path, 'sites/site_template/meta/system-objecttype-extensions.xml')
  assert.equal(as((await hoverAt('function f(apiProduct) { return apiProduct.custom.garden‸Badge; }')).hover, 'attribute').guessed, true)
  assert.equal(as((await hoverAt("var Site = require('dw/system/Site');\nSite.current.getCustomPreferenceValue('gardenCur‸rency');")).hover, 'attribute').typeId, 'SitePreferences')
  const tag = as((await hoverAt('<isinclude template="components/modules" />\n<isba‸dge label="new" />', TEMPLATE)).hover, 'tag')
  assert.deepEqual([tag.name, tag.custom, tag.attributes, tag.template], ['isbadge', true, ['label', 'tone'], 'components/badge'])
  assert.deepEqual(tag.copies.map((copy) => copy.path), [`${BASE}/cartridge/templates/default/components/badge.isml`, `${BASE}/cartridge/templates/default/components/badge.isml`])
  assert.deepEqual(as((await hoverAt('<is‸if condition="${a}"></isif>', TEMPLATE)).hover, 'tag').attributes, ['condition'])
})

test('hover 6. a completion item’s id expands as the thing it names', async () => {
  const ctx = await fixtureContext()
  const { analysis, offset } = at(SCRIPT, "var collections = require('*/cartridge/scripts/util/collections');\ncollections.‸")
  for (const item of complete(ctx, analysis, offset).items) {
    const found = hoverItem(ctx, analysis, item.id)
    assert.equal(found?.kind, 'module-member', item.id)
    assert.equal(found?.range, null)
  }
  assert.equal(hoverItem(ctx, analysis, 'dw:dw.catalog.ProductMgr#getProduct(String)')?.kind, 'dw-member')
  assert.equal(hoverItem(ctx, analysis, 'dwclass:dw.catalog.Product')?.kind, 'dw-class')
  assert.equal(hoverItem(ctx, analysis, 'dwpackage:dw.catalog')?.kind, 'dw-package')
  assert.equal(hoverItem(ctx, analysis, 'custom:Product#gardenBadge')?.kind, 'attribute')
  assert.equal(hoverItem(ctx, analysis, 'key:product#label.vat')?.kind, 'resource')
  assert.equal(hoverItem(ctx, analysis, 'template:home/homePage')?.kind, 'template')
  assert.equal(hoverItem(ctx, analysis, 'module:*/cartridge/scripts/outlet')?.kind, 'module')
  assert.equal(hoverItem(ctx, analysis, 'route:Product-Show')?.kind, 'route')
  assert.equal(hoverItem(ctx, analyse(TEMPLATE, '<isinclude template="components/modules" />'), 'tag:isbadge')?.kind, 'tag')
  assert.equal(hoverItem(ctx, analysis, 'tag:isif')?.kind, 'tag')
  for (const id of ['', 'nothing', 'dw:dw.garden.None#x()', 'member:none.js#x', 'tag:isnothing', 'route:NoDash']) assert.equal(hoverItem(ctx, analysis, id), null, id)
  // Every item a dw class offers expands: static properties (`Site.current`) and listed constants too.
  for (const marked of ["var Site = require('dw/system/Site');\nSite.‸", 'dw.system.Site.‸', "var Status = require('dw/system/Status');\nStatus.‸"]) {
    const asked = at(SCRIPT, marked)
    const items = complete(ctx, asked.analysis, asked.offset).items
    assert.ok(items.length > 0, marked)
    for (const item of items) assert.equal(hoverItem(ctx, asked.analysis, item.id)?.kind, 'dw-member', `${marked}: ${item.id}`)
  }
  // The hover of a static property at its place, too.
  assert.equal(as((await hoverAt("var Site = require('dw/system/Site');\nSite.curr‸ent.ID;")).hover, 'dw-member').members[0].owner, 'dw.system.Site')
})

test('hover 4. with no storefront path, a route says what each cartridge’s controller declares', async () => {
  const files = fixtureFiles()
  files.delete('sites')
  const index = new CheckoutIndex(files, { dw: dwLookup })
  await index.build()
  const ctx = { index, dw: committedDw() }
  const { analysis, offset } = at(SCRIPT, "URLUtils.url('Product-Sh‸ow');")
  const route = as(hover(ctx, analysis, offset), 'route')
  assert.deepEqual(route.storefronts, [])
  assert.deepEqual(
    route.cartridges.map((each) => [each.cartridge, each.steps.map((step) => [step.method, step.line])]),
    [
      ['app_garden_base', [['get', 10]]],
      ['app_garden_core', [['prepend', 11], ['append', 15]]],
      ['app_garden_outlet', [['append', 10]]]
    ]
  )
  const none = at(SCRIPT, "URLUtils.url('Product-No‸ne');")
  assert.equal(hover(ctx, none.analysis, none.offset), null)
})

test('hover 7. module.superModule of a shadowed module, and a Resource bound to a module, are not the platform’s', async () => {
  assert.equal((await hoverAt('function f(module) { return module.super‸Module; }', `${CORE}/cartridge/models/product.js`)).hover, null)
  assert.equal((await hoverAt("var Resource = require('*/cartridge/scripts/helpers/priceHelper');\nResource.msg('label.pr‸ice');")).hover, null)
})

test('hover 7. when in doubt, nothing: unknown values, a guessed name off the list, plain text', async () => {
  for (const marked of ['garden.pro‸duct', 'pdict.pro‸duct', 'function f(item) { return item.custom.col‸our; }', "var a = 'te‸xt';", '// Product‸Mgr', 'var x = 1‸;']) {
    assert.equal((await hoverAt(marked)).hover, null, marked)
  }
  assert.equal((await hoverAt('<div class="pr‸ice"></div>', TEMPLATE)).hover, null)
  assert.equal((await hoverAt('<p>Some te‸xt</p>', TEMPLATE)).hover, null)
})
