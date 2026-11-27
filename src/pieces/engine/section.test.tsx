// The Problems view in the plugin's own panel, over a stubbed worker (the scenarios' invented
// problems): the counts, the filter and the search, the files with their first problems and the
// button that opens one at its line, a file's detail in place of the list, each state of the view,
// Spanish, every text within the length limit, and 1,000 problems drawn under the size budget.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from '../../panel/panel'
import { treeCost, VIEW_BUDGET } from '../../panel/panel'
import { READY_STATUS } from '../../panel/scenarios'
import { MAX_ROWS, NOTICE_MAX_CHARS, PAGE_SIZE } from '../../panel/ui'
import { format } from '../../core/i18n'
import { messages, problemMessage } from './i18n'
import { PROBLEM_CODES } from './problems/problem'
import { XML_FAULTS } from './problems/xml'
import { JSON_FAULTS } from './problems/json'
import type { ProblemsList } from './protocol'
import { scenarios } from './scenarios'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const PRICE_HELPER = 'cartridges/app_garden_base/cartridge/scripts/helpers/priceHelper.js'

type Sent = { name: string; input: unknown }

/** The panel on the Problems view, its worker answering as a scenario does. */
async function open(name: keyof typeof scenarios, options: { locale?: string; plugin?: Record<string, unknown> } = {}) {
  const scenario = scenarios[name]
  const sent: Sent[] = []
  const requests: Record<string, unknown> = { 'core.status': () => READY_STATUS }
  for (const [request, answer] of Object.entries(scenario.requests ?? {})) {
    requests[request] = (input: unknown) => {
      sent.push({ name: request, input })
      return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : answer
    }
  }
  const host = mockHost({ capabilities: CAPABILITIES, requests })
  const plugin = { view: 'engine', ...(scenario.persisted?.plugin ?? {}), ...(options.plugin ?? {}) }
  panel = await mount(panelModule, { host, locale: options.locale ?? 'en', persisted: { plugin } })
  return { panel, sent }
}

test('the list: counts per severity, when it was analysed, the filter and the search, each file with its first problems', async () => {
  const { panel, sent } = await open('engine')
  assert.deepEqual(panel.errors, [])
  for (const badge of ['5 errors', '8 warnings', '2 notes']) assert.ok(panel.find({ type: 'Badge', text: badge }), badge)
  assert.ok(panel.find({ text: /^Analysed/ }))
  assert.ok(panel.find({ type: 'Select', label: 'Severity' }))
  assert.ok(panel.find({ type: 'Input', label: 'Search the problems' }))
  // The files, by name, each a link to its detail; their problems worded, each with its line.
  assert.ok(panel.find({ type: 'Link', text: 'priceHelper.js' }))
  assert.ok(panel.find({ text: 'No custom attribute gardenSize on Product' }))
  assert.ok(panel.find({ text: 'Line 12' }))
  assert.ok(panel.find({ text: 'Template product/quickView missing on some storefronts' }))
  assert.ok(panel.find({ text: 'Line 34 · GardenShop' }))
  // A file with more than five problems says how many more, in its detail.
  assert.ok(panel.find({ type: 'Button', text: '1 more in this file' }))

  await panel.press({ role: 'button', label: 'Open at line 12' })
  assert.deepEqual(sent.at(-1), { name: 'engine.problems.open', input: { path: PRICE_HELPER, line: 12, column: 28 } })

  await panel.select({ type: 'Select', label: 'Severity' }, 'error')
  assert.equal(panel.persisted.plugin.engineSeverity, 'error')
  assert.deepEqual((sent.filter((each) => each.name === 'engine.problems.list').at(-1)?.input as { severity: string }).severity, 'error')
  assert.equal(panel.find({ text: 'No custom attribute gardenSize on Product' }), null)
  assert.ok(panel.find({ text: 'Route QuickView is not declared: SFRA refuses this' }))

  await panel.select({ type: 'Select', label: 'Severity' }, 'all')
  await panel.type({ type: 'Input', label: 'Search the problems' }, 'steptypes')
  assert.ok(panel.find({ type: 'Link', text: 'steptypes.json' }))
  assert.equal(panel.find({ type: 'Link', text: 'priceHelper.js' }), null)
})

test('a file’s detail opens in place of the list, every problem of it, with a way back', async () => {
  const { panel } = await open('engine')
  await panel.press({ type: 'Link', text: 'priceHelper.js' })
  assert.equal(panel.persisted.plugin.engineFile, PRICE_HELPER)
  assert.ok(panel.find({ text: 'Key label.sale of product missing on some storefronts' }))
  assert.equal(panel.find({ type: 'Link', text: 'steptypes.json' }), null)
  assert.equal(panel.findAll({ role: 'button', label: /^Open at line/ }).length, 6)
  assert.ok(panel.find({ type: 'Button', text: 'Setup' }))
  await panel.press({ role: 'button', label: 'Back to the list' })
  assert.equal(panel.persisted.plugin.engineFile, null)
  assert.ok(panel.find({ type: 'Link', text: 'steptypes.json' }))
})

test('each state of the view: no workspace, indexing, analysing, failed with a retry, clean, nothing matching, analysing again', async () => {
  const expect: [keyof typeof scenarios, Record<string, string>][] = [
    ['engineNone', { type: 'EmptyState', label: 'No workspace to analyse' }],
    ['engineIndexing', { text: 'Indexing the checkout…' }],
    ['engineAnalysing', { text: 'Analysing the checkout…' }],
    ['engineFailed', { type: 'Callout', label: 'Analysis failed' }],
    ['engineClean', { type: 'EmptyState', label: 'No problems' }],
    ['engineNoMatch', { type: 'EmptyState', label: 'Nothing matches' }],
    ['engineBusy', { text: 'Analysing changes…' }]
  ]
  for (const [name, target] of expect) {
    const { panel, sent } = await open(name)
    assert.deepEqual(panel.errors, [], name)
    assert.ok(panel.find(target), `${name}: ${JSON.stringify(target)}`)
    if (name === 'engineFailed') {
      await panel.press({ type: 'Button', text: 'Try again' })
      assert.equal(sent.at(-1)?.name, 'engine.problems.refresh')
    }
    panel.unmount()
  }
})

test('Spanish: the counts, the filter and the messages in Spanish', async () => {
  const { panel } = await open('engine', { locale: 'es' })
  assert.deepEqual(panel.errors, [])
  for (const text of ['5 errores', '8 avisos', '2 notas', 'Product no tiene el atributo personalizado gardenSize', 'Línea 12']) assert.ok(panel.find({ text }), text)
})

test('every text the view and its notice draw fits the limit in both languages, a message with names of a usual length too', () => {
  const args = { name: 'gardenFreeShipping', type: 'GardenWishlist', key: 'label.discount.long', bundle: 'checkout', route: 'ShowQuickView', module: 'app_garden/cartridge/scripts/jobs/x.js', id: 'custom.Garden.Export', element: 'field', attribute: 'missing-error', storefronts: 'GardenShop, GardenOutlet' }
  for (const language of ['en', 'es'] as const) {
    for (const [key, value] of Object.entries(messages[language])) {
      const filled = format(value, { count: 100, files: 12, line: 1234, ...args, storefront: 'GardenOutlet', path: 'cartridges/x.js' })
      assert.ok(filled.length <= NOTICE_MAX_CHARS, `${language} ${key}: ${filled.length} characters`)
    }
    for (const code of PROBLEM_CODES) {
      for (const reason of [...XML_FAULTS, ...JSON_FAULTS]) {
        const text = problemMessage(language, { code, args: { ...args, reason } })
        assert.ok(text.length <= NOTICE_MAX_CHARS, `${language} ${code}: ${text.length} characters`)
        assert.ok(!text.includes('{'), `${language} ${code}: ${text}`)
      }
    }
  }
})

test('1,000 problems: a page drawn, then pages up to the cap, under the size budget by Orca’s measure', async () => {
  const { panel, sent } = await open('engineMany')
  assert.deepEqual(panel.errors, [])
  assert.equal(panel.findAll({ role: 'button', label: /^Open at line/ }).length, PAGE_SIZE)
  for (;;) {
    const more = panel.findAll({ type: 'Button' }).find((button) => /^Show \d+ more$/.test(button.text))
    if (!more) break
    await panel.press(more)
  }
  assert.equal(panel.findAll({ role: 'button', label: /^Open at line/ }).length, MAX_ROWS)
  assert.ok(panel.find({ text: '900 more not shown: narrow the search' }))
  assert.equal((sent.filter((each) => each.name === 'engine.problems.list').at(-1)?.input as { limit: number }).limit, MAX_ROWS)
  const cost = treeCost(panel.tree())
  console.log(`problems at the cap: ${MAX_ROWS} problems, ${Math.round(cost.bytes / 1024)} KiB and ${cost.nodes} nodes by Orca's measure`)
  assert.ok(cost.bytes < VIEW_BUDGET.bytes && cost.nodes < VIEW_BUDGET.nodes)
})

test('a flood of worker posts: at most one list asked at a time, one more after it, and a draw only when the answer changed', async () => {
  // While the engine indexes and analyses, each pass posts once; however fast posts come, the view
  // keeps one request in flight and asks once more after it, never one per post.
  const scenario = scenarios.engine
  const answerOf = scenario.requests?.['engine.problems.list'] as (input: unknown) => unknown
  let asked = 0
  let gate: (() => void) | null = null
  let held = false
  let version = 1
  const host = mockHost({
    capabilities: CAPABILITIES,
    requests: {
      'core.status': () => READY_STATUS,
      'engine.problems.list': async (input: unknown) => {
        asked++
        if (held) await new Promise<void>((resolve) => (gate = resolve))
        return { ...(answerOf(input) as ProblemsList), analysedAt: 1_000_000, version }
      }
    }
  })
  let draws = 0
  panel = await mount({ setup: panelModule.setup, default: () => (draws++, panelModule.default()) }, { host, locale: 'en', persisted: { plugin: { view: 'engine' } } })
  assert.ok(panel.find({ type: 'Badge', text: '5 errors' }))

  // A post whose answer is the same draws nothing.
  let before = draws
  await panel.post('engine.problems.changed', { workspaceId: 'w-garden', counts: { error: 5, warning: 8, info: 2 }, files: 6, version })
  assert.equal(draws, before)

  // Fifty posts while the first answer is held: one request now, one more once it came.
  held = true
  const askedBefore = asked
  for (let i = 0; i < 50; i++) void panel.post('engine.problems.changed', { workspaceId: 'w-garden', counts: { error: 5, warning: 8, info: 2 }, files: 6, version })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(asked - askedBefore, 1)
  held = false
  version++
  before = draws
  ;(gate as (() => void) | null)?.()
  await panel.settled()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await panel.settled()
  assert.equal(asked - askedBefore, 2)
  // The new answer drew once; the one asked after it, the same, drew nothing.
  assert.equal(draws - before, 1)
})
