// A `*/` read resolves only for the storefronts that load the reading file: those whose path
// holds its own cartridge. Two storefronts share a base cartridge and each has a brand cartridge;
// a read in one brand never reaches the other brand's copy. A file whose cartridge is on no path
// gets every copy the paths reach, unlabelled. Completion, hover, definition, signature help and
// references all read it through `moduleCopies`.
import { assert, test } from 'orca/testing'
import { CheckoutIndex } from '../checkout/checkout'
import { MemoryFiles } from '../checkout/memory'
import { complete } from './complete'
import { definition } from './definition'
import { hover, type Hover } from './hover'
import type { QueryContext } from './modules'
import { references } from './references'
import { signatureHelp } from './signature'
import { at, committedDw, dwLookup } from './testing'

const BASE = 'cartridges/app_base_garden/cartridge/scripts/price.js'
const BRAND_A = 'cartridges/app_a_garden/cartridge/scripts/price.js'
const READER_B = 'cartridges/app_b_garden/cartridge/scripts/checkout.js'
const ORPHAN = 'cartridges/app_c_garden/cartridge/scripts/orphan.js'
const READ = "var price = require('*/cartridge/scripts/price');\nprice.total(1);\n"

async function context(): Promise<QueryContext> {
  const project = (name: string) => `<projectDescription><name>${name}</name></projectDescription>`
  const files = new MemoryFiles({
    'cartridges/app_base_garden/.project': project('app_base_garden'),
    [BASE]: '/** The base total. */\nfunction total(p) {}\nmodule.exports = { total: total };\n',
    'cartridges/app_a_garden/.project': project('app_a_garden'),
    [BRAND_A]: 'function total(p, q) {}\nmodule.exports = { total: total, extra: function () {} };\n',
    'cartridges/app_b_garden/.project': project('app_b_garden'),
    [READER_B]: READ,
    'cartridges/app_c_garden/.project': project('app_c_garden'),
    [ORPHAN]: READ,
    'sites/site_template/sites/ShopA/site.xml': '<site site-id="ShopA"><custom-cartridges>app_a_garden:app_base_garden</custom-cartridges></site>',
    'sites/site_template/sites/ShopB/site.xml': '<site site-id="ShopB"><custom-cartridges>app_b_garden:app_base_garden</custom-cartridges></site>'
  })
  const index = new CheckoutIndex(files, { dw: dwLookup })
  await index.build()
  return { index, dw: committedDw() }
}

test('paths: completion and hover of a */ read offer only what the storefronts loading the file run', async () => {
  const ctx = await context()
  const inB = at(READER_B, "var price = require('*/cartridge/scripts/price');\nprice.‸")
  assert.deepEqual(complete(ctx, inB.analysis, inB.offset).items.map((item) => [item.label, item.detail]), [['total', 'total(p)']])
  // In the brand A cartridge, its own copy: `extra` too.
  const inA = at('cartridges/app_a_garden/cartridge/scripts/reader.js', "var price = require('*/cartridge/scripts/price');\nprice.‸")
  assert.deepEqual(complete(ctx, inA.analysis, inA.offset).items.map((item) => [item.label, item.detail]), [['extra', 'extra()'], ['total', 'total(p, q)']])
  const member = at(READER_B, "var price = require('*/cartridge/scripts/price');\nprice.to‸tal(1);")
  const found = hover(ctx, member.analysis, member.offset) as Extract<Hover, { kind: 'module-member' }>
  assert.deepEqual(found.definitions.map((each) => [each.storefronts, each.path]), [[['ShopB'], BASE]])
  const module = at(READER_B, "var price = require('*/cartridge/scripts/pri‸ce');")
  assert.deepEqual((hover(ctx, module.analysis, module.offset) as Extract<Hover, { kind: 'module' }>).copies, [{ storefront: 'ShopB', path: BASE }])
})

test('paths: definition and signature help of a */ read give only the copy that runs', async () => {
  const ctx = await context()
  const read = at(READER_B, "var price = require('*/cartridge/scripts/price');\nprice.to‸tal(1);")
  assert.deepEqual(definition(ctx, read.analysis, read.offset)?.targets.map((each) => [each.path, each.storefronts]), [[BASE, ['ShopB']]])
  const call = at(READER_B, "var price = require('*/cartridge/scripts/price');\nprice.total(‸);")
  assert.deepEqual(signatureHelp(ctx, call.analysis, call.offset)?.signatures.map((each) => [each.label, each.path, each.storefronts]), [['total(p)', BASE, ['ShopB']]])
  // A file on no path: every copy the paths reach, with no storefront named.
  const orphan = at(ORPHAN, "var price = require('*/cartridge/scripts/price');\nprice.to‸tal(1);")
  assert.deepEqual(definition(ctx, orphan.analysis, orphan.offset)?.targets.map((each) => [each.path, each.storefronts]), [[BRAND_A, null], [BASE, null]])
})

test('paths: references of one brand’s override do not list another brand’s reads; the base’s do, with the storefront', async () => {
  const ctx = await context()
  const brand = at(BRAND_A, 'function to‸tal(p, q) {}\nmodule.exports = { total: total, extra: function () {} };\n')
  const ofBrand = references(ctx, brand.analysis, brand.offset)
  assert.deepEqual(ofBrand?.references.filter((each) => each.kind === 'use').map((each) => [each.path, each.storefronts]), [[ORPHAN, null]])
  const base = at(BASE, '/** The base total. */\nfunction to‸tal(p) {}\nmodule.exports = { total: total };\n')
  const ofBase = references(ctx, base.analysis, base.offset)
  assert.deepEqual(
    ofBase?.references.filter((each) => each.kind === 'use').map((each) => [each.path, each.storefronts]),
    [
      [READER_B, ['ShopB']],
      [ORPHAN, null]
    ]
  )
})
