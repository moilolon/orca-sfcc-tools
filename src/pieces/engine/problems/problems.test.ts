// The problems on the invented checkout extended with `fixtures/problems/`: every warning of the
// list found with its range, nothing on the clean files, nothing when in doubt, the weaker warning
// for a name some storefronts lack, a text not yet saved, and a pass after a change.
import { assert, test } from 'orca/testing'
import { fixtureEntries } from '../checkout/testing'
import { brief, BASE, checked, CORE, OUTLET, outletWithMissingCartridge, type Checked } from './testing'
import { newProblems, type Problem } from './problem'

type Brief = { code: string; line: number; at: string; args?: Record<string, string> }

async function briefs(check: Checked, path: string): Promise<Brief[]> {
  const text = (await check.files.read(path)) ?? ''
  return check.problems.problemsOf(path).map((each) => {
    const { code, line, at, args } = brief(text, each)
    return Object.keys(args).length > 0 ? { code, line, at, args: args as Record<string, string> } : { code, line, at }
  })
}

/** Every file with problems, and each problem's code, line, the text of its range and its names. */
const EXPECTED: Record<string, Brief[]> = {
  [`${BASE}/cartridge/controllers/Checks.js`]: [
    { code: 'route_redefined', line: 12, at: 'Show', args: { route: 'Show' } },
    { code: 'route_missing', line: 16, at: 'Nope', args: { route: 'Nope' } }
  ],
  [`${BASE}/cartridge/controllers/Product.js`]: [{ code: 'template_missing', line: 23, at: 'product/quickView', args: { name: 'product/quickView' } }],
  [`${BASE}/cartridge/controllers/Unexported.js`]: [{ code: 'not_exported', line: 1, at: '' }],
  [`${BASE}/cartridge/forms/default/address.xml`]: [
    { code: 'form_unknown_attribute', line: 4, at: 'required', args: { attribute: 'required', element: 'field' } },
    { code: 'form_duplicate_id', line: 5, at: 'city', args: { id: 'city' } },
    { code: 'form_include_missing', line: 9, at: 'billing', args: { name: 'billing' } },
    { code: 'form_include_partial', line: 10, at: 'outletCard', args: { name: 'outletCard', storefronts: 'GardenShop' } },
    { code: 'form_unknown_element', line: 12, at: 'section', args: { element: 'section' } }
  ],
  [`${BASE}/cartridge/forms/default/broken.xml`]: [{ code: 'form_malformed', line: 4, at: '</form>', args: { reason: 'mismatched_tag' } }],
  [`${BASE}/cartridge/scripts/checks/attributes.js`]: [
    { code: 'unknown_attribute', line: 16, at: 'gardenSize', args: { name: 'gardenSize', type: 'Product' } },
    { code: 'unknown_attribute', line: 17, at: 'gardenBadges', args: { name: 'gardenBadges', type: 'Product' } },
    { code: 'unknown_preference', line: 19, at: 'gardenFreeShipping', args: { name: 'gardenFreeShipping' } },
    { code: 'unknown_preference', line: 20, at: 'gardenShowBadge', args: { name: 'gardenShowBadge' } },
    { code: 'unknown_attribute', line: 21, at: 'owner', args: { name: 'owner', type: 'GardenWishlist' } }
  ],
  [`${BASE}/cartridge/scripts/checks/names.js`]: [
    { code: 'template_missing', line: 12, at: 'checks/nowhere', args: { name: 'checks/nowhere' } },
    { code: 'template_partial', line: 13, at: 'outlet/banner', args: { name: 'outlet/banner', storefronts: 'GardenShop' } },
    { code: 'resource_missing', line: 16, at: 'label.nowhere', args: { key: 'label.nowhere', bundle: 'product' } },
    { code: 'resource_partial', line: 17, at: 'label.sale', args: { key: 'label.sale', bundle: 'product', storefronts: 'GardenShop' } },
    { code: 'bundle_missing', line: 19, at: 'label.any', args: { bundle: 'gardenNotes' } }
  ],
  [`${BASE}/cartridge/templates/default/checks/page.isml`]: [
    { code: 'template_missing', line: 1, at: 'checks/layout', args: { name: 'checks/layout' } },
    { code: 'template_missing', line: 4, at: 'checks/footer', args: { name: 'checks/footer' } },
    { code: 'resource_missing', line: 6, at: 'label.gone', args: { key: 'label.gone', bundle: 'product' } }
  ],
  [`${BASE}/cartridge/templates/default/product/productDetails.isml`]: [{ code: 'template_missing', line: 1, at: 'common/layout/page', args: { name: 'common/layout/page' } }],
  [`${BASE}/steptypes.json`]: [
    { code: 'steptypes_module_missing', line: 11, at: 'app_garden_base/cartridge/scripts/jobs/nowhere.js', args: { module: 'app_garden_base/cartridge/scripts/jobs/nowhere.js' } },
    { code: 'steptypes_missing_key', line: 17, at: '{', args: { key: '@type-id' } },
    { code: 'steptypes_duplicate_id', line: 21, at: 'custom.Garden.Export', args: { id: 'custom.Garden.Export' } }
  ],
  [`${CORE}/cartridge/controllers/Account.js`]: [
    { code: 'base_missing', line: 1, at: '' },
    { code: 'route_missing', line: 9, at: 'Show', args: { route: 'Show' } }
  ],
  [`${CORE}/cartridge/controllers/Product.js`]: [{ code: 'template_missing', line: 26, at: 'product/compare', args: { name: 'product/compare' } }],
  [`${CORE}/steptypes.json`]: [{ code: 'steptypes_duplicate_id', line: 4, at: 'custom.Garden.Export', args: { id: 'custom.Garden.Export' } }],
  [`${OUTLET}/cartridge/controllers/Cart.js`]: [
    { code: 'template_missing', line: 11, at: 'cart/cart', args: { name: 'cart/cart' } },
    { code: 'route_missing', line: 15, at: 'Missing', args: { route: 'Missing' } }
  ],
  [`${OUTLET}/steptypes.json`]: [{ code: 'steptypes_invalid', line: 7, at: '}', args: { reason: 'unexpected' } }]
}

test('every warning of the list is found on its fixture, with its range, and nothing else anywhere in the checkout', async () => {
  const check = await checked()
  const found: Record<string, Brief[]> = {}
  for (const [path] of check.problems.entries()) found[path] = await briefs(check, path)
  assert.deepEqual(found, EXPECTED)
  const codes = new Set(Object.values(found).flatMap((list) => list.map((each) => each.code)))
  // Every code of the engine is shown by a fixture.
  for (const code of ['unknown_attribute', 'unknown_preference', 'template_missing', 'template_partial', 'resource_missing', 'resource_partial', 'bundle_missing', 'route_redefined', 'route_missing', 'base_missing', 'not_exported', 'form_malformed', 'form_unknown_element', 'form_unknown_attribute', 'form_duplicate_id', 'form_include_missing', 'form_include_partial', 'steptypes_invalid', 'steptypes_missing_key', 'steptypes_module_missing', 'steptypes_duplicate_id']) {
    assert.ok(codes.has(code), code)
  }
  assert.deepEqual(check.problems.counts(), { error: 13, warning: 18, info: 3 })
  assert.equal(check.problems.fileCount(), Object.keys(EXPECTED).length)
})

test('the clean fixtures raise none: known attributes, preferences, templates, keys, a valid form and step types', async () => {
  const check = await checked()
  const clean = [
    `${BASE}/cartridge/scripts/checks/clean.js`,
    `${BASE}/cartridge/templates/default/checks/clean.isml`,
    `${BASE}/cartridge/forms/default/newsletter.xml`,
    `${OUTLET}/cartridge/forms/default/outletCard.xml`,
    `${OUTLET}/cartridge/templates/default/outlet/banner.isml`,
    `${BASE}/cartridge/controllers/Home.js`,
    `${BASE}/cartridge/models/product.js`,
    `${CORE}/cartridge/models/product.js`,
    `${CORE}/cartridge/scripts/helpers/priceHelper.js`,
    `${CORE}/cartridge/templates/default/product/components/price.isml`
  ]
  for (const path of clean) assert.deepEqual(check.problems.problemsOf(path), [], path)
  // A clean step types file, read as a text.
  const steps = '{ "step-types": { "chunk-script-module-step": [ { "@type-id": "custom.Garden.Clean", "module": "app_garden_outlet/cartridge/scripts/outlet.js" } ] } }'
  assert.deepEqual(check.problems.analyseText(`${OUTLET}/steptypes.json`, steps), [])
})

test('when in doubt, nothing: unknown types, names read at run time, a Resource of the project, a type with no metadata', async () => {
  const check = await checked()
  assert.deepEqual(check.problems.problemsOf(`${BASE}/cartridge/scripts/checks/doubt.js`), [])
  // `pdict` is unknown: its custom attributes are not checked.
  assert.ok(!check.problems.problemsOf(`${BASE}/cartridge/templates/default/checks/page.isml`).some((each) => each.code === 'unknown_attribute'))
  // A step whose module is in a cartridge the checkout does not hold.
  assert.ok(!check.problems.problemsOf(`${BASE}/steptypes.json`).some((each) => each.args.module?.startsWith('int_garden_payments')))
  // A guessed name is never checked, even where completion would guess it.
  const guessed = "function f(product) { return product.custom.gardenNothing; }\nmodule.exports = f;\n"
  assert.deepEqual(check.problems.analyseText(`${BASE}/cartridge/scripts/checks/guess.js`, guessed), [])
})

test('metadata a cartridge ships for itself, or loose metadata files, say nothing of the attributes defined elsewhere', async () => {
  const meta = fixtureEntries()['sites/site_template/meta/system-objecttype-extensions.xml'] ?? ''
  for (const where of ['cartridges/int_garden_tags/metadata/meta/system-objecttype-extensions.xml', 'metadata/meta/system-objecttype-extensions.xml']) {
    const check = await checked({ 'sites/site_template/meta/system-objecttype-extensions.xml': null, [where]: meta })
    const codes = check.problems.problemsOf(`${BASE}/cartridge/scripts/checks/attributes.js`).map((each) => each.code)
    // The custom object type is still defined by the site import: only its attribute is told.
    assert.deepEqual(codes, ['unknown_attribute'], where)
  }
})

test('a name some storefronts lack is the weaker warning naming them; a storefront whose path names a cartridge the checkout lacks counts neither way', async () => {
  const check = await checked({ 'sites/site_template/sites/GardenOutlet/site.xml': outletWithMissingCartridge() })
  const names = await briefs(check, `${BASE}/cartridge/scripts/checks/names.js`)
  assert.deepEqual(
    names.map((each) => [each.code, each.at, each.args?.storefronts]),
    [
      ['template_partial', 'checks/nowhere', 'GardenShop'],
      ['template_partial', 'outlet/banner', 'GardenShop'],
      ['resource_partial', 'label.nowhere', 'GardenShop'],
      ['resource_partial', 'label.sale', 'GardenShop'],
      ['resource_partial', 'label.any', 'GardenShop']
    ]
  )
  // The outlet runs on its storefront only, which is in doubt: no template is missing there.
  assert.deepEqual(
    (await briefs(check, `${OUTLET}/cartridge/controllers/Cart.js`)).map((each) => each.code),
    ['route_missing']
  )
  // A chain that extends past a cartridge the checkout lacks is in doubt on that storefront only.
  assert.deepEqual(await briefs(check, `${CORE}/cartridge/controllers/Account.js`), [
    { code: 'base_missing', line: 1, at: '', args: { storefronts: 'GardenShop' } },
    { code: 'route_missing', line: 9, at: 'Show', args: { route: 'Show', storefronts: 'GardenShop' } }
  ])
  // What needs no path is told whatever the paths.
  assert.deepEqual(
    (await briefs(check, `${BASE}/cartridge/scripts/checks/attributes.js`)).map((each) => each.code),
    ['unknown_attribute', 'unknown_attribute', 'unknown_preference', 'unknown_preference', 'unknown_attribute']
  )
})

test('with no cartridge path at all, no template, key or route is told: what a file reaches is not known', async () => {
  // The site archives stay, with no cartridge path in them.
  const noPath = (site: string) => `<?xml version="1.0" encoding="UTF-8"?>
<site xmlns="http://www.demandware.com/xml/impex/site/2007-04-30" site-id="${site}">
    <currency>EUR</currency>
</site>
`
  const check = await checked({ 'sites/site_template/sites/GardenOutlet/site.xml': noPath('GardenOutlet'), 'sites/site_template/sites/GardenShop/site.xml': noPath('GardenShop') })
  assert.equal(check.index.storefronts().length, 0)
  const codes = new Set<string>(check.problems.entries().flatMap(([, list]) => list.map((each) => each.code)))
  for (const code of ['template_missing', 'template_partial', 'resource_missing', 'resource_partial', 'bundle_missing', 'route_redefined', 'route_missing', 'base_missing', 'not_exported', 'form_include_missing']) assert.ok(!codes.has(code), code)
  for (const code of ['unknown_attribute', 'form_malformed', 'form_duplicate_id', 'steptypes_invalid', 'steptypes_module_missing', 'steptypes_duplicate_id']) assert.ok(codes.has(code), code)
})

test('a text not yet saved is analysed as given, in its own positions, and kept nowhere', async () => {
  const check = await checked()
  const path = `${BASE}/cartridge/scripts/checks/clean.js`
  const text = "var ProductMgr = require('dw/catalog/ProductMgr');\n\nvar x = ProductMgr.getProduct('1').custom.gardenColor;\n"
  const found = check.problems.analyseText(path, text)
  assert.deepEqual(
    found.map((each) => brief(text, each)),
    [{ code: 'unknown_attribute', line: 3, column: 43, at: 'gardenColor', args: { name: 'gardenColor', type: 'Product' } }]
  )
  assert.deepEqual(check.problems.problemsOf(path), [])
})

test('a pass after a change reads the file changed, and checks every file again: a template added clears the warnings that named it', async () => {
  const check = await checked()
  const names = `${BASE}/cartridge/scripts/checks/names.js`
  assert.ok(check.problems.problemsOf(names).some((each) => each.args.name === 'checks/nowhere'))
  const added = `${BASE}/cartridge/templates/default/checks/nowhere.isml`
  check.files.set(added, '<div></div>\n', 2)
  await check.index.update([added])
  const before = await check.problems.run([added])
  // Only the template was read again; the script was not, and its warning is gone.
  assert.deepEqual([...before.keys()], [added])
  assert.ok(!check.problems.problemsOf(names).some((each) => each.args.name === 'checks/nowhere'))
  // A file edited: read again, its old problems answered for comparison.
  check.files.set(names, `${(await check.files.read(names)) ?? ''}\nResource.msg('label.more', 'product', null);\n`, 3)
  await check.index.update([names])
  const again = await check.problems.run([names])
  assert.equal(newProblems(again.get(names) ?? [], check.problems.problemsOf(names)), 1)
})

test('new problems are counted by code and names, not by place: a moved problem is not new, a second of the same name is', () => {
  const at = (line: number): Problem => ({ code: 'unknown_attribute', severity: 'warning', start: line * 10, end: line * 10 + 4, line, column: 1, args: { name: 'a', type: 'Product' } })
  assert.equal(newProblems([at(1)], [at(5)]), 0)
  assert.equal(newProblems([at(1)], [at(5), at(9)]), 1)
  assert.equal(newProblems([], [at(1)]), 1)
  assert.equal(newProblems([at(1)], []), 0)
})
