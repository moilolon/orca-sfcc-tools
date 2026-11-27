// The latency of each feature: the time from the key (or the pointer's rest, or the end of the pause
// for problems) to the answer drawn, on a 3,000-line template and a 3,000-line script of invented
// text, each request asked right after an edit (so the worker reads the new text, as after a real
// key). Two workers: a fake one whose answers are canned, and the real engine in process over the
// invented checkout. Both cross a modelled bridge: the request and its answer are cloned
// (`structuredClone`, the real cost of the text crossing) and each way waits `HOP_MS`, an assumed
// cost of the frame-to-worker hops that a live check measures for real. The numbers are printed;
// the bounds asserted are loose enough for a busy machine (the suite runs in parallel). Also: what
// a key itself costs the features while answers are pending (typing never waits for one).
import { assert, test } from 'orca/testing'
import type { EngineHoverResult, Problem } from '../../engine/protocol'
import { largeScript } from '../../engine/fixtures/generate'
import type { FeatureName } from './context'
import type { EngineRequests } from './requests'
import { harness, located, realEngine, type Harness } from './testing'

/** Each way of the bridge between the editor frame and the worker: an assumption, measured live. */
export const HOP_MS = 4
const SAMPLES = 12
/** Loose bounds of the median, for a busy machine: canned answers, and the real engine. */
const FAKE_BOUND_MS = 120
const REAL_BOUND_MS = 600
/** What a key may cost the features while every answer is pending (median). */
const KEY_BOUND_MS = 4

const TEMPLATE = 'cartridges/app_garden_base/cartridge/templates/default/checks/large.isml'
const SCRIPT = 'cartridges/app_garden_base/cartridge/scripts/checks/large.js'

/** An invented template of at least `lines` lines: includes, conditions, loops, keys, links. */
function largeTemplate(lines: number): string {
  let text = '<isdecorate template="common/layout/page">\n'
  let n = 0
  while (text.split('\n').length < lines) {
    text += [
      `<div class="garden-row garden-row-${n}">`,
      `    <isif condition="\${pdict.rows && pdict.rows.length > ${n}}">`,
      '        <isloop items="${pdict.rows}" var="row" status="loop">',
      "            <span>${Resource.msg('label.price', 'product', null)} ${row.price}</span>",
      '            <isinclude template="product/components/price" />',
      '        </isloop>',
      '    <iselse/>',
      "        <a href=\"${URLUtils.url('Product-Show', 'pid', pdict.pid)}\">${pdict.name}</a>",
      '    </isif>',
      '</div>',
      ''
    ].join('\n')
    n++
  }
  return text + '</isdecorate>\n'
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits `ms` to the tenth of a millisecond, yielding meanwhile (a timer rounds up to ~15 ms on Windows). */
async function sleep(ms: number): Promise<void> {
  const end = performance.now() + ms
  while (performance.now() < end) await new Promise((resolve) => setImmediate(resolve))
}

/** The requests behind a modelled bridge: cloned both ways, `HOP_MS` each way. */
function bridged(inner: EngineRequests): EngineRequests {
  const cross = <I, O>(run: (input: I) => Promise<O>) => async (input: I): Promise<O> => {
    const sent = structuredClone(input)
    await sleep(HOP_MS)
    const answer = await run(sent)
    await sleep(HOP_MS)
    return structuredClone(answer)
  }
  return {
    complete: cross(inner.complete),
    hover: cross(inner.hover),
    definition: cross(inner.definition),
    references: cross(inner.references),
    signature: cross(inner.signature),
    problems: cross(inner.problems),
    open: cross(inner.open)
  }
}

const READY = { index: 'ready' as const, error: null }
const memberHover: EngineHoverResult = {
  kind: 'dw-member',
  classId: 'dw.catalog.ProductMgr',
  name: 'getProduct',
  members: [{ kind: 'method', owner: 'dw.catalog.ProductMgr', key: 'getProduct(String)', signature: 'static getProduct(productID: String): Product', static: true, deprecated: false, link: 'https://developer.example.com/x' }],
  describe: { classId: 'dw.catalog.ProductMgr' },
  range: null,
  description: 'An invented description.',
  descriptionError: null
}

/** Canned answers, sized like real ones: 60 items, 20 references, 40 problems. */
const canned: EngineRequests = {
  complete: async (query) => ({
    ...READY,
    completion: { context: 'member', range: { start: query.offset, end: query.offset }, items: Array.from({ length: 60 }, (_, i) => ({ label: `member${i}`, kind: 'method' as const, detail: `member${i}(a: String): Number`, id: `dw:x#member${i}` })), truncated: false, guessed: false }
  }),
  hover: async (query) => ({ ...READY, hover: { ...memberHover, range: { start: query.offset, end: query.offset + 4 } } }),
  definition: async (query) => ({ ...READY, definition: { kind: 'module', range: { start: query.offset, end: query.offset + 4 }, targets: [{ path: 'cartridges/app_garden_base/cartridge/scripts/util/collections.js', start: 0, end: 0, line: 1, storefronts: ['GardenShop'] }] } }),
  references: async (query) => ({
    ...READY,
    references: { range: { start: query.offset, end: query.offset + 4 }, name: 'total', defining: [SCRIPT], truncated: false, references: Array.from({ length: 20 }, (_, i) => ({ path: `cartridges/app_garden_base/cartridge/controllers/C${i}.js`, start: 10, end: 15, line: i + 1, kind: 'use' as const, storefronts: ['GardenShop'] })) }
  }),
  signature: async (query) => ({
    ...READY,
    signature: { range: { start: query.offset, end: query.offset }, activeSignature: 0, activeParameter: 0, signatures: [{ label: 'getProduct(productID: String): Product', parameters: [{ label: 'productID: String', type: 'String' }], source: 'dw', deprecated: false, link: null, describe: null, path: null, line: null, doc: null, storefronts: null }] }
  }),
  problems: async (query) => ({
    ...READY,
    problems: Array.from({ length: 40 }, (_, i): Problem => {
      const start = Math.floor((query.text.length / 41) * (i + 1))
      return { code: 'unknown_attribute', severity: 'warning', start, end: start + 5, line: 1, column: 1, args: { name: 'x', type: 'Product' } }
    })
  }),
  open: async () => ({ opened: true })
}

type Stats = { median: number; p95: number; worst: number }
const stats = (samples: readonly number[]): Stats => {
  const sorted = [...samples].sort((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], worst: sorted[sorted.length - 1] }
}

/** Waits until the feature has drawn one more answer than `before`. */
async function drawn(h: Harness, feature: FeatureName, before: number): Promise<void> {
  const end = performance.now() + 15_000
  while ((h.times[feature]?.length ?? 0) <= before) {
    if (performance.now() > end) throw new Error(`${feature}: no answer drawn`)
    await wait(1)
  }
}

/** An edit away from the place measured: the worker reads a new text for the next request. */
function edit(h: Harness, n: number): void {
  const line = h.model.buffer.lineCount - 2
  h.model.edit({ line, col: 0 }, { line, col: 0 }, `<!-- ${n} -->`, 'insert')
}

/**
 * Measures one feature `SAMPLES` times on a text of its own (an earlier feature's keys never break
 * the code it asks about): `ask` sets the place and asks; the time is the controller's own, from
 * the key to the draw.
 */
async function measure(make: () => Harness, feature: FeatureName, ask: (h: Harness, n: number) => void): Promise<Stats> {
  const h = make()
  try {
    for (let n = 0; n < SAMPLES; n++) {
      h.features.dismiss()
      edit(h, n)
      const before = h.times[feature]?.length ?? 0
      ask(h, n)
      await drawn(h, feature, before)
    }
    return stats((h.times[feature] ?? []).slice(-SAMPLES))
  } finally {
    h.features.dispose()
  }
}

/** The place after `needle`'s occurrence for sample `n` (spread over the text, wrapping), as a position. */
function after(h: Harness, needle: string, n: number, shift = needle.length) {
  const text = h.document.text()
  const all: number[] = []
  for (let at = text.indexOf(needle); at !== -1 && all.length < 500; at = text.indexOf(needle, at + 1)) all.push(at)
  return h.document.posOf(all[(n * 7) % all.length] + shift)
}

async function scriptTimes(requests: EngineRequests): Promise<Record<string, Stats>> {
  const script = largeScript(3000)
  const make = () => harness(script, { requests, identity: located(SCRIPT), language: 'javascript', realTime: true })
  assert.ok(script.split('\n').length >= 3000)
  const out: Record<string, Stats> = {}
  out.complete = await measure(make, 'complete', (h, n) => {
    h.model.setSelection(after(h, 'var product = ProductMgr', n))
    h.type('.')
  })
  out.hover = await measure(make, 'hover', (h, n) => h.features.pointerRest(h.document.offsetOf(after(h, 'getProduct(item', n, 3)), performance.now()))
  out.signature = await measure(make, 'signature', (h, n) => {
    h.model.setSelection(after(h, 'ProductMgr.getProduct(', n))
    h.key(' ', { ctrl: true, shift: true })
  })
  out.definition = await measure(make, 'definition', (h) => {
    h.model.setSelection(after(h, "require('*/cartridge/scripts/util/coll", 0))
    h.key('F12')
  })
  out.references = await measure(make, 'references', (h, n) => {
    h.model.setSelection(after(h, 'module.exports.total', n))
    h.key('F12', { shift: true })
  })
  out.problems = await measure(make, 'problems', (h) => void h.features.problems.run(performance.now()))
  // A key while every answer is pending: the features' own work, synchronous.
  const pending: EngineRequests = { ...requests, complete: () => new Promise(() => {}), signature: () => new Promise(() => {}), problems: () => new Promise(() => {}) }
  const k = harness(script, { requests: pending, identity: located(SCRIPT), language: 'javascript', realTime: true })
  k.model.setSelection(after(k, 'var product = ProductMgr', 3))
  const keys: number[] = []
  for (const char of '.getProduct(item.productID, item.quantity, basket.UUID') {
    const started = performance.now()
    k.type(char)
    keys.push(performance.now() - started)
  }
  out.key = stats(keys.slice(5))
  k.features.dispose()
  return out
}

async function templateTimes(requests: EngineRequests): Promise<Record<string, Stats>> {
  const template = largeTemplate(3000)
  const make = () => harness(template, { requests, identity: located(TEMPLATE), realTime: true })
  assert.ok(template.split('\n').length >= 3000)
  const out: Record<string, Stats> = {}
  out.complete = await measure(make, 'complete', (h, n) => {
    h.model.setSelection(after(h, "<span>${Resource.msg('label.price', 'product', null)}", n))
    h.type('<')
  })
  out.hover = await measure(make, 'hover', (h, n) => h.features.pointerRest(h.document.offsetOf(after(h, "Resource.msg('label.pr", n)), performance.now()))
  out.definition = await measure(make, 'definition', (h, n) => {
    h.model.setSelection(after(h, 'template="product/comp', n))
    h.key('F12')
  })
  out.problems = await measure(make, 'problems', (h) => void h.features.problems.run(performance.now()))
  return out
}

function print(title: string, times: Record<string, Stats>): void {
  const rows = Object.entries(times).map(([name, each]) => `  ${name.padEnd(11)} median ${each.median.toFixed(1).padStart(6)} ms   p95 ${each.p95.toFixed(1).padStart(6)} ms   worst ${each.worst.toFixed(1).padStart(6)} ms`)
  console.log(`${title}\n${rows.join('\n')}`)
}

test('latency: from the key to the drawn answer, on a 3,000-line script and template, with canned answers and with the real engine', async () => {
  const fakeScript = await scriptTimes(bridged(canned))
  const fakeTemplate = await templateTimes(bridged(canned))
  const engine = await realEngine()
  let realScript: Record<string, Stats>
  let realTemplate: Record<string, Stats>
  try {
    realScript = await scriptTimes(bridged(engine.requests))
    realTemplate = await templateTimes(bridged(engine.requests))
  } finally {
    await engine.dispose()
  }
  print(`canned answers, ${HOP_MS} ms each way, 3,000-line script`, fakeScript)
  print(`canned answers, ${HOP_MS} ms each way, 3,000-line template`, fakeTemplate)
  print(`real engine, ${HOP_MS} ms each way, 3,000-line script`, realScript)
  print(`real engine, ${HOP_MS} ms each way, 3,000-line template`, realTemplate)
  for (const [name, each] of [...Object.entries(fakeScript), ...Object.entries(fakeTemplate)]) {
    if (name !== 'key') assert.ok(each.median < FAKE_BOUND_MS, `canned ${name}: median ${each.median.toFixed(1)} ms`)
  }
  for (const [name, each] of [...Object.entries(realScript), ...Object.entries(realTemplate)]) {
    if (name !== 'key') assert.ok(each.median < REAL_BOUND_MS, `real ${name}: median ${each.median.toFixed(1)} ms`)
  }
  assert.ok(fakeScript.key.median < KEY_BOUND_MS, `a key costs the features ${fakeScript.key.median.toFixed(2)} ms`)
})
