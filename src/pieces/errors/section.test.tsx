// The errors view in the plugin's own panel, over a stubbed worker: new and seen errors, the
// actions a person takes on them, an environment not ready, a read that failed, and Spanish.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from '../../panel/panel'
import { READY_STATUS } from '../../panel/scenarios'
import type { Role } from '../../core/instances'
import type { ErrorRow, RoleErrors } from './protocol'
import { scenarios } from './scenarios'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const NOW = Date.now()

function row(signature: string, overrides: Partial<ErrorRow> = {}): ErrorRow {
  return {
    signature,
    firstSeen: NOW - 3_600_000,
    lastSeen: NOW - 60_000,
    count: 4,
    markedAt: null,
    message: `TypeError: ${signature} is undefined`,
    logger: 'custom.Cart',
    frames: [
      { file: 'app_example/cartridge/scripts/cart.js', function: 'total', line: 12, openable: true },
      { file: 'Engine.java', function: 'example.Engine.run', line: 3, openable: false }
    ],
    ...overrides
  }
}

function answer(role: Role, overrides: Partial<RoleErrors> = {}): RoleErrors {
  return { role, state: 'ready', reading: false, lastRead: NOW - 120_000, error: null, missedSince: null, intervalMinutes: 0, rows: [], ...overrides }
}

type Sent = { name: string; input: unknown }

/** The panel with the errors view open, its worker answering with `state`. */
async function open(state: (role: Role) => RoleErrors, options: { locale?: string; role?: Role } = {}) {
  const sent: Sent[] = []
  const respond = (name: string) => (input: unknown) => {
    sent.push({ name, input })
    return state((input as { role: Role }).role)
  }
  const host = mockHost({
    capabilities: CAPABILITIES,
    requests: {
      'core.status': () => READY_STATUS,
      'errors.list': respond('errors.list'),
      'errors.refresh': respond('errors.refresh'),
      'errors.mark': respond('errors.mark'),
      'errors.forget': respond('errors.forget'),
      'errors.open': (input: unknown) => {
        sent.push({ name: 'errors.open', input })
        return { opened: false, reason: 'not_in_workspace' }
      }
    }
  })
  panel = await mount(panelModule, { host, locale: options.locale ?? 'en', persisted: { plugin: { view: 'errors', ...(options.role ? { errorsRole: options.role } : {}) } } })
  return { panel, sent }
}

test('new errors and seen ones, each with its count, and the actions on them', async () => {
  let rows = [row('alpha'), row('beta', { count: 1 }), row('gamma', { markedAt: NOW - 1000 })]
  const { panel, sent } = await open((role) => answer(role, { rows }))
  assert.deepEqual(panel.errors, [])
  assert.ok(panel.find({ text: 'New' }))
  assert.ok(panel.find({ text: 'Seen' }))
  assert.ok(panel.find({ text: 'TypeError: alpha is undefined' }))
  assert.ok(panel.find({ text: '4×' }))
  assert.ok(panel.find({ text: '1×' }))
  assert.ok(panel.find({ type: 'Button', text: 'Read now' }))

  // Mark all sends every new signature, and only those.
  rows = rows.map((item) => ({ ...item, markedAt: item.markedAt ?? NOW }))
  await panel.press({ type: 'Button', text: 'Mark all as seen' })
  assert.deepEqual(sent.at(-1), { name: 'errors.mark', input: { role: 'sandbox', signatures: ['alpha', 'beta'] } })
  assert.ok(panel.find({ text: /^Nothing new/ }))
  assert.equal(panel.find({ type: 'Button', text: 'Mark all as seen' }), null)

  await panel.press({ type: 'Button', text: 'Read now' })
  assert.deepEqual(sent.at(-1), { name: 'errors.refresh', input: { role: 'sandbox' } })
})

test('a single error is marked, or forgotten once seen, from its details', async () => {
  const rows = [row('alpha'), row('gamma', { markedAt: NOW - 1000 })]
  const { panel, sent } = await open((role) => answer(role, { rows }))
  const details = panel.findAll({ type: 'Collapsible', label: 'Details' })
  assert.equal(details.length, 2)
  await panel.toggle(details[0])
  await panel.press({ type: 'Button', text: 'Mark as seen' })
  assert.deepEqual(sent.at(-1), { name: 'errors.mark', input: { role: 'sandbox', signatures: ['alpha'] } })
  await panel.toggle(panel.findAll({ type: 'Collapsible', label: 'Details' })[1])
  await panel.press({ type: 'Button', text: 'Forget' })
  assert.deepEqual(sent.at(-1), { name: 'errors.forget', input: { role: 'sandbox', signature: 'gamma' } })
})

test('a frame in the workspace is a link that asks the worker to open it', async () => {
  const { panel, sent } = await open((role) => answer(role, { rows: [row('alpha')] }))
  await panel.toggle(panel.findAll({ type: 'Collapsible', label: 'Details' })[0])
  assert.ok(panel.find({ text: 'Engine.java:3 · example.Engine.run' }))
  await panel.press({ text: 'cart.js:12 · total' })
  assert.deepEqual(sent.at(-1), { name: 'errors.open', input: { role: 'sandbox', signature: 'alpha', frame: 0 } })
  // The stub answers that the script is not in the workspace: the view says so.
  assert.ok(panel.find({ text: 'That script is not in a cartridge of the workspace.' }))
})

test('no errors: an empty state that says what brings some', async () => {
  const { panel } = await open((role) => answer(role))
  const empty = panel.find({ type: 'EmptyState', label: 'No errors' })
  assert.match(String(empty?.props.description), /^Read now to look at the sandbox log/)
  assert.equal(panel.find({ text: 'New' }), null)
})

test('an environment that is not ready says so, and offers no read', async () => {
  const { panel, sent } = await open((role) => answer(role, { state: 'absent', lastRead: null }), { role: 'production' })
  assert.deepEqual(sent[0], { name: 'errors.list', input: { role: 'production' } })
  assert.ok(panel.find({ type: 'EmptyState', label: 'Production is not ready' }))
  assert.equal(panel.find({ type: 'Button', text: 'Read now' }), null)
  assert.ok(panel.find({ text: 'Only when asked' }))
})

test('a read that failed shows why, worded, with a retry; the rows read before stay', async () => {
  const { panel, sent } = await open((role) => answer(role, { error: 'b2c_timeout', rows: [row('alpha')] }))
  assert.match(panel.summary().join('\n'), /The log could not be read/)
  assert.ok(panel.find({ text: 'b2c took too long and was stopped.' }))
  assert.ok(panel.find({ text: 'TypeError: alpha is undefined' }))
  const retries = panel.findAll({ type: 'Button', text: 'Read now' })
  await panel.press(retries[retries.length - 1])
  assert.deepEqual(sent.at(-1), { name: 'errors.refresh', input: { role: 'sandbox' } })
})

test('a read that may have skipped entries says so, with the time', async () => {
  const { panel } = await open((role) => answer(role, { rows: [row('alpha')], missedSince: Date.UTC(2026, 10, 26, 8, 30) }))
  assert.match(panel.summary().join('\n'), /Entries may be missing/)
  assert.ok(panel.find({ text: /^Some entries since .*2026.* may have been missed: b2c reads only the end of each log file/ }))
})

test('a frame that could not be opened says why, under a title of its own', async () => {
  const { panel } = await open((role) => answer(role, { rows: [row('alpha')] }))
  await panel.toggle(panel.findAll({ type: 'Collapsible', label: 'Details' })[0])
  await panel.press({ text: 'cart.js:12 · total' })
  assert.match(panel.summary().join('\n'), /File not opened/)
})

test('picking another environment asks the worker for it', async () => {
  const { panel, sent } = await open((role) => answer(role, { rows: role === 'staging' ? [row('stg')] : [] }))
  await panel.select({ label: 'Environment' }, 'staging')
  assert.deepEqual(sent.at(-1), { name: 'errors.list', input: { role: 'staging' } })
  assert.ok(panel.find({ text: 'TypeError: stg is undefined' }))
  assert.equal(panel.persisted.plugin.errorsRole, 'staging')
})

test('Read now shows the read running at once, and its rows when the worker tells it ended', async () => {
  let state: Partial<RoleErrors> = {}
  const { panel, sent } = await open((role) => answer(role, state))
  // The worker answers the request at once, still reading.
  state = { reading: true }
  await panel.press({ type: 'Button', text: 'Read now' })
  assert.deepEqual(sent.at(-1), { name: 'errors.refresh', input: { role: 'sandbox' } })
  const button = panel.find({ type: 'Button', text: 'Reading…' })
  assert.ok(button)
  assert.equal(button.disabled, true)
  // The read ends: the event brings the list.
  state = { reading: false, rows: [row('late')] }
  await panel.post('errors.changed', { role: 'sandbox', newCount: 1 })
  assert.ok(panel.find({ text: 'TypeError: late is undefined' }))
  assert.ok(panel.find({ type: 'Button', text: 'Read now' }))
})

test('an older answer that arrives after a newer one is dropped: Read now never sticks on Reading…', async () => {
  const version = (seq: number) => ({ worker: 'worker-a', seq })
  let latest = answer('sandbox', { version: version(1) })
  const host = mockHost({
    capabilities: CAPABILITIES,
    requests: {
      'core.status': () => READY_STATUS,
      'errors.list': () => latest,
      // The answer to Read now is slow: it was made while the read ran (still reading, the old
      // time), and comes back after the newer list.
      'errors.refresh': () => new Promise<RoleErrors>((resolve) => setTimeout(() => resolve(answer('sandbox', { reading: true, version: version(2) })), 50))
    }
  })
  panel = await mount(panelModule, { host, locale: 'en', persisted: { plugin: { view: 'errors' } } })
  const pressing = panel.press({ type: 'Button', text: 'Read now' })
  // The read ends first: the event brings the newer list at once.
  latest = answer('sandbox', { lastRead: NOW, rows: [row('late')], version: version(3) })
  await Promise.all([pressing, panel.post('errors.changed', { role: 'sandbox', newCount: 1 })])
  // The older answer arrived last, still reading, with the old time: it was dropped.
  assert.ok(panel.find({ type: 'Button', text: 'Read now' }), 'not stuck on Reading…')
  assert.equal(panel.find({ type: 'Button', text: 'Reading…' }), null)
  assert.ok(panel.find({ text: 'TypeError: late is undefined' }))

  // An answer of another worker (Orca restarted it) is always kept, whatever its number.
  latest = answer('sandbox', { rows: [row('restarted')], version: { worker: 'worker-b', seq: 1 } })
  await panel.post('errors.changed', { role: 'sandbox', newCount: 1 })
  assert.ok(panel.find({ text: 'TypeError: restarted is undefined' }))
})

test('the worker telling of a change redraws the environment on screen', async () => {
  let rows: ErrorRow[] = []
  const { panel } = await open((role) => answer(role, { rows }))
  assert.ok(panel.find({ type: 'EmptyState', label: 'No errors' }))
  rows = [row('fresh')]
  await panel.post('errors.changed', { role: 'sandbox', newCount: 1 })
  assert.ok(panel.find({ text: 'TypeError: fresh is undefined' }))
})

test('in Spanish', async () => {
  const { panel } = await open((role) => answer(role, { rows: [row('alpha'), row('gamma', { markedAt: NOW })], intervalMinutes: 5 }), { locale: 'es-ES' })
  for (const words of ['Nuevos', 'Vistos', 'Leer ahora', 'Cada 5 min', 'Última lectura']) assert.ok(panel.find({ text: words }), words)
})

test('every scenario of the piece draws its view without an error', async () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    const host = mockHost({ capabilities: CAPABILITIES, ...scenario, requests: { 'core.status': () => READY_STATUS, ...scenario.requests } })
    panel = await mount(panelModule, { host, persisted: { plugin: { view: 'errors', ...scenario.persisted?.plugin } } })
    assert.deepEqual(panel.errors, [], name)
    assert.deepEqual(panel.warnings, [], name)
    panel.unmount()
    panel = undefined
  }
})
