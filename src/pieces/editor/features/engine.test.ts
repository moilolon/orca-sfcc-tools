// The features against the real engine, in process: the engine piece's worker mounted over the
// invented checkout of src/pieces/engine/fixtures/ (`checkout/` with `problems/` over it), answering
// through the same requests the frame sends. On an invented template and script of that checkout: a
// completion list accepted, a hover, a squiggle and its message, a go to definition (one place per
// storefront, and one place that opens directly), signature help and references.
import { assert, test } from 'orca/testing'
import { harness, located, realEngine, settle, WORKSPACE } from './testing'

const TEMPLATE = 'cartridges/app_garden_base/cartridge/templates/default/checks/editor.isml'
const SCRIPT = 'cartridges/app_garden_base/cartridge/scripts/checks/editor.js'

const ISML = [
  '<isdecorate template="checks/layout">',
  '    <isinclude template="product/components/price" />',
  "    <span>${Resource.msg('label.price', 'product', null)}</span>",
  "    <span>${Resource.msg('label.gone', 'product', null)}</span>",
  '    ‸',
  '</isdecorate>'
].join('\n')

const JS = [
  "var ProductMgr = require('dw/catalog/ProductMgr');",
  "var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');",
  'function show(id) {',
  '    var product = ‸;',
  '    var colour = product.custom.gardenColour;',
  '    var wrong = product.custom.gardenNothing;',
  '    return priceHelper.price(product);',
  '}'
].join('\n')

test('on an invented template, the real engine: a completion list accepted, a hover, squiggles with their message, a definition per storefront', async () => {
  const engine = await realEngine()
  try {
    const h = harness(ISML, { requests: engine.requests, identity: located(TEMPLATE) })
    // Completion: typing an ISML tag opens the list by itself; typing on filters it; Enter takes the item.
    h.type('<isp')
    await settle()
    const list = h.ui.now().list
    assert.equal(list?.role, 'completion')
    assert.equal(list?.items[0].label, 'isprint')
    assert.equal(list?.items[0].note, 'tag')
    assert.deepEqual(list?.anchor, { line: 4, col: 5 })
    assert.equal(h.key('Enter'), true)
    assert.equal(h.model.buffer.line(4), '    <isprint')
    // Problems of the editor's text, after a pause: the decorated template and the key no storefront has.
    h.features.identityChanged()
    await settle()
    assert.deepEqual(
      h.ui.underlinesNow().map((each) => [h.model.buffer.slice(each.from, each.to), each.tone]),
      [
        ['checks/layout', 'warning'],
        ['label.gone', 'warning']
      ]
    )
    const text = h.document.text()
    // Hover on a squiggle: its message, then the engine's own words of the key.
    h.features.pointerRest(text.indexOf('label.gone') + 3, 0)
    await settle()
    assert.equal(h.ui.now().hover?.sections.at(-1)?.tone, 'warning')
    assert.match(h.ui.now().hover?.sections.at(-1)?.text ?? '', /label\.gone/)
    // Hover on a key: its value on each storefront, and where it is defined.
    h.features.pointerRest(text.indexOf('label.price') + 3, 0)
    await settle()
    const sections = h.ui.now().hover?.sections.map((each) => each.text) ?? []
    assert.equal(sections[0], 'product › label.price')
    assert.ok(sections.includes('GardenShop: Our price'))
    assert.ok(sections.includes('Defined in cartridges/app_garden_core/cartridge/templates/resources/product.properties, line 2'))
    // Definition of the included template: one copy per storefront, labelled, the chosen one opened.
    h.features.definitionAt(text.indexOf('product/components') + 3, 0)
    await settle()
    assert.equal(h.ui.now().list?.title, '2 definitions')
    assert.deepEqual(h.ui.now().list?.items.map((each) => each.detail?.split(' · ')[0]).sort(), ['GardenOutlet', 'GardenShop'])
    h.key('Enter')
    await settle()
    assert.equal(engine.opened.length, 1)
    assert.equal(engine.opened[0].workspaceId, WORKSPACE)
    assert.match(engine.opened[0].path, /^cartridges\/app_garden_(core|outlet)\/cartridge\/templates\/default\/product\/components\/price\.isml$/)
    // A key both storefronts read from one file: opened directly at its line.
    h.features.definitionAt(text.indexOf('label.price') + 3, 0)
    await settle()
    assert.deepEqual(engine.opened[1], { workspaceId: WORKSPACE, path: 'cartridges/app_garden_core/cartridge/templates/resources/product.properties', line: 2 })
  } finally {
    await engine.dispose()
  }
})

test('on an invented script, the real engine: dw.* completion, a hover with its description, a squiggle, definition, signature help and references', async () => {
  const engine = await realEngine()
  try {
    const h = harness(JS, { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
    h.type('ProductMgr.getP')
    await settle()
    assert.deepEqual(h.ui.now().list?.items.map((each) => [each.label, each.detail]), [['getProduct', 'static getProduct(productID: String): Product']])
    h.clock.advance(150)
    await settle()
    assert.equal(h.ui.now().list?.description?.at(-1)?.text, 'An invented description of getProduct(String).')
    h.key('Tab')
    h.type('(id)')
    assert.equal(h.model.buffer.line(3), '    var product = ProductMgr.getProduct(id);')
    h.features.identityChanged()
    await settle()
    assert.deepEqual(
      h.ui.underlinesNow().map((each) => [h.model.buffer.slice(each.from, each.to), each.tone]),
      [['gardenNothing', 'warning']]
    )
    const text = h.document.text()
    h.features.pointerRest(text.indexOf('gardenNothing') + 2, 0)
    await settle()
    assert.deepEqual(h.ui.now().hover?.sections.at(-1), { tone: 'warning', text: 'No custom attribute gardenNothing on Product' })
    h.features.pointerRest(text.indexOf('getProduct') + 2, 0)
    await settle()
    assert.deepEqual(
      h.ui.now().hover?.sections.map((each) => each.text),
      ['static getProduct(productID: String): Product', 'dw.catalog.ProductMgr', 'An invented description of getProduct(String).']
    )
    // Definition of a module member: the copy every storefront runs, opened at once at its line.
    h.features.definitionAt(text.indexOf('price(product)') + 2, 0)
    await settle()
    assert.equal(h.ui.now().list, null)
    assert.deepEqual(engine.opened, [{ workspaceId: WORKSPACE, path: 'cartridges/app_garden_core/cartridge/scripts/helpers/priceHelper.js', line: 11 }])
    // Signature help inside the call.
    h.model.setSelection(h.document.posOf(text.indexOf('price(product)') + 'price('.length))
    h.key(' ', { ctrl: true, shift: true })
    await settle()
    assert.equal(h.ui.now().signature?.active, 'product')
    h.key('Escape')
    // References of the exported function, read where it is used.
    h.model.setSelection(h.document.posOf(text.indexOf('price(product)') + 2))
    h.key('F12', { shift: true })
    await settle()
    const references = h.ui.now().list
    assert.equal(references?.role, 'references')
    assert.match(references?.title ?? '', /references to price$/)
    assert.ok(references?.items.some((each) => each.label === 'editor.js:7'))
    assert.ok(references?.items.some((each) => each.label === 'Product.js:13'))
  } finally {
    await engine.dispose()
  }
})
