// Each language feature against a fake engine: what it asks (one text per change, the offset, the
// file named or a stand-in), what it draws from the answer, its keys, and that an answer made stale
// by a newer key, text or request is never drawn. The clock is the test's: nothing waits for real.
import { assert, test } from 'orca/testing'
import type { Completion, CompletionItem, EngineHoverResult, Problem, SignatureHelp } from '../../engine/protocol'
import { REASK_DELAY_MS, DESCRIBE_DELAY_MS, filterItems, opensAfter } from './completion'
import { NO_WORKSPACE, STAND_IN } from './document'
import { featureKey, SHORTCUTS } from './keys'
import { PROBLEMS_DELAY_MS } from './problems'
import { SIGNATURE_DELAY_MS, splitLabel } from './signature'
import { FakeEngine, harness, located, READY, settle } from './testing'

const TEMPLATE = 'cartridges/app_garden_base/cartridge/templates/default/checks/editor.isml'
const SCRIPT = 'cartridges/app_garden_base/cartridge/scripts/checks/editor.js'

const item = (label: string, kind: CompletionItem['kind'] = 'method', detail: string | null = null): CompletionItem => ({ label, kind, detail, id: `dw:${label}` })
const completion = (items: CompletionItem[], start: number, end: number, context: Completion['context'] = 'member'): { index: 'ready'; error: null; completion: Completion } => ({
  ...READY,
  completion: { context, range: { start, end }, items, truncated: false, guessed: false }
})
const problem = (code: Problem['code'], severity: Problem['severity'], start: number, end: number, args: Problem['args'] = {}): Problem => ({ code, severity, start, end, line: 1, column: start + 1, args })

// ---------------------------------------------------------------------------------------------
// Completion

test('completion opens after a dot, lists the engine’s items with their kind and detail, and Enter replaces exactly the range the engine said', async () => {
  const engine = new FakeEngine()
  const h = harness('var product = ProductMgr.getProduct(id);\nproduct‸;', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  h.type('.')
  const asked = engine.last('complete')
  // The engine is asked on the text now, at the caret, for the file named.
  assert.deepEqual(Object.keys(asked.input).sort(), ['offset', 'path', 'text', 'workspaceId'])
  assert.equal(asked.input.path, SCRIPT)
  assert.equal(asked.input.workspaceId, 'w-shop')
  assert.equal(asked.input.offset, h.offset())
  assert.equal(asked.input.text, h.model.buffer.text())
  const at = h.offset()
  asked.resolve(completion([item('getName', 'method', 'getName(): String'), item('getID', 'method', 'getID(): String'), item('custom', 'property', 'custom: CustomAttributes')], at, at))
  await settle()
  const list = h.ui.now().list
  assert.ok(list)
  assert.equal(list.role, 'completion')
  assert.deepEqual(list.items.map((each) => [each.label, each.detail, each.note]), [
    ['getName', 'getName(): String', 'method'],
    ['getID', 'getID(): String', 'method'],
    ['custom', 'custom: CustomAttributes', 'property']
  ])
  assert.equal(list.selected, 0)
  assert.deepEqual(list.anchor, h.document.posOf(at))
  assert.equal(h.key('ArrowDown'), true)
  assert.equal(h.ui.now().list?.selected, 1)
  assert.equal(h.key('Enter'), true)
  assert.equal(h.model.buffer.text(), 'var product = ProductMgr.getProduct(id);\nproduct.getID;')
  assert.equal(h.ui.now().list, null)
  assert.deepEqual(h.model.selection.head, { line: 1, col: 'product.getID'.length })
})

test('typing filters the open list at once, before the engine answers again; the newer answer replaces it; Tab accepts over the typed word', async () => {
  const engine = new FakeEngine()
  const h = harness('product‸', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  h.type('.')
  const at = h.offset()
  engine.last('complete').resolve(completion([item('getName'), item('getID'), item('custom', 'property')], at, at))
  await settle()
  const before = engine.of('complete').length
  h.type('ge')
  // Filtered in the frame with no request answered: what starts with the typed text.
  assert.deepEqual(h.ui.now().list?.items.map((each) => each.label), ['getName', 'getID'])
  assert.equal(engine.of('complete').length, before, 'asked again only after a pause')
  h.clock.advance(REASK_DELAY_MS)
  const again = engine.last('complete')
  assert.equal(again.input.offset, at + 2)
  again.resolve(completion([item('getID'), item('getName')], at, at + 2))
  await settle()
  assert.deepEqual(h.ui.now().list?.items.map((each) => each.label), ['getID', 'getName'])
  assert.equal(h.ui.now().list?.selected, 1, 'the selection stays on its item when a newer answer reorders the list')
  assert.equal(h.key('Tab'), true)
  assert.equal(h.model.buffer.text(), 'product.getName')
})

test('an answer for an older text or offset is never drawn: the newest request wins', async () => {
  const engine = new FakeEngine()
  const h = harness('product‸', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  h.key(' ', { ctrl: true })
  const first = engine.last('complete')
  // A key before the answer: the text is newer than the one asked on.
  h.type('.')
  const second = engine.last('complete')
  assert.notEqual(first, second)
  first.resolve(completion([item('stale')], 0, 7))
  await settle()
  assert.equal(h.ui.now().list, null, 'the answer for the older text is dropped')
  const at = h.offset()
  second.resolve(completion([item('fresh')], at, at))
  await settle()
  assert.deepEqual(h.ui.now().list?.items.map((each) => each.label), ['fresh'])
  // The caret moved away from the offset asked: dropped too.
  h.key('Escape')
  h.key(' ', { ctrl: true })
  const third = engine.last('complete')
  h.model.setSelection({ line: 0, col: 0 })
  third.resolve(completion([item('moved')], 0, 0))
  await settle()
  assert.equal(h.ui.now().list, null)
})

test('the completion list’s keys: arrows wrap, Page keys jump, Escape closes; with no list the keys go to the editor', async () => {
  const engine = new FakeEngine()
  const h = harness('x‸', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  assert.equal(h.key('ArrowDown'), false, 'no list: the editor moves the caret')
  assert.equal(h.key('Enter'), false)
  assert.equal(h.key('Escape'), false)
  h.type('.')
  const at = h.offset()
  engine.last('complete').resolve(completion(Array.from({ length: 20 }, (_, i) => item(`m${i}`)), at, at))
  await settle()
  assert.equal(h.key('ArrowUp'), true)
  assert.equal(h.ui.now().list?.selected, 19, 'up from the first wraps to the last')
  assert.equal(h.key('ArrowDown'), true)
  assert.equal(h.ui.now().list?.selected, 0)
  assert.equal(h.key('PageDown'), true)
  assert.equal(h.ui.now().list?.selected, 8)
  assert.equal(h.key('PageUp'), true)
  assert.equal(h.ui.now().list?.selected, 0)
  // Shift+arrows select text: the editor's.
  assert.equal(h.key('ArrowDown', { shift: true }), false)
  assert.equal(h.key('Escape'), true)
  assert.equal(h.ui.now().list, null)
  assert.equal(h.model.buffer.text(), 'x.')
})

test('Ctrl+Space asks anywhere and says when there is nothing; the selected item’s description is asked by its id once the selection rests', async () => {
  const engine = new FakeEngine()
  const h = harness('<isprint value="${x}"/>\n‸', { requests: engine.requests, identity: located(TEMPLATE) })
  assert.equal(h.key(' ', { ctrl: true }), true)
  engine.last('complete').resolve(completion([], h.offset(), h.offset(), 'none'))
  await settle()
  assert.equal(h.ui.now().list, null)
  assert.deepEqual(h.ui.hints, ['No suggestions here'])
  h.type('<is')
  const at = h.offset() - 2
  engine.last('complete').resolve(completion([item('isprint', 'tag'), item('isif', 'tag')], at, at + 2, 'tag'))
  await settle()
  assert.deepEqual(h.ui.now().list?.items.map((each) => each.note), ['tag', 'tag'])
  h.clock.advance(DESCRIBE_DELAY_MS)
  const described = engine.last('hover')
  assert.equal(described.input.id, 'dw:isprint')
  const tag: EngineHoverResult = { kind: 'tag', name: 'isprint', custom: false, attributes: ['value', 'encoding'], template: null, copies: [], range: null, description: null, descriptionError: null }
  described.resolve({ ...READY, hover: tag })
  await settle()
  assert.deepEqual(h.ui.now().list?.description?.map((each) => each.text), ['<isprint>', 'Attributes: value, encoding'])
  // Another selection: the old description is not drawn over it.
  h.key('ArrowDown')
  assert.equal(h.ui.now().list?.description, null)
})

test('the list opens by itself only where the engine may answer', () => {
  assert.equal(opensAfter('product.', '.', false), true)
  assert.equal(opensAfter('product.ge', 'e', false), true)
  assert.equal(opensAfter("require('", "'", false), true)
  assert.equal(opensAfter("Resource.msg('label.", '.', false), true)
  assert.equal(opensAfter('${', '{', true), true)
  assert.equal(opensAfter('<', '<', true), true)
  assert.equal(opensAfter('<isp', 'p', true), true)
  assert.equal(opensAfter('<isprint ', ' ', true), true)
  assert.equal(opensAfter('<isprint value="${x}" ', ' ', true), true)
  // Plain words, numbers, text of a template, a closing tag's end: nothing to ask.
  assert.equal(opensAfter('var total', 'l', false), false)
  assert.equal(opensAfter('1.', '.', false), false)
  assert.equal(opensAfter('<p>Hello', 'o', true), false)
  assert.equal(opensAfter('<', '<', false), false)
  assert.equal(opensAfter('product.', '..', false), false)
  assert.deepEqual(filterItems([item('getID'), item('custom'), item('isGift')], 'i').map((each) => each.label), ['isGift', 'getID'])
})

// ---------------------------------------------------------------------------------------------
// Hover

const member: EngineHoverResult = {
  kind: 'dw-member',
  classId: 'dw.catalog.ProductMgr',
  name: 'getProduct',
  members: [{ kind: 'method', owner: 'dw.catalog.ProductMgr', key: 'getProduct(String)', signature: 'static getProduct(productID: String): Product', static: true, deprecated: false, link: 'https://developer.example.com/dw.catalog.ProductMgr' }],
  describe: { classId: 'dw.catalog.ProductMgr', memberKey: 'getProduct(String)' },
  range: { start: 11, end: 21 },
  description: 'Returns the product with the given id.',
  descriptionError: null
}

test('hover: the pointer rests on a name, the engine’s data is worded, and it closes once the pointer leaves the range', async () => {
  const engine = new FakeEngine()
  const h = harness('ProductMgr.getProduct(id);', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  h.features.pointerRest(14, h.clock.now)
  const asked = engine.last('hover')
  assert.equal(asked.input.offset, 14)
  asked.resolve({ ...READY, hover: member })
  await settle()
  assert.deepEqual(h.ui.now().hover?.sections, [
    { tone: 'code', text: 'static getProduct(productID: String): Product' },
    { tone: 'muted', text: 'dw.catalog.ProductMgr' },
    { tone: 'text', text: 'Returns the product with the given id.' }
  ])
  assert.equal(h.ui.now().hover?.link, 'https://developer.example.com/dw.catalog.ProductMgr')
  assert.deepEqual(h.ui.now().hover?.anchor, { line: 0, col: 11 })
  // Resting again inside the same range asks nothing.
  h.features.pointerRest(18, h.clock.now)
  assert.equal(engine.of('hover').length, 1)
  h.features.pointerMoved(16, false)
  assert.ok(h.ui.now().hover, 'still inside')
  h.features.pointerMoved(2, false)
  assert.equal(h.ui.now().hover, null)
})

test('hover by key (Mod+I) at the caret; Escape and a caret move close it; a text change drops a late answer', async () => {
  const engine = new FakeEngine()
  const h = harness('ProductMgr.getPro‸duct(id);', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  assert.equal(h.key('i', { ctrl: true }), true)
  engine.last('hover').resolve({ ...READY, hover: member })
  await settle()
  assert.ok(h.ui.now().hover)
  assert.equal(h.key('Escape'), true)
  assert.equal(h.ui.now().hover, null)
  h.key('i', { ctrl: true })
  engine.last('hover').resolve({ ...READY, hover: member })
  await settle()
  h.model.setSelection({ line: 0, col: 2 })
  assert.equal(h.ui.now().hover, null)
  // Asked, then the text changed: the answer is for an older text.
  h.key('i', { ctrl: true })
  const late = engine.last('hover')
  h.type('x')
  late.resolve({ ...READY, hover: member })
  await settle()
  assert.equal(h.ui.now().hover, null)
  // On a Mac the key is Cmd+I; Ctrl+I is left to the editor there.
  const mac = harness('x', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript', isMac: true })
  assert.equal(mac.key('i', { ctrl: true }), false)
  assert.equal(mac.key('i', { meta: true }), true)
})

test('a hover is drawn at once with its dw.* description being read, which is then waited for and drawn in; a late page or a failure is said', async () => {
  const engine = new FakeEngine()
  const h = harness('ProductMgr.getProduct(id);', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  h.features.pointerRest(14, h.clock.now)
  // Asked so the worker answers at once, without waiting for the description.
  assert.equal(engine.last('hover').input.describe, 'cached')
  engine.last('hover').resolve({ ...READY, hover: { ...member, description: null, descriptionError: 'pending' } })
  await settle()
  assert.equal(h.ui.now().hover?.sections[0].text, 'static getProduct(productID: String): Product')
  assert.equal(h.ui.now().hover?.sections.at(-1)?.text, 'Reading the description…')
  // Then asked once more, waiting for it.
  assert.equal(engine.of('hover').length, 2)
  assert.equal(engine.last('hover').input.describe, 'wait')
  engine.last('hover').resolve({ ...READY, hover: member })
  await settle()
  assert.equal(h.ui.now().hover?.sections.at(-1)?.text, 'Returns the product with the given id.')
  assert.equal(engine.of('hover').length, 2, 'asked once more, not again')
  assert.equal(h.times.hover?.length, 1, 'the time measured is the first draw')
  // A description read already comes with the first answer: nothing more is asked.
  h.features.pointerRest(1, h.clock.now)
  engine.last('hover').resolve({ ...READY, hover: { ...member, range: { start: 0, end: 10 } } })
  await settle()
  assert.equal(engine.of('hover').length, 3)
  // The hover moved on while its description was read: the late description is not drawn over it.
  h.features.pointerRest(14, h.clock.now)
  engine.last('hover').resolve({ ...READY, hover: { ...member, description: null, descriptionError: 'pending' } })
  await settle()
  const waiting = engine.last('hover')
  h.type('x')
  waiting.resolve({ ...READY, hover: member })
  await settle()
  assert.equal(h.ui.now().hover, null)
  // A page that did not come in time, or that failed, says so in the engine's words.
  h.features.pointerRest(1, h.clock.now)
  engine.last('hover').resolve({ ...READY, hover: { ...member, range: { start: 0, end: 10 }, description: null, descriptionError: 'pending' } })
  await settle()
  engine.last('hover').resolve({ ...READY, hover: { ...member, range: { start: 0, end: 10 }, description: null, descriptionError: 'timeout' } })
  await settle()
  assert.equal(h.ui.now().hover?.sections.at(-1)?.text, 'The description took too long to read.')
  h.features.pointerRest(14, h.clock.now)
  engine.last('hover').resolve({ ...READY, hover: { ...member, description: null, descriptionError: 'b2c_not_found' } })
  await settle()
  assert.equal(h.ui.now().hover?.sections.at(-1)?.text, 'The description could not be read.')
})

// ---------------------------------------------------------------------------------------------
// Problems

test('problems are asked after a pause in typing, not per key, and drawn as squiggles by severity; the hover says their message', async () => {
  const engine = new FakeEngine()
  const text = "var c = product.custom.gardenNothing;\nvar s = Site.current.getCustomPreferenceValue('gardenNone');"
  const h = harness(text, { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  h.features.identityChanged()
  const first = engine.last('problems')
  assert.deepEqual(Object.keys(first.input).sort(), ['path', 'text', 'workspaceId'])
  const name = text.indexOf('gardenNothing')
  const pref = text.indexOf('gardenNone')
  first.resolve({ ...READY, problems: [problem('unknown_attribute', 'warning', name, name + 13, { name: 'gardenNothing', type: 'Product' }), problem('unknown_preference', 'warning', pref, pref + 10, { name: 'gardenNone' })] })
  await settle()
  assert.deepEqual(
    h.ui.underlinesNow().map((each) => [each.from, each.to, each.tone]),
    [
      [{ line: 0, col: 23 }, { line: 0, col: 36 }, 'warning'],
      [{ line: 1, col: 47 }, { line: 1, col: 57 }, 'warning']
    ]
  )
  // Typing: nothing asked per key, once after the pause.
  h.model.setSelection({ line: 0, col: 0 })
  const count = engine.of('problems').length
  h.type('ab')
  h.clock.advance(PROBLEMS_DELAY_MS - 1)
  h.type('c')
  h.clock.advance(PROBLEMS_DELAY_MS - 1)
  assert.equal(engine.of('problems').length, count)
  // Meanwhile the squiggles moved with the text.
  assert.deepEqual(h.ui.underlinesNow()[0].from, { line: 0, col: 26 })
  h.clock.advance(1)
  assert.equal(engine.of('problems').length, count + 1)
  // The hover over a squiggle says its message at once, with or without the engine's own words.
  h.features.pointerRest(name + 3 + 5, h.clock.now)
  assert.deepEqual(h.ui.now().hover?.sections, [{ tone: 'warning', text: 'No custom attribute gardenNothing on Product' }])
})

test('an answer of problems for an older text is dropped; a file not identified asks nothing and draws none', async () => {
  const engine = new FakeEngine()
  const h = harness('var a = 1;', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  h.features.identityChanged()
  const old = engine.last('problems')
  h.type('x')
  old.resolve({ ...READY, problems: [problem('unknown_attribute', 'warning', 0, 3)] })
  await settle()
  assert.deepEqual(h.ui.underlinesNow(), [])
  h.clock.advance(PROBLEMS_DELAY_MS)
  engine.last('problems').resolve({ ...READY, problems: [problem('template_missing', 'error', 0, 3, { name: 'x' })] })
  await settle()
  assert.deepEqual(h.ui.underlinesNow().map((each) => each.tone), ['error'])
  // The file is no longer named (its text matches no file): squiggles go, nothing is asked.
  const before = engine.of('problems').length
  h.identity.set({ state: 'unknown' })
  assert.deepEqual(h.ui.underlinesNow(), [])
  h.type('y')
  h.clock.advance(PROBLEMS_DELAY_MS * 2)
  assert.equal(engine.of('problems').length, before)
})

// ---------------------------------------------------------------------------------------------
// Go to definition and references

test('F12: one place in this file moves the caret; one in another file opens it in this editor at its line', async () => {
  const engine = new FakeEngine()
  const text = 'function price(p) { return p; }\nvar total = pri‸ce(item);'
  const h = harness(text, { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  assert.equal(h.key('F12'), true)
  engine.last('definition').resolve({ ...READY, definition: { kind: 'declaration', range: { start: 44, end: 49 }, targets: [{ path: SCRIPT, start: 9, end: 14, line: 1, storefronts: null }] } })
  await settle()
  assert.deepEqual(h.revealed.at(-1), { line: 0, col: 9 })
  assert.equal(engine.of('open').length, 0)
  // A module member in another file.
  h.key('F12')
  engine.last('definition').resolve({ ...READY, definition: { kind: 'member', range: { start: 44, end: 49 }, targets: [{ path: 'cartridges/app_garden_core/cartridge/scripts/helpers/priceHelper.js', start: 120, end: 125, line: 7, storefronts: ['GardenShop'] }] } })
  await settle()
  assert.deepEqual(engine.last('open').input, { workspaceId: 'w-shop', path: 'cartridges/app_garden_core/cartridge/scripts/helpers/priceHelper.js', line: 7 })
  engine.last('open').resolve({ opened: false, reason: 'not_found' })
  await settle()
  assert.equal(h.ui.hints.at(-1), 'The file is no longer there.')
  // Nothing there.
  h.key('F12')
  engine.last('definition').resolve({ ...READY, definition: null })
  await settle()
  assert.equal(h.ui.hints.at(-1), 'No definition found')
})

test('several places (one per storefront) are a list labelled with their storefronts; arrows and Enter open one, Escape closes; Mod+click asks at the pointer', async () => {
  const engine = new FakeEngine()
  const text = '<isinclude template="product/components/price"/>'
  const h = harness(text, { requests: engine.requests, identity: located(TEMPLATE) })
  h.features.definitionAt(25, h.clock.now)
  assert.equal(engine.last('definition').input.offset, 25)
  const targets = [
    { path: 'cartridges/app_garden_core/cartridge/templates/default/product/components/price.isml', start: 0, end: 0, line: 1, storefronts: ['GardenShop'] },
    { path: 'cartridges/app_garden_outlet/cartridge/templates/default/product/components/price.isml', start: 0, end: 0, line: 1, storefronts: ['GardenOutlet'] }
  ]
  engine.last('definition').resolve({ ...READY, definition: { kind: 'template', range: { start: 21, end: 46 }, targets } })
  await settle()
  const list = h.ui.now().list
  assert.equal(list?.role, 'definition')
  assert.equal(list?.title, '2 definitions')
  assert.deepEqual(list?.items.map((each) => [each.label, each.detail]), [
    ['price.isml:1', 'GardenShop · cartridges/app_garden_core/cartridge/templates/default/product/components'],
    ['price.isml:1', 'GardenOutlet · cartridges/app_garden_outlet/cartridge/templates/default/product/components']
  ])
  assert.equal(h.key('ArrowDown'), true)
  assert.equal(h.key('Enter'), true)
  await settle()
  assert.deepEqual(engine.last('open').input, { workspaceId: 'w-shop', path: targets[1].path, line: 1 })
  assert.equal(h.ui.now().list, null)
  h.features.definitionAt(25, h.clock.now)
  engine.last('definition').resolve({ ...READY, definition: { kind: 'template', range: { start: 21, end: 46 }, targets } })
  await settle()
  assert.equal(h.key('Escape'), true)
  assert.equal(h.ui.now().list, null)
  assert.equal(engine.of('open').length, 1)
})

test('Shift+F12: the references as a list of file, line and storefronts; one in this file moves the caret', async () => {
  const engine = new FakeEngine()
  const text = 'function price(p) { return p; }\nmodule.exports = { pri‸ce: price };'
  const h = harness(text, { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  assert.equal(h.key('F12', { shift: true }), true)
  engine.last('references').resolve({
    ...READY,
    references: {
      range: { start: 51, end: 56 },
      name: 'price',
      defining: [SCRIPT],
      truncated: false,
      references: [
        { path: SCRIPT, start: 9, end: 14, line: 1, kind: 'definition', storefronts: ['GardenShop', 'GardenOutlet'] },
        { path: 'cartridges/app_garden_base/cartridge/controllers/Product.js', start: 300, end: 305, line: 12, kind: 'use', storefronts: ['GardenShop'] }
      ]
    }
  })
  await settle()
  assert.equal(h.ui.now().list?.title, '2 references to price')
  assert.deepEqual(h.ui.now().list?.items.map((each) => [each.label, each.note]), [
    ['editor.js:1', 'definition'],
    ['Product.js:12', 'line 12']
  ])
  h.key('Enter')
  await settle()
  assert.deepEqual(h.revealed.at(-1), { line: 0, col: 9 })
  h.key('F12', { shift: true })
  engine.last('references').resolve({ ...READY, references: null })
  await settle()
  assert.equal(h.ui.hints.at(-1), 'No references: only an exported function has them')
})

test('a file not identified asks under no workspace and a stand-in name: only its own declarations are found, and another file is never opened', async () => {
  const engine = new FakeEngine()
  const h = harness('var total = 1;\ntot‸al;', { requests: engine.requests, identity: { state: 'unknown' }, language: 'javascript' })
  h.key('F12')
  const asked = engine.last('definition')
  assert.equal(asked.input.workspaceId, NO_WORKSPACE)
  assert.equal(asked.input.path, STAND_IN.javascript)
  asked.resolve({ ...READY, index: 'none', definition: { kind: 'member', range: { start: 15, end: 20 }, targets: [{ path: 'elsewhere.js', start: 0, end: 0, line: 3, storefronts: null }] } })
  await settle()
  assert.equal(engine.of('open').length, 0)
  assert.equal(h.ui.hints.at(-1), 'No definition in this file, and the file is not identified')
  // No answer state is told for it: 7.1's notice says the file is not identified, once.
  assert.ok(!h.ui.hints.some((each) => each.includes('workspace analysed')))
  // XML not identified: nothing to ask.
  const xml = harness('<form/>', { requests: engine.requests, identity: { state: 'unknown' }, language: 'xml' })
  const count = engine.asked.length
  xml.key(' ', { ctrl: true })
  xml.key('F12')
  assert.equal(engine.asked.length, count)
})

test('the index not ready, or another workspace indexed, is said once, not per key', async () => {
  const engine = new FakeEngine()
  engine.handlers.complete = (input) => ({ index: 'building', error: null, completion: { context: 'member', range: { start: input.offset, end: input.offset }, items: [item('a')], truncated: false, guessed: false } })
  const h = harness('x‸', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  for (let i = 0; i < 3; i++) {
    h.key(' ', { ctrl: true })
    await settle()
  }
  assert.deepEqual(h.ui.hints, ['The checkout is still being indexed: answers may be partial.'])
})

// ---------------------------------------------------------------------------------------------
// Signature help

const help: SignatureHelp = {
  range: { start: 22, end: 24 },
  activeSignature: 0,
  activeParameter: 1,
  signatures: [
    { label: 'price(product, currency)', parameters: [{ label: 'product', type: null }, { label: 'currency', type: null }], source: 'module', deprecated: false, link: null, describe: null, path: 'cartridges/app_garden_core/cartridge/scripts/helpers/priceHelper.js', line: 4, doc: 'The price of a product.', storefronts: ['GardenShop'] },
    { label: 'price(product)', parameters: [{ label: 'product', type: null }], source: 'module', deprecated: false, link: null, describe: null, path: 'cartridges/app_garden_base/cartridge/scripts/helpers/priceHelper.js', line: 2, doc: null, storefronts: ['GardenOutlet'] }
  ]
}

test('signature help opens after ( and , with the active parameter marked, follows the caret, and Escape closes it', async () => {
  const engine = new FakeEngine()
  const h = harness('priceHelper.price‸', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  h.type('(')
  engine.last('signature').resolve({ ...READY, signature: { ...help, activeParameter: 0 } })
  await settle()
  assert.deepEqual([h.ui.now().signature?.before, h.ui.now().signature?.active, h.ui.now().signature?.after], ['price(', 'product', ', currency)'])
  assert.equal(h.ui.now().signature?.note, '1 of 2')
  assert.deepEqual(h.ui.now().signature?.sections.map((each) => each.text), ['The price of a product.', 'Defined in cartridges/app_garden_core/cartridge/scripts/helpers/priceHelper.js, line 4', 'Runs on GardenShop'])
  h.type('p,')
  engine.last('signature').resolve({ ...READY, signature: help })
  await settle()
  assert.equal(h.ui.now().signature?.active, 'currency')
  // Arrows are the editor's while only the signature shows.
  assert.equal(h.key('ArrowLeft'), false)
  h.model.setSelection({ line: 0, col: 3 })
  h.clock.advance(SIGNATURE_DELAY_MS)
  engine.last('signature').resolve({ ...READY, signature: null })
  await settle()
  assert.equal(h.ui.now().signature, null, 'outside the parentheses it closes')
  h.key(' ', { ctrl: true, shift: true })
  engine.last('signature').resolve({ ...READY, signature: help })
  await settle()
  assert.ok(h.ui.now().signature)
  assert.equal(h.key('Escape'), true)
  assert.equal(h.ui.now().signature, null)
  assert.deepEqual(splitLabel({ label: 'f(a, b)', parameters: [{ label: 'a', type: null }, { label: 'b', type: null }] }, 1), { before: 'f(a, ', active: 'b', after: ')' })
  assert.deepEqual(splitLabel({ label: 'f()', parameters: [] }, 0), { before: 'f()', active: '', after: '' })
})

// ---------------------------------------------------------------------------------------------
// One text per change, typing never waits, the keys

test('every request of one text sends the same string, built once; typing goes on while every answer is pending', () => {
  const engine = new FakeEngine()
  const h = harness('ProductMgr.getProduct(‸)', { requests: engine.requests, identity: located(SCRIPT), language: 'javascript' })
  const buffer = h.model.buffer
  const text = buffer.text.bind(buffer)
  let built = 0
  buffer.text = () => {
    built++
    return text()
  }
  h.key(' ', { ctrl: true })
  h.key(' ', { ctrl: true, shift: true })
  h.key('i', { ctrl: true })
  h.key('F12')
  const texts = engine.asked.map((each) => each.input.text)
  assert.equal(texts.length, 4)
  for (const each of texts) assert.equal(each, texts[0])
  assert.equal(built, 1, 'the text of one version is joined once for every feature')
  // No answer has come: the keys still type.
  h.type('id')
  assert.equal(h.model.buffer.text(), 'ProductMgr.getProduct(id)')
})

test('the keys are F12, Shift+F12, Ctrl+Space, Ctrl+Shift+Space and Mod+I, none of Orca’s own shortcuts', () => {
  const press = (key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) => ({ key, ctrl: false, meta: false, alt: false, shift: false, ...mods })
  assert.equal(featureKey(press('F12'), false), 'definition')
  assert.equal(featureKey(press('F12', { shift: true }), false), 'references')
  assert.equal(featureKey(press(' ', { ctrl: true }), false), 'complete')
  assert.equal(featureKey(press(' ', { ctrl: true }), true), 'complete')
  assert.equal(featureKey(press(' ', { ctrl: true, shift: true }), false), 'signature')
  assert.equal(featureKey(press('i', { ctrl: true }), false), 'hover')
  assert.equal(featureKey(press('i', { meta: true }), true), 'hover')
  // Orca's keybinding list (Mod is Ctrl off a Mac): none of them is taken.
  const orca: [string, { ctrl?: boolean; shift?: boolean; alt?: boolean }][] = [
    ['p', { ctrl: true }], ['k', { ctrl: true }], ['e', { ctrl: true }], ['b', { ctrl: true }], ['l', { ctrl: true }], ['n', { ctrl: true }],
    ['E', { ctrl: true, shift: true }], ['F', { ctrl: true, shift: true }], ['G', { ctrl: true, shift: true }], ['R', { ctrl: true, shift: true }],
    ['t', { ctrl: true }], ['w', { ctrl: true }], ['f', { ctrl: true }], ['s', { ctrl: true }], ['z', { alt: true }], ['F7', {}], ['F7', { shift: true }],
    ['a', { ctrl: true, alt: true }], ['c', { ctrl: true, alt: true }], ['A', { ctrl: true, shift: true }], ['V', { ctrl: true, shift: true }], ['Tab', { ctrl: true }]
  ]
  for (const [key, mods] of orca) assert.equal(featureKey(press(key, mods), false), null, `${key} ${JSON.stringify(mods)}`)
  assert.deepEqual(Object.keys(SHORTCUTS).sort(), ['complete', 'definition', 'hover', 'references', 'signature'])
})
