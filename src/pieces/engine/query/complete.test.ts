// Completion (phase 6.4) on the invented checkout: ISML tags and their attributes (custom tags
// included), template paths, members of `dw.*`, custom attributes and site preferences, members
// of a cartridge module, resource keys and bundles; the range each answer replaces; the bound;
// and, when in doubt, nothing.
import { assert, test } from 'orca/testing'
import { CheckoutIndex } from '../checkout/checkout'
import { fixtureFiles } from '../checkout/testing'
import { complete, MAX_COMPLETION_ITEMS, type Completion } from './complete'
import { at, BASE, committedDw, dwLookup, fixtureContext } from './testing'

const SCRIPT = `${BASE}/cartridge/scripts/helpers/garden.js`
const TEMPLATE = `${BASE}/cartridge/templates/default/garden/page.isml`

async function completeAt(marked: string, path = SCRIPT): Promise<Completion & { text: string; offset: number }> {
  const ctx = await fixtureContext()
  const { analysis, offset, text } = at(path, marked)
  return { ...complete(ctx, analysis, offset), text, offset }
}

const labels = (completion: Completion) => completion.items.map((item) => item.label)

test('complete 1. ISML tags after <, with the custom tags of the template and of the modules it includes', async () => {
  const bare = await completeAt('<div>\n    <is‸\n</div>', TEMPLATE)
  assert.equal(bare.context, 'tag')
  assert.ok(labels(bare).includes('isif') && labels(bare).includes('isinclude') && labels(bare).includes('isscript'))
  assert.ok(!labels(bare).includes('isbadge'), 'no custom tag without the modules template')
  // The replaced range is the name typed.
  assert.deepEqual(bare.range, { start: bare.text.indexOf('<is') + 1, end: bare.text.indexOf('<is') + 3 })
  const custom = await completeAt('<isinclude template="components/modules" />\n<isb‸', TEMPLATE)
  assert.deepEqual(labels(custom), ['isbadge', 'isbreak'])
  assert.equal(custom.items[0].detail, 'components/badge')
  assert.equal(custom.items[0].id, 'tag:isbadge')
  const own = await completeAt('<ismodule template="components/tile" name="tile" attribute="product" />\n<ist‸', TEMPLATE)
  assert.deepEqual(labels(own), ['istile'])
  const narrow = await completeAt('<isl‸', TEMPLATE)
  assert.deepEqual(labels(narrow), ['isloop'])
  assert.equal(narrow.items[0].detail, 'items, iterator, alias, var, status, begin, end, step')
  // An HTML tag is no ISML one.
  assert.deepEqual(labels(await completeAt('<di‸', TEMPLATE)), [])
})

test('complete 1. an ISML tag’s attributes, those written left out; a custom tag’s from its <ismodule>', async () => {
  const loop = await completeAt('<isloop items="${pdict.items}" ‸>', TEMPLATE)
  assert.equal(loop.context, 'tag-attribute')
  assert.deepEqual(labels(loop), ['iterator', 'alias', 'var', 'status', 'begin', 'end', 'step'])
  assert.deepEqual(loop.range, { start: loop.offset, end: loop.offset })
  const typed = await completeAt('<isprint value="${x}" enc‸ />', TEMPLATE)
  assert.deepEqual(labels(typed), ['encoding'])
  assert.deepEqual(typed.range, { start: typed.text.indexOf('enc'), end: typed.text.indexOf('enc') + 3 })
  const badge = await completeAt('<isinclude template="components/modules" />\n<isbadge label="new" ‸/>', TEMPLATE)
  assert.deepEqual(labels(badge), ['tone'])
  // An HTML element's attributes are not the engine's; after the `>` is content.
  assert.deepEqual(labels(await completeAt('<div ‸>', TEMPLATE)), [])
  assert.equal((await completeAt('<isif condition="${a}">‸</isif>', TEMPLATE)).context, 'none')
})

test('complete 2. template paths in template="…", res.render, ISML.renderTemplate and new Template, the range the whole value', async () => {
  const include = await completeAt('<isinclude template="product/‸" />', TEMPLATE)
  assert.equal(include.context, 'template')
  assert.deepEqual(labels(include), ['product/components/price', 'product/productDetails'])
  assert.equal(include.items[0].detail, 'app_garden_base, app_garden_core, app_garden_outlet')
  assert.deepEqual(include.range, { start: include.text.indexOf('product/'), end: include.text.indexOf('product/') + 'product/'.length })
  assert.deepEqual(labels(await completeAt('<isdecorate template="home/‸">', TEMPLATE)), ['home/homePage'])
  assert.deepEqual(labels(await completeAt("res.render('home/‸');")), ['home/homePage'])
  assert.deepEqual(labels(await completeAt("var ISML = require('dw/template/ISML');\nISML.renderTemplate('components/‸', {});")), ['components/badge', 'components/modules'])
  assert.deepEqual(labels(await completeAt("var Template = require('dw/util/Template');\nnew Template('home/h‸');")), ['home/homePage'])
  const slash = await completeAt('<isinclude template="/home/‸" />', TEMPLATE)
  assert.deepEqual(labels(slash), ['/home/homePage'])
  // A template value that is an expression is not a path.
  assert.equal((await completeAt('<isinclude template="${pdict.tpl‸}" />', TEMPLATE)).context, 'none')
})

test('complete 3. members of a dw class: statics off the class, the rest off an instance, overloads as one item', async () => {
  const mgr = await completeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.‸")
  assert.equal(mgr.context, 'member')
  assert.deepEqual(labels(mgr), ['getProduct', 'queryAllSiteProducts', 'queryAllSiteProductsSorted', 'queryProductsInCatalog', 'queryProductsInCatalogSorted'])
  assert.equal(mgr.items[0].detail, 'static getProduct(productID: String): Product')
  assert.equal(mgr.items[0].kind, 'method')
  assert.equal(mgr.items[0].id, 'dw:dw.catalog.ProductMgr#getProduct(String)')
  assert.deepEqual(mgr.range, { start: mgr.offset, end: mgr.offset })
  const chain = await completeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(pid).getVar‸iationModel();")
  assert.deepEqual(labels(chain), ['getVariants', 'getVariationGroups', 'getVariationModel'])
  // The word around the cursor is replaced whole.
  assert.deepEqual(chain.range, { start: chain.text.indexOf('getVar'), end: chain.text.indexOf('getVariationModel') + 'getVariationModel'.length })
  const instance = await completeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nvar product = ProductMgr.getProduct(pid);\nproduct.‸\nnext();")
  assert.ok(labels(instance).includes('ID') && labels(instance).includes('getVariationModel') && labels(instance).includes('custom'))
  assert.ok(!labels(instance).includes('getProduct'), 'no static of another class')
  assert.ok(instance.items.find((item) => item.label === 'ID')?.detail?.startsWith('ID: String'))
  const overloads = await completeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(pid).getImage‸")
  assert.deepEqual(labels(overloads), ['getImage', 'getImages'])
  assert.match(overloads.items[0].detail ?? '', /^getImage\(viewtype: String\): MediaFile \(\+2\)$/)
  // Packages and classes under dw.
  const packages = await completeAt('var x = dw.cat‸')
  assert.deepEqual(labels(packages), ['catalog'])
  assert.equal(packages.items[0].kind, 'package')
  assert.ok(labels(await completeAt('var x = dw.catalog.ProductM‸')).includes('ProductMgr'))
  // Constants the index lists as properties (an upper-case name with no getter), off the class.
  const status = await completeAt("var Status = require('dw/system/Status');\nreturn new Status(Status.‸ERROR);")
  assert.deepEqual(labels(status), ['ERROR', 'OK'])
  assert.ok(!labels(await completeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id).‸")).includes('ERROR'))
  // A global's members, and a static property read off its class.
  assert.ok(labels(await completeAt('request.httpParameterMap.‸')).includes('getParameterNames'))
  const site = await completeAt("var Site = require('dw/system/Site');\nSite.cur‸")
  assert.deepEqual(labels(site), ['current'])
  // A template sees URLUtils without a require.
  assert.ok(labels(await completeAt('<a href="${URLUtils.‸}">', TEMPLATE)).includes('url'))
  // A deprecated member is marked and listed last.
  const customer = await completeAt('var CustomerMgr = require(\'dw/customer/CustomerMgr\');\nCustomerMgr.login‸')
  assert.deepEqual(labels(customer), ['loginCustomer', 'loginExternallyAuthenticatedCustomer'])
})

test('complete 4. x.custom: the metadata’s attributes of x’s type; site preferences; a custom object by its type id', async () => {
  const typed = await completeAt('/** @param {dw.catalog.Product} product - the product */\nfunction label(product) {\n    return product.custom.‸;\n}')
  assert.equal(typed.context, 'custom')
  assert.deepEqual(labels(typed), ['gardenBadge', 'gardenColour'])
  assert.deepEqual(typed.items.map((item) => [item.kind, item.detail, item.id]), [
    ['custom-attribute', 'enum-of-string', 'custom:Product#gardenBadge'],
    ['custom-attribute', 'string', 'custom:Product#gardenColour']
  ])
  assert.equal(typed.guessed, false)
  const chain = await completeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id).custom.garden‸")
  assert.deepEqual(labels(chain), ['gardenBadge', 'gardenColour'])
  const preferences = await completeAt("var Site = require('dw/system/Site');\nSite.current.preferences.custom.‸")
  assert.equal(preferences.context, 'site-preference')
  assert.deepEqual(labels(preferences), ['gardenCurrency', 'gardenShowBadges'])
  const value = await completeAt("var Site = require('dw/system/Site');\nSite.getCurrent().getCustomPreferenceValue('garden‸');")
  assert.deepEqual(labels(value), ['gardenCurrency', 'gardenShowBadges'])
  assert.deepEqual(value.range, { start: value.text.indexOf("'garden") + 1, end: value.text.indexOf("'garden") + 7 })
  const wishlist = await completeAt("var CustomObjectMgr = require('dw/object/CustomObjectMgr');\nvar list = CustomObjectMgr.getCustomObject('GardenWishlist', id);\nlist.custom.‸")
  assert.deepEqual(labels(wishlist), ['items'])
})

test('complete 4. a name guessed for name.custom only from the short list, said so; when in doubt, nothing', async () => {
  const guessed = await completeAt('function f(apiProduct) {\n    return apiProduct.custom.‸;\n}')
  assert.deepEqual(labels(guessed), ['gardenBadge', 'gardenColour'])
  assert.equal(guessed.guessed, true)
  // A name not on the list, a name whose value is the project's, a customer (no custom attributes).
  assert.deepEqual(labels(await completeAt('function f(item) {\n    return item.custom.‸;\n}')), [])
  assert.deepEqual(labels(await completeAt("var Product = require('*/cartridge/models/product');\nvar product = new Product(x);\nproduct.custom.‸")), [])
  assert.deepEqual(labels(await completeAt('function f(customer) {\n    return customer.custom.‸;\n}')), [])
  // A known type that has no custom attributes: nothing, even with a listed name.
  assert.deepEqual(labels(await completeAt("var order = 'text';\norder.custom.‸")), [])
  // A value known not to be the platform's: an object, a literal, a function.
  assert.deepEqual(labels(await completeAt('var product = { custom: {} };\nproduct.custom.‸')), [])
  assert.deepEqual(labels(await completeAt("var order = helpers.find();\norder = 'none';\norder.custom.‸")), [])
  // A value read from elsewhere still may be guessed.
  assert.deepEqual(labels(await completeAt('var product = helpers.find();\nproduct.custom.garden‸')), ['gardenBadge', 'gardenColour'])
  // A template's pdict is unknown: no guess through a property.
  assert.deepEqual(labels(await completeAt('<div>${pdict.product.custom.‸}</div>', TEMPLATE)), [])
  // The customer's profile is typed through the global: its attributes (none in the metadata).
  const profile = await completeAt('customer.profile.custom.‸')
  assert.equal(profile.context, 'custom')
  assert.deepEqual(labels(profile), [])
})

test('complete 5. members of a cartridge module, along each storefront’s path and module.superModule', async () => {
  const collections = await completeAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.‸")
  assert.deepEqual(
    collections.items.map((item) => [item.label, item.kind, item.detail, item.id]),
    [
      ['first', 'function', 'first(list)', `member:cartridges/app_garden_core/cartridge/scripts/util/collections.js#first`],
      ['map', 'function', 'map(list, callback)', `member:${BASE}/cartridge/scripts/util/collections.js#map`]
    ]
  )
  // `~/` reaches the file's own cartridge: base has no `first`.
  assert.deepEqual(labels(await completeAt("var collections = require('~/cartridge/scripts/util/collections');\ncollections.‸")), ['map'])
  assert.deepEqual(labels(await completeAt("var helper = require('*/cartridge/scripts/helpers/priceHelper');\nhelper.p‸")), ['price'])
  // A member that is itself a module function: its return value's members, from its @returns.
  assert.ok(labels(await completeAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.first(list).‸")).includes('getVariationModel'))
  // A name bound to module.superModule: the next copy's members.
  const core = 'cartridges/app_garden_core/cartridge/scripts/util/collections.js'
  assert.deepEqual(labels(await completeAt('var base = module.superModule;\nbase.‸', core)), ['map'])
  assert.deepEqual(labels(await completeAt('module.superModule.m‸', core)), ['map'])
  // A module the checkout lacks: nothing.
  assert.deepEqual(labels(await completeAt("var helper = require('*/cartridge/scripts/helpers/cartHelper');\nhelper.‸")), [])
})

test('complete 6. resource keys and bundles inside Resource.msg and msgf, in scripts and templates', async () => {
  const keys = await completeAt("Resource.msg('label.‸', 'product', null);")
  assert.equal(keys.context, 'resource-key')
  assert.deepEqual(
    keys.items.map((item) => [item.label, item.detail, item.id]),
    [
      ['label.long', 'A long text that goes on over two lines', 'key:product#label.long'],
      ['label.price', 'Price', 'key:product#label.price'],
      ['label.sale', 'Outlet price', 'key:product#label.sale'],
      ['label.stock', 'Only {0} left', 'key:product#label.stock'],
      ['label.vat', 'VAT included', 'key:product#label.vat']
    ]
  )
  assert.deepEqual(keys.range, { start: keys.text.indexOf('label.'), end: keys.text.indexOf('label.') + 'label.'.length })
  // No bundle written yet: every key, with the bundles that hold it.
  const any = await completeAt("Resource.msgf('t‸')")
  assert.deepEqual(any.items.map((item) => [item.label, item.detail]), [['title.home', 'common']])
  // The bundle: those holding the key first.
  const bundles = await completeAt("Resource.msg('title.home', '‸')")
  assert.equal(bundles.context, 'bundle')
  assert.deepEqual(labels(bundles), ['common', 'product'])
  assert.equal(bundles.items[0].detail, 'title.home')
  const template = await completeAt("<span>${Resource.msg('label.p‸', 'product', null)}</span>", TEMPLATE)
  assert.deepEqual(labels(template), ['label.price'])
  // An unclosed string still completes, to the end of what is written.
  const open = await completeAt("var x = Resource.msg('title‸")
  assert.deepEqual(labels(open), ['title.home'])
  // The class written in full, or bound to another name.
  assert.deepEqual(labels(await completeAt("dw.web.Resource.msg('label.v‸', 'product', null);")), ['label.vat'])
  assert.deepEqual(labels(await completeAt("var R = require('dw/web/Resource');\nR.msg('title‸');")), ['title.home'])
  // A `Resource` bound to something else is not the platform's.
  assert.deepEqual(labels(await completeAt("var Resource = require('*/cartridge/scripts/helpers/priceHelper');\nResource.msg('label.‸');")), [])
  // Another call's string is not a key.
  assert.deepEqual(labels(await completeAt("Logger.info('label.‸');")), [])
})

test('complete 7. module paths in require(), and route ids in URLUtils.url()', async () => {
  const modules = await completeAt("require('*/cartridge/scripts/‸')")
  assert.equal(modules.context, 'module')
  assert.deepEqual(labels(modules), [
    '*/cartridge/scripts/helpers/priceHelper',
    '*/cartridge/scripts/outlet',
    '*/cartridge/scripts/util/collections'
  ])
  assert.equal(modules.items[2].detail, 'app_garden_base, app_garden_core')
  assert.deepEqual(labels(await completeAt("require('~/cartridge/scripts/u‸')")), ['~/cartridge/scripts/util/collections'])
  assert.deepEqual(labels(await completeAt("require('dw/catalog/ProductM‸')")), ['dw/catalog/ProductMgr'])
  // A cartridge named, a bare name of the modules folder; a relative path is not offered.
  assert.deepEqual(labels(await completeAt("require('app_garden_outlet/cartridge/scripts/‸')")), ['app_garden_outlet/cartridge/scripts/outlet'])
  assert.deepEqual(labels(await completeAt("require('serv‸')")), ['server'])
  assert.deepEqual(labels(await completeAt("require('./‸')")), [])
  const routes = await completeAt("URLUtils.url('Product-‸')")
  assert.deepEqual(labels(routes), ['Product-Compare', 'Product-QuickView', 'Product-Show', 'Product-Tile'])
  assert.equal(routes.items[0].detail, 'GardenOutlet, GardenShop')
  assert.deepEqual(labels(await completeAt("URLUtils.url('Cart-‸')")), ['Cart-Show'])
})

test('complete 7. with no storefront path, the routes every cartridge’s controllers declare, each with its cartridges', async () => {
  const files = fixtureFiles()
  files.delete('sites')
  const index = new CheckoutIndex(files, { dw: dwLookup })
  await index.build()
  const { analysis, offset } = at(SCRIPT, "URLUtils.url('‸')")
  const routes = complete({ index, dw: committedDw() }, analysis, offset)
  assert.deepEqual(
    routes.items.map((item) => [item.label, item.detail]),
    [
      ['Cart-Show', 'app_garden_outlet'],
      ['Home-Show', 'app_garden_base'],
      ['Product-Compare', 'app_garden_core'],
      ['Product-QuickView', 'app_garden_base'],
      ['Product-Show', 'app_garden_base'],
      ['Product-Tile', 'app_garden_base']
    ]
  )
})

test('complete 8. at most 200 items, said truncated; when in doubt, nothing', async () => {
  const many = await completeAt("require('dw/‸')")
  assert.equal(many.items.length, MAX_COMPLETION_ITEMS)
  assert.equal(many.truncated, true)
  // Unknown values, reassigned variables, unknown globals, a dot inside a number or a string.
  for (const marked of [
    'garden.‸',
    'pdict.‸',
    "var ArrayList = require('dw/util/ArrayList');\nvar HashMap = require('dw/util/HashMap');\nvar x = new ArrayList();\nx = new HashMap();\nx.‸",
    'var n = 1.‸',
    "var s = 'a.‸'",
    '// product.‸',
    'helpers.getProduct().‸'
  ]) {
    const answer = await completeAt(marked)
    assert.deepEqual(labels(answer), [], marked)
  }
  assert.equal((await completeAt('<p>Plain text ‸</p>', TEMPLATE)).context, 'none')
})
