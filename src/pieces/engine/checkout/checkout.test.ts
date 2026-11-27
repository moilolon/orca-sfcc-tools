// The checkout index (phase 6.3) over the invented checkout of `fixtures/checkout/`: two
// storefronts (GardenShop: core, base; GardenOutlet: outlet, core, base and a cartridge the
// checkout lacks), three cartridges and SFRA's `modules` folder. One test per point of the part,
// positions included, then the update after a change, then the timings.
import { assert, test } from 'orca/testing'
import { offsetOf } from '../fixtures/read'
import { CheckoutIndex, GitError, localeFallbacks, splitRouteId, templateName, type CheckoutOptions } from './checkout'
import { MemoryFiles } from './memory'
import { fixtureEntries, fixtureFiles, FakeRef, generatedCheckout } from './testing'

const BASE = 'cartridges/app_garden_base'
const CORE = 'cartridges/app_garden_core'
const OUTLET = 'cartridges/app_garden_outlet'
const ENTRIES = fixtureEntries()
const text = (path: string) => ENTRIES[path] as string

/** A `dw.*` lookup that knows the classes the fixtures require. */
const DW = (module: string) => (['dw/catalog/ProductMgr', 'dw/web/Resource', 'dw/util/ArrayList', 'dw/system/Site'].includes(module) ? module.replace(/\//g, '.') : null)

async function built(files: MemoryFiles = fixtureFiles(), options: CheckoutOptions = {}): Promise<CheckoutIndex> {
  const index = new CheckoutIndex(files, { dw: DW, ...options })
  await index.build()
  return index
}

const copyOf = <T extends { storefront: string }>(copies: readonly T[], storefront: string): T => {
  const found = copies.find((copy) => copy.storefront === storefront)
  assert.ok(found, `a copy for ${storefront}`)
  return found as T
}

test('1. cartridges: every folder with .project and cartridge/, with its folders and locales; modules is SFRA’s module folder', async () => {
  const index = await built()
  const cartridges = index.cartridges()
  assert.deepEqual(
    cartridges.map(({ name, root, kind }) => ({ name, root, kind })),
    [
      { name: 'app_garden_base', root: BASE, kind: 'cartridge' },
      { name: 'app_garden_core', root: CORE, kind: 'cartridge' },
      { name: 'app_garden_outlet', root: OUTLET, kind: 'cartridge' },
      { name: 'modules', root: 'modules', kind: 'modules' }
    ]
  )
  const base = cartridges[0]
  assert.deepEqual(base.folders, ['controllers', 'forms/default', 'models', 'scripts', 'static/default', 'templates/default', 'templates/fr_FR', 'templates/resources'])
  assert.deepEqual(base.templateLocales, ['default', 'fr_FR'])
  assert.deepEqual(base.formLocales, ['default'])
  assert.equal(base.files, 15)
  assert.equal(index.cartridgeOf(`${CORE}/cartridge/models/product.js`)?.name, 'app_garden_core')
  assert.equal(index.cartridgeOf('sites/site_template/meta/system-objecttype-extensions.xml'), null)
  // Client code under static/ is listed, never read as a server script.
  assert.equal(index.fileFacts(`${BASE}/cartridge/static/default/js/product.js`), null)
  assert.ok(index.filePaths().includes(`${BASE}/cartridge/static/default/js/product.js`))
})

test('1. a folder with .project but no cartridge/ folder is not a cartridge; a name held twice is reported', async () => {
  const files = fixtureFiles()
  files.set('tools/linter/.project', '<projectDescription/>')
  files.set('tools/linter/index.js', "require('x');")
  files.set('vendor/copy/app_garden_base/.project', '<projectDescription/>')
  files.set('vendor/copy/app_garden_base/cartridge/scripts/helpers/priceHelper.js', 'module.exports = {};')
  const index = await built(files)
  assert.ok(!index.cartridges().some((c) => c.root === 'tools/linter'))
  assert.deepEqual(index.status().duplicates, ['app_garden_base'])
  // The first by path is the one the paths use.
  const resolved = index.resolveModule(`${CORE}/cartridge/models/product.js`, '*/cartridge/scripts/helpers/priceHelper')
  assert.ok(resolved.kind === 'path')
  assert.equal(copyOf(resolved.copies, 'GardenShop').path, `${CORE}/cartridge/scripts/helpers/priceHelper.js`)
  assert.ok(index.superModule(`${CORE}/cartridge/scripts/helpers/priceHelper.js`).copies.every((copy) => copy.path === `${BASE}/cartridge/scripts/helpers/priceHelper.js`))
})

test('2. the paths from the site archives: one per site, with the file and the cartridges the checkout lacks', async () => {
  const index = await built()
  const status = index.status()
  assert.equal(status.pathSource, 'site-archive')
  assert.deepEqual(status.storefronts, [
    {
      id: 'GardenOutlet',
      source: 'site-archive',
      cartridges: ['app_garden_outlet', 'app_garden_core', 'app_garden_base', 'int_garden_payments'],
      missing: ['int_garden_payments'],
      file: 'sites/site_template/sites/GardenOutlet/site.xml',
      conflicts: 0
    },
    { id: 'GardenShop', source: 'site-archive', cartridges: ['app_garden_core', 'app_garden_base'], missing: [], file: 'sites/site_template/sites/GardenShop/site.xml', conflicts: 0 }
  ])
})

test('2. the setting wins over the site archives: one path for every storefront, colon-separated', async () => {
  const index = await built(fixtureFiles(), { cartridgePath: ' app_garden_core : app_garden_base: ' })
  assert.deepEqual(
    index.storefronts().map(({ id, source, cartridges }) => ({ id, source, cartridges })),
    [{ id: 'setting', source: 'setting', cartridges: ['app_garden_core', 'app_garden_base'] }]
  )
  // Changing the setting rebuilds the paths; clearing it brings the archives back.
  await index.configure({ cartridgePath: 'app_garden_outlet:app_garden_base' })
  assert.deepEqual(index.storefronts()[0].cartridges, ['app_garden_outlet', 'app_garden_base'])
  await index.configure({ cartridgePath: '' })
  assert.deepEqual(
    index.storefronts().map((s) => s.id),
    ['GardenOutlet', 'GardenShop']
  )
})

test('2 and 6. without site archives or metadata, both come from the git ref, read without checking it out, once per commit', async () => {
  const files = fixtureFiles()
  const archives: Record<string, string> = {}
  for (const [path, content] of Object.entries(ENTRIES)) {
    if (path.startsWith('sites/')) {
      archives[path] = content
      files.delete(path)
    }
  }
  archives['cartridges/app_garden_base/cartridge/sites/Fake/site.xml'] = '<site site-id="Fake"><custom-cartridges>nope</custom-cartridges></site>'
  const git = new FakeRef({ 'origin/main': 'a'.repeat(40) }, { ['a'.repeat(40)]: archives })
  const index = await built(files, { metadataRef: 'origin/main', git })
  const status = index.status()
  assert.equal(status.pathSource, 'git-ref')
  assert.equal(status.metadataSource, 'git-ref')
  assert.equal(status.gitError, null)
  assert.deepEqual(
    status.storefronts.map(({ id, source, file }) => ({ id, source, file })),
    [
      { id: 'GardenOutlet', source: 'git-ref', file: 'sites/site_template/sites/GardenOutlet/site.xml' },
      { id: 'GardenShop', source: 'git-ref', file: 'sites/site_template/sites/GardenShop/site.xml' }
    ]
  )
  assert.deepEqual(
    index.attributes('Product').map((a) => a.id),
    ['gardenColour', 'gardenBadge']
  )
  // Read at the commit, never at the moving ref; a file inside a cartridge is not an archive.
  assert.ok(git.calls.every((call) => call === 'commit origin/main' || call.includes('a'.repeat(40))))
  assert.ok(!git.calls.some((call) => call.includes('cartridge/sites')))
  const reads = git.calls.length
  // A file saved does not start git; asking again at the same commit reads nothing more.
  files.set(`${BASE}/cartridge/scripts/util/collections.js`, 'module.exports = {};', 2)
  await index.update([`${BASE}/cartridge/scripts/util/collections.js`])
  assert.equal(git.calls.length, reads)
  await index.refreshRef()
  assert.deepEqual(git.calls.slice(reads), ['commit origin/main'])
  // The ref moves: read again.
  git.commits['origin/main'] = 'b'.repeat(40)
  git.trees['b'.repeat(40)] = { 'sites/x/sites/GardenShop/site.xml': '<site site-id="GardenShop"><custom-cartridges>app_garden_base</custom-cartridges></site>' }
  await index.refreshRef()
  assert.deepEqual(
    index.storefronts().map((s) => [s.id, s.cartridges]),
    [['GardenShop', ['app_garden_base']]]
  )
  assert.equal(index.status().metadataSource, 'none')
})

test('2. a git ref that cannot be read leaves no path and says why, by code', async () => {
  const files = fixtureFiles()
  for (const path of Object.keys(ENTRIES)) if (path.startsWith('sites/')) files.delete(path)
  const index = await built(files, { metadataRef: 'origin/main', git: new FakeRef({}, {}, new GitError('git_not_found')) })
  assert.equal(index.status().pathSource, 'none')
  assert.equal(index.status().gitError, 'git_not_found')
  const missing = await built(files, { metadataRef: 'nope', git: new FakeRef({}, {}) })
  assert.equal(missing.status().gitError, 'ref_not_found')
  // Without the setting, git is never asked.
  const quiet = new FakeRef({}, {})
  await built(files, { git: quiet })
  assert.deepEqual(quiet.calls, [])
})

test('3. module resolution: */ along each path, ~/, relative, a named cartridge, dw/, and bare names in modules', async () => {
  const index = await built()
  const controller = `${BASE}/cartridge/controllers/Product.js`
  const star = index.resolveModule(controller, '*/cartridge/scripts/helpers/priceHelper')
  assert.ok(star.kind === 'path')
  // The core copy runs on both storefronts; the base copy is a candidate only.
  assert.deepEqual(star.copies, [
    { storefront: 'GardenOutlet', path: `${CORE}/cartridge/scripts/helpers/priceHelper.js` },
    { storefront: 'GardenShop', path: `${CORE}/cartridge/scripts/helpers/priceHelper.js` }
  ])
  assert.deepEqual(star.candidates, [`${BASE}/cartridge/scripts/helpers/priceHelper.js`, `${CORE}/cartridge/scripts/helpers/priceHelper.js`])
  assert.deepEqual(index.resolveModule(controller, '~/cartridge/scripts/util/collections'), { kind: 'file', module: '~/cartridge/scripts/util/collections', form: 'current', path: `${BASE}/cartridge/scripts/util/collections.js` })
  assert.deepEqual(index.resolveModule(`${BASE}/cartridge/scripts/helpers/priceHelper.js`, '../util/collections'), { kind: 'file', module: '../util/collections', form: 'relative', path: `${BASE}/cartridge/scripts/util/collections.js` })
  assert.deepEqual(index.resolveModule(controller, 'app_garden_core/cartridge/models/product'), { kind: 'file', module: 'app_garden_core/cartridge/models/product', form: 'cartridge', path: `${CORE}/cartridge/models/product.js` })
  assert.deepEqual(index.resolveModule(controller, '/app_garden_core/cartridge/models/product'), { kind: 'file', module: '/app_garden_core/cartridge/models/product', form: 'cartridge', path: `${CORE}/cartridge/models/product.js` })
  assert.deepEqual(index.resolveModule(controller, 'dw/catalog/ProductMgr'), { kind: 'dw', module: 'dw/catalog/ProductMgr', form: 'dw', id: 'dw.catalog.ProductMgr' })
  assert.deepEqual(index.resolveModule(controller, 'dw/nothing/Here'), { kind: 'dw', module: 'dw/nothing/Here', form: 'dw', id: null })
  assert.deepEqual(index.resolveModule(controller, 'server'), { kind: 'file', module: 'server', form: 'modules', path: 'modules/server.js' })
  assert.deepEqual(index.resolveModule(controller, 'lodash'), { kind: 'file', module: 'lodash', form: 'modules', path: null })
  // A cartridge's name: the main module its package.json names.
  assert.deepEqual(index.resolveModule(`${OUTLET}/cartridge/controllers/Cart.js`, 'app_garden_outlet'), { kind: 'file', module: 'app_garden_outlet', form: 'main', path: `${OUTLET}/cartridge/scripts/outlet.js` })
  assert.deepEqual(index.resolveModule(controller, 'app_garden_core'), { kind: 'file', module: 'app_garden_core', form: 'main', path: null })
  // `~/` outside a cartridge, and `..` past the root, lead nowhere.
  assert.equal((index.resolveModule('sites/x.js', '~/cartridge/x') as { path: string | null }).path, null)
  assert.equal((index.resolveModule(controller, '../../../../../../x') as { path: string | null }).path, null)
  const dangling = index.resolveModule(`${OUTLET}/cartridge/controllers/Cart.js`, '*/cartridge/scripts/helpers/cartHelper')
  assert.ok(dangling.kind === 'path' && dangling.copies.every((copy) => copy.path === null) && dangling.candidates.length === 0)
})

test('3. the requires of a file are kept with the range of their argument', async () => {
  const index = await built()
  const path = `${BASE}/cartridge/controllers/Product.js`
  const facts = index.fileFacts(path)
  assert.ok(facts)
  const source = text(path)
  const star = facts.requires.find((use) => use.module === '*/cartridge/scripts/helpers/priceHelper')
  assert.deepEqual(star && { start: star.start, end: star.end }, { start: offsetOf(source, "'*/cartridge/scripts/helpers/priceHelper'"), end: offsetOf(source, "'*/cartridge/scripts/helpers/priceHelper'") + 41 })
  assert.deepEqual(
    facts.requires.map((use) => use.module),
    ['server', '*/cartridge/scripts/helpers/priceHelper', '~/cartridge/scripts/util/collections', 'dw/catalog/ProductMgr']
  )
  // A template's <isscript> requires too.
  const template = index.fileFacts(`${BASE}/cartridge/templates/default/product/productDetails.isml`)
  assert.deepEqual(template?.requires.map((use) => use.module), ['*/cartridge/scripts/helpers/priceHelper'])
})

test('3. module.superModule: the next cartridge after the file’s own that has the same path, per storefront', async () => {
  const index = await built()
  assert.deepEqual(index.superModule(`${CORE}/cartridge/models/product.js`), {
    module: 'cartridge/models/product.js',
    copies: [
      { storefront: 'GardenOutlet', path: `${BASE}/cartridge/models/product.js`, onPath: true },
      { storefront: 'GardenShop', path: `${BASE}/cartridge/models/product.js`, onPath: true }
    ]
  })
  // The outlet's controller is on the outlet's path only; there its base is the core one.
  assert.deepEqual(index.superModule(`${OUTLET}/cartridge/controllers/Product.js`).copies, [
    { storefront: 'GardenOutlet', path: `${CORE}/cartridge/controllers/Product.js`, onPath: true },
    { storefront: 'GardenShop', path: null, onPath: false }
  ])
  // The last copy has none.
  assert.ok(index.superModule(`${BASE}/cartridge/models/product.js`).copies.every((copy) => copy.path === null && copy.onPath))
  const facts = index.fileFacts(`${CORE}/cartridge/models/product.js`)
  assert.ok(facts && facts.kind === 'script')
  const source = text(`${CORE}/cartridge/models/product.js`)
  assert.deepEqual(facts.superModule, [{ start: offsetOf(source, 'module.superModule'), end: offsetOf(source, 'module.superModule') + 'module.superModule'.length }])
})

test('4. templates: along each path, per locale folder with default as the fallback; uses with their positions', async () => {
  const index = await built()
  const price = index.resolveTemplate('product/components/price')
  assert.deepEqual(price.copies, [
    { storefront: 'GardenOutlet', path: `${OUTLET}/cartridge/templates/default/product/components/price.isml`, locale: 'default' },
    { storefront: 'GardenShop', path: `${CORE}/cartridge/templates/default/product/components/price.isml`, locale: 'default' }
  ])
  assert.equal(price.candidates.length, 3)
  const french = index.resolveTemplate('/home/homePage.isml', 'fr_FR')
  assert.equal(french.name, 'home/homePage')
  assert.ok(french.copies.every((copy) => copy.path === `${BASE}/cartridge/templates/fr_FR/home/homePage.isml` && copy.locale === 'fr_FR'))
  const belgian = index.resolveTemplate('home/homePage', 'fr_BE')
  assert.ok(belgian.copies.every((copy) => copy.path === `${BASE}/cartridge/templates/default/home/homePage.isml` && copy.locale === 'default'))
  assert.ok(index.resolveTemplate('product/quickView').copies.every((copy) => copy.path === null))
  // The uses: res.render in a script, isinclude and isdecorate in a template.
  const script = index.fileFacts(`${BASE}/cartridge/controllers/Product.js`)
  const scriptText = text(`${BASE}/cartridge/controllers/Product.js`)
  assert.deepEqual(script?.templates[0], { name: 'product/productDetails', via: 'render', start: offsetOf(scriptText, 'product/productDetails'), end: offsetOf(scriptText, 'product/productDetails') + 22 })
  const template = index.fileFacts(`${BASE}/cartridge/templates/default/product/productDetails.isml`)
  const templateText = text(`${BASE}/cartridge/templates/default/product/productDetails.isml`)
  assert.deepEqual(
    template?.templates.map(({ name, via, start }) => ({ name, via, start })),
    [
      { name: 'common/layout/page', via: 'isdecorate', start: offsetOf(templateText, 'common/layout/page') },
      { name: 'product/components/price', via: 'isinclude', start: offsetOf(templateText, 'product/components/price') }
    ]
  )
  assert.equal(templateName(' product\\x.isml '), 'product/x')
  assert.deepEqual(localeFallbacks('fr_FR'), ['fr_FR', 'fr', 'default'])
  assert.deepEqual(localeFallbacks(''), ['default'])
})

test('5. resource bundles: keys with their position per cartridge and locale; Resource.msg and msgf along each path', async () => {
  const index = await built()
  const price = index.resolveResource('label.price', 'product')
  const coreText = text(`${CORE}/cartridge/templates/resources/product.properties`)
  const shop = copyOf(price.copies, 'GardenShop').key
  assert.deepEqual(shop && { path: shop.path, value: shop.value, start: shop.start, end: shop.end, line: shop.line, cartridge: shop.cartridge, bundle: shop.bundle }, {
    path: `${CORE}/cartridge/templates/resources/product.properties`,
    value: 'Our price',
    start: offsetOf(coreText, 'label.price'),
    end: offsetOf(coreText, 'label.price') + 11,
    line: 2,
    cartridge: 'app_garden_core',
    bundle: 'product'
  })
  assert.equal(price.candidates.length, 3)
  // French: the core cartridge has no French bundle, so the base one's French key wins.
  const french = index.resolveResource('label.price', 'product', 'fr_FR')
  assert.ok(french.copies.every((copy) => copy.key?.value === 'Prix' && copy.key.bundle === 'product_fr'))
  // A key of the outlet's own bundle exists on the outlet only.
  const sale = index.resolveResource('label.sale', 'product')
  assert.equal(copyOf(sale.copies, 'GardenOutlet').key?.value, 'Outlet price')
  assert.equal(copyOf(sale.copies, 'GardenShop').key, null)
  // A continued value, and a key separated by ' : '.
  assert.equal(index.resolveResource('label.long', 'product').copies[0].key?.value, 'A long text that goes on over two lines')
  assert.equal(index.resolveResource('title.home', 'common').copies[0].key?.value, 'Garden home')
  assert.deepEqual(
    index
      .resourceKeys('product', 'app_garden_base')
      .map((key) => `${key.bundle}:${key.key}`)
      .sort(),
    ['product:label.long', 'product:label.price', 'product:label.stock', 'product_fr:label.price']
  )
  // The uses: msg and msgf in a template, msg in a script, each with its key's range.
  const template = index.fileFacts(`${BASE}/cartridge/templates/default/product/productDetails.isml`)
  const templateText = text(`${BASE}/cartridge/templates/default/product/productDetails.isml`)
  assert.deepEqual(template?.resources, [
    { method: 'msg', key: 'label.price', bundle: 'product', start: offsetOf(templateText, 'label.price'), end: offsetOf(templateText, 'label.price') + 11 },
    { method: 'msgf', key: 'label.stock', bundle: 'product', start: offsetOf(templateText, 'label.stock'), end: offsetOf(templateText, 'label.stock') + 11 }
  ])
})

test('6. metadata: custom attributes per object type with their type and position, site preferences, custom object types', async () => {
  const index = await built()
  assert.equal(index.status().metadataSource, 'checkout')
  const path = 'sites/site_template/meta/system-objecttype-extensions.xml'
  const source = text(path)
  // `name` is a system attribute, not a custom one.
  assert.deepEqual(index.attributes('Product'), [
    { id: 'gardenColour', type: 'string', path, start: offsetOf(source, 'gardenColour'), end: offsetOf(source, 'gardenColour') + 12, line: 10 },
    { id: 'gardenBadge', type: 'enum-of-string', path, start: offsetOf(source, 'gardenBadge'), end: offsetOf(source, 'gardenBadge') + 11, line: 15 }
  ])
  assert.deepEqual(
    index.sitePreferences().map(({ id, type }) => ({ id, type })),
    [
      { id: 'gardenCurrency', type: 'string' },
      { id: 'gardenShowBadges', type: 'boolean' }
    ]
  )
  assert.deepEqual(
    index.types().map(({ typeId, kind, attributes }) => ({ typeId, kind, attributes: attributes.map((a) => a.id) })),
    [
      { typeId: 'GardenWishlist', kind: 'custom', attributes: ['items'] },
      { typeId: 'Product', kind: 'system', attributes: ['gardenColour', 'gardenBadge'] },
      { typeId: 'SitePreferences', kind: 'system', attributes: ['gardenCurrency', 'gardenShowBadges'] }
    ]
  )
  assert.deepEqual(index.attributes('Order'), [])
})

test('7. SFRA routes: which declaration serves Controller-Name on each storefront, and the order the chain runs', async () => {
  const index = await built()
  const show = index.route('Product-Show')
  assert.ok(show)
  const order = (storefront: string) => copyOf(show.storefronts, storefront).steps.map((step) => `${step.method}@${step.cartridge}`)
  // A prepend runs before the declaration, appends after it, in the order they were applied.
  assert.deepEqual(order('GardenShop'), ['prepend@app_garden_core', 'get@app_garden_base', 'append@app_garden_core'])
  assert.deepEqual(order('GardenOutlet'), ['prepend@app_garden_core', 'get@app_garden_base', 'append@app_garden_core', 'append@app_garden_outlet'])
  assert.equal(copyOf(show.storefronts, 'GardenShop').controller, `${CORE}/cartridge/controllers/Product.js`)
  assert.equal(copyOf(show.storefronts, 'GardenOutlet').controller, `${OUTLET}/cartridge/controllers/Product.js`)
  const declaration = copyOf(show.storefronts, 'GardenShop').steps[1]
  const baseText = text(`${BASE}/cartridge/controllers/Product.js`)
  assert.deepEqual(
    { nameStart: declaration.nameStart, nameEnd: declaration.nameEnd, line: declaration.line, path: declaration.path, start: declaration.start },
    { nameStart: offsetOf(baseText, "'Show'") + 1, nameEnd: offsetOf(baseText, "'Show'") + 5, line: 10, path: `${BASE}/cartridge/controllers/Product.js`, start: offsetOf(baseText, 'server.get(') }
  )
  // `replace` drops the base's chain.
  const tile = index.route('Product-Tile')
  assert.deepEqual(
    tile?.storefronts.map((chain) => chain.steps.map((step) => `${step.method}@${step.cartridge}`)),
    [['replace@app_garden_core'], ['replace@app_garden_core']]
  )
  assert.deepEqual(
    tile?.storefronts[0].applied.map((step) => step.method),
    ['get', 'replace']
  )
  assert.deepEqual(index.routeIds('GardenShop'), ['Home-Show', 'Product-Compare', 'Product-QuickView', 'Product-Show', 'Product-Tile'])
  assert.deepEqual(index.routeIds('GardenOutlet'), ['Cart-Show', 'Home-Show', 'Product-Compare', 'Product-QuickView', 'Product-Show', 'Product-Tile'])
  // An append on a route nobody declares, on a controller of the outlet only.
  const missing = index.route('Cart-Missing')
  assert.deepEqual(copyOf(missing?.storefronts ?? [], 'GardenOutlet').problems.map((p) => p.code), ['route_missing'])
  assert.deepEqual(copyOf(missing?.storefronts ?? [], 'GardenShop'), { storefront: 'GardenShop', controller: null, steps: [], applied: [], problems: [] })
  assert.equal(index.route('NoDash'), null)
  assert.deepEqual(splitRouteId('Page-Include-Header'), { controller: 'Page', name: 'Include-Header' })
})

test('7. a controller that extends nothing, does not export, or extends a missing base says so', async () => {
  const files = fixtureFiles()
  files.set(`${OUTLET}/cartridge/controllers/Product.js`, "var server = require('server');\nserver.append('Show', function () {});\n", 2)
  files.set(`${CORE}/cartridge/controllers/Home.js`, "var server = require('server');\nserver.extend(module.superModule);\nserver.get('Show', function () {});\nmodule.exports = server.exports();\n", 2)
  files.set(`${OUTLET}/cartridge/controllers/Search.js`, "var server = require('server');\nserver.extend(module.superModule);\nserver.get('Show', function () {});\nmodule.exports = server.exports();\n", 2)
  const index = await built(files)
  const show = copyOf(index.route('Product-Show')?.storefronts ?? [], 'GardenOutlet')
  assert.deepEqual(show.steps, [])
  assert.deepEqual(show.problems.map((p) => p.code).sort(), ['not_exported', 'route_missing'])
  const home = copyOf(index.route('Home-Show')?.storefronts ?? [], 'GardenShop')
  assert.deepEqual(home.problems.map((p) => p.code), ['route_redefined'])
  assert.equal(home.steps[0].cartridge, 'app_garden_core')
  assert.deepEqual(copyOf(index.route('Search-Show')?.storefronts ?? [], 'GardenOutlet').problems.map((p) => p.code), ['base_missing'])
})

test('8. kept current: a changed file is read again alone; a deleted override falls back; a new key and a new site appear', async () => {
  const files = fixtureFiles()
  const index = await built(files)
  const helper = `${CORE}/cartridge/scripts/helpers/priceHelper.js`
  const readsBefore = new Map(files.reads)
  // Nothing changed: a rebuild reads no file again (cached by file time).
  await index.build()
  assert.deepEqual(files.reads, readsBefore)
  // A changed file is read again, and nothing else.
  files.set(`${BASE}/cartridge/controllers/Product.js`, text(`${BASE}/cartridge/controllers/Product.js`).replace("server.post('QuickView'", "server.get('QuickLook'"), 5)
  await index.update([`${BASE}/cartridge/controllers/Product.js`])
  const reread = [...files.reads].filter(([path, count]) => count !== (readsBefore.get(path) ?? 0)).map(([path]) => path)
  assert.deepEqual(reread, [`${BASE}/cartridge/controllers/Product.js`])
  assert.ok(index.routeIds('GardenShop').includes('Product-QuickLook'))
  assert.ok(!index.routeIds('GardenShop').includes('Product-QuickView'))
  assert.ok(index.status().updatedAt !== null && index.status().updateMs !== null)
  // The core override is deleted: */ falls back to the base copy.
  files.delete(helper)
  await index.update([helper])
  const star = index.resolveModule(`${BASE}/cartridge/controllers/Product.js`, '*/cartridge/scripts/helpers/priceHelper')
  assert.ok(star.kind === 'path' && star.copies.every((copy) => copy.path === `${BASE}/cartridge/scripts/helpers/priceHelper.js`))
  // A new key in a bundle.
  const bundle = `${OUTLET}/cartridge/templates/resources/product.properties`
  files.set(bundle, 'label.sale=Outlet price\nlabel.new=New\n', 6)
  await index.update([bundle])
  assert.equal(copyOf(index.resolveResource('label.new', 'product').copies, 'GardenOutlet').key?.line, 2)
  // A folder added at once (a branch switch): walked.
  files.set(`${OUTLET}/cartridge/scripts/helpers/cartHelper.js`, 'module.exports = {};', 7)
  await index.update([`${OUTLET}/cartridge/scripts`])
  assert.equal(index.status().counts.requiresUnresolved, 0)
  // A site archive changed: the paths are rebuilt.
  const shop = 'sites/site_template/sites/GardenShop/site.xml'
  files.set(shop, text(shop).replace('app_garden_core:app_garden_base', 'app_garden_base'), 8)
  await index.update([shop])
  assert.deepEqual(index.storefronts().find((s) => s.id === 'GardenShop')?.cartridges, ['app_garden_base'])
  // A folder removed: everything below it goes.
  files.delete('sites/site_template/meta')
  await index.update(['sites/site_template/meta'])
  assert.equal(index.status().metadataSource, 'none')
  // Paths in skipped folders are ignored.
  await index.update(['node_modules/x/index.js', '.git/index', 'a/.git'])
})

test('8. a cartridge’s .project removed or added changes what is a cartridge, and the paths with it', async () => {
  const files = fixtureFiles()
  const index = await built(files)
  files.delete(`${OUTLET}/.project`)
  await index.update([`${OUTLET}/.project`])
  assert.ok(!index.cartridges().some((c) => c.name === 'app_garden_outlet'))
  assert.deepEqual(index.storefronts().find((s) => s.id === 'GardenOutlet')?.missing, ['app_garden_outlet', 'int_garden_payments'])
  assert.equal(copyOf(index.resolveTemplate('product/components/price').copies, 'GardenOutlet').path, `${CORE}/cartridge/templates/default/product/components/price.isml`)
  files.set(`${OUTLET}/.project`, '<projectDescription/>', 9)
  await index.update([`${OUTLET}/.project`])
  assert.ok(index.cartridges().some((c) => c.name === 'app_garden_outlet'))
  assert.equal(copyOf(index.resolveTemplate('product/components/price').copies, 'GardenOutlet').path, `${OUTLET}/cartridge/templates/default/product/components/price.isml`)
})

test('the status counts the invented checkout: what resolves and what dangles', async () => {
  const index = await built()
  const { counts } = index.status()
  assert.deepEqual(counts, {
    files: 34,
    scripts: 12,
    controllers: 5,
    templates: 6,
    bundles: 5,
    resourceKeys: 8,
    objectTypes: 3,
    attributes: 5,
    sitePreferences: 2,
    routes: 11,
    requires: 15,
    requiresResolved: 14,
    // The cart helper nobody wrote.
    requiresUnresolved: 1,
    templateUses: 9,
    // quickView, compare, cart/cart and the decorator: not in the checkout.
    templateUsesUnresolved: 4,
    resourceUses: 7,
    resourceUsesUnresolved: 0
  })
})

test('timings: the invented checkout and a generated 3,000-file checkout, built and updated', async () => {
  const time = async (run: () => Promise<unknown>) => {
    const started = performance.now()
    await run()
    return performance.now() - started
  }
  const fixture = new CheckoutIndex(fixtureFiles(), { dw: DW })
  const fixtureBuild = await time(() => fixture.build())
  const generated = generatedCheckout(3000)
  assert.ok(generated.paths().length >= 3000, `${generated.paths().length} files`)
  const large = new CheckoutIndex(generated, { dw: DW })
  const largeBuild = await time(() => large.build())
  const largeStatus = await time(async () => large.status())
  const changed = 'cartridges/app_gen_2/cartridge/scripts/lib/module7.js'
  generated.set(changed, "'use strict';\nmodule.exports = {};\n", 2)
  const largeUpdate = await time(() => large.update([changed]))
  const rebuild = await time(() => large.build())
  const counts = large.status().counts
  console.log(
    `invented checkout: build ${fixtureBuild.toFixed(1)} ms; generated ${generated.paths().length} files: build ${largeBuild.toFixed(1)} ms, status ${largeStatus.toFixed(1)} ms, update after one file ${largeUpdate.toFixed(1)} ms, rebuild with nothing changed ${rebuild.toFixed(1)} ms`
  )
  assert.equal(counts.requiresUnresolved, 0)
  assert.equal(large.storefronts()[0].cartridges.length, 6)
  assert.ok(large.routeIds('GenSite').includes('Page0-Show'))
  // Generous bounds: the test machine may be busy. The numbers are in the log.
  assert.ok(largeBuild < 10_000, `build took ${largeBuild} ms`)
  assert.ok(largeUpdate < 2_000, `update took ${largeUpdate} ms`)
})
