// The errors view in the plugin's own panel, over a stubbed worker: short rows of new and seen
// errors, the detail of one in place of the list (its state, times, actions, fields, message with
// placeholders as code, and frames), an environment not ready, a read that failed, and Spanish.
import { messages as pieceMessages } from './i18n'
import { NOTICE_MAX_CHARS } from '../../panel/ui'
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
    pipeline: 'Cart-Show',
    level: 'ERROR',
    frames: [
      { file: 'app_example/cartridge/scripts/cart.js', function: 'total', line: 12, openable: true, path: 'cartridges/app_example/cartridge/scripts/cart.js' },
      { file: 'Engine.java', function: 'example.Engine.run', line: 3, openable: false, path: null }
    ],
    ...overrides
  }
}

function answer(role: Role, overrides: Partial<RoleErrors> = {}): RoleErrors {
  return { role, state: 'ready', reading: false, lastRead: NOW - 120_000, error: null, missedSince: null, intervalMinutes: 0, rows: [], ...overrides }
}

type Sent = { name: string; input: unknown }

/** The panel with the errors view open, its worker answering with `state`. */
async function open(state: (role: Role) => RoleErrors, options: { locale?: string; role?: Role; detail?: string } = {}) {
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
      },
      // The debugger's answer is its whole state, which this view does not read.
      'debugger.breakpoint': ((input: unknown) => {
        sent.push({ name: 'debugger.breakpoint', input })
        return {}
      }) as never
    }
  })
  const plugin = { view: 'errors', ...(options.role ? { errorsRole: options.role } : {}), ...(options.detail ? { errorsDetail: options.detail } : {}) }
  panel = await mount(panelModule, { host, locale: options.locale ?? 'en', persisted: { plugin } })
  return { panel, sent }
}

test('the list: a short row per error, new ones first, seen ones folded; mark all and read now', async () => {
  let rows = [row('alpha'), row('beta', { count: 1 }), row('gamma', { markedAt: NOW - 1000 })]
  const { panel, sent } = await open((role) => answer(role, { rows }))
  assert.deepEqual(panel.errors, [])
  assert.ok(panel.find({ text: 'New' }))
  assert.ok(panel.find({ type: 'Collapsible', label: 'Seen (1)' }))
  assert.ok(panel.find({ type: 'Link', text: 'TypeError: alpha is undefined' }))
  assert.ok(panel.find({ text: '4×' }))
  assert.ok(panel.find({ text: '1×' }))
  // A row is short: no details folded under it, no frames, no logger.
  assert.equal(panel.find({ type: 'Collapsible', label: 'Details' }), null)
  assert.equal(panel.find({ text: /cart\.js/ }), null)
  assert.ok(panel.find({ type: 'Button', text: 'Read now' }))

  // A new row marks itself as seen from its own button.
  await panel.press({ role: 'button', label: 'Mark seen' })
  assert.deepEqual(sent.at(-1), { name: 'errors.mark', input: { role: 'sandbox', signatures: ['alpha'] } })

  // Mark all sends every new signature, and only those.
  rows = rows.map((item) => ({ ...item, markedAt: item.markedAt ?? NOW }))
  await panel.press({ type: 'Button', text: 'Mark all seen' })
  assert.deepEqual(sent.at(-1), { name: 'errors.mark', input: { role: 'sandbox', signatures: ['alpha', 'beta'] } })
  assert.ok(panel.find({ text: 'Nothing new' }))
  assert.equal(panel.find({ type: 'Button', text: 'Mark all seen' }), null)

  await panel.press({ type: 'Button', text: 'Read now' })
  assert.deepEqual(sent.at(-1), { name: 'errors.refresh', input: { role: 'sandbox' } })
})

test('pressing a row opens its detail in place of the list, remembered, with a way back', async () => {
  const { panel } = await open((role) => answer(role, { rows: [row('alpha'), row('beta')] }))
  await panel.press({ type: 'Link', text: 'TypeError: alpha is undefined' })
  assert.equal(panel.persisted.plugin.errorsDetail, 'alpha')
  // The list is gone; the detail is there, the bar still above it.
  assert.equal(panel.find({ type: 'Link', text: 'TypeError: beta is undefined' }), null)
  assert.ok(panel.find({ text: 'Stack trace' }))
  assert.ok(panel.find({ type: 'Button', text: 'Setup' }))
  await panel.press({ role: 'button', label: 'All errors' })
  assert.equal(panel.persisted.plugin.errorsDetail, null)
  assert.ok(panel.find({ type: 'Link', text: 'TypeError: beta is undefined' }))
})

test('the detail: state, count, times, the fields of the first line as rows, and the message with its placeholders as code', async () => {
  const message = 'Payment failed for order #, amount #.# EUR, reference <code> on <host>'
  const { panel } = await open((role) => answer(role, { rows: [row('alpha', { message, count: 27 })] }), { detail: 'alpha' })
  assert.deepEqual(panel.errors, [])
  assert.ok(panel.find({ type: 'Badge', text: 'New' }))
  assert.ok(panel.find({ type: 'Badge', text: '27×' }))
  for (const label of ['Last', 'First']) assert.ok(panel.find({ text: label }), label)
  assert.equal(panel.findAll({ type: 'RelativeTime' }).length >= 2, true)
  for (const [label, value] of [
    ['Controller', 'Cart-Show'],
    ['Logger', 'custom.Cart'],
    ['Level', 'ERROR']
  ]) {
    assert.ok(panel.find({ text: label }), label)
    assert.ok(panel.find({ text: value }), value)
  }
  // Each placeholder is its own piece of code; the words around it are plain text.
  assert.deepEqual(
    panel.findAll({ type: 'Code' }).map((code) => code.text).filter((text) => !text.includes('.js') && !text.includes('.java')),
    ['#', '#.#', '<code>', '<host>']
  )
})

test('the frames: a workspace frame stands out with open and add breakpoint; a platform frame is muted, with neither', async () => {
  const { panel, sent } = await open((role) => answer(role, { rows: [row('alpha')] }), { detail: 'alpha' })
  // The function, then the file and line as code.
  assert.ok(panel.find({ text: 'total', type: 'Text' }))
  assert.ok(panel.find({ type: 'Code', text: 'app_example/cartridge/scripts/cart.js:12' }))
  assert.ok(panel.find({ type: 'Code', text: 'Engine.java:3' }))
  assert.equal(panel.find({ type: 'Text', text: 'example.Engine.run' })?.props.muted, true)
  assert.equal(panel.find({ type: 'Text', text: 'total' })?.props.muted, undefined)
  // One open and one breakpoint button per workspace frame, plus the header's own.
  assert.equal(panel.findAll({ role: 'button', label: 'Open file' }).length, 1)
  assert.equal(panel.findAll({ role: 'button', label: 'Add breakpoint here' }).length, 1)
  await panel.press({ role: 'button', label: 'Open file' })
  assert.deepEqual(sent.at(-1), { name: 'errors.open', input: { role: 'sandbox', signature: 'alpha', frame: 0 } })
  // The stub answers that the script is not in the workspace: the view says so.
  assert.match(panel.summary().join('\n'), /File not opened/)
  assert.ok(panel.find({ text: 'That script is not in a cartridge of the workspace.' }))
  // A breakpoint goes to the debugger's store, at the frame's path in the workspace and its line.
  await panel.press({ role: 'button', label: 'Add breakpoint here' })
  assert.deepEqual(sent.at(-1), { name: 'debugger.breakpoint', input: { path: 'cartridges/app_example/cartridge/scripts/cart.js', line: 12, on: true } })
  assert.ok(panel.find({ text: 'Breakpoint added at cart.js:12' }))
})

test('the detail’s own actions: open the top frame’s file, add a breakpoint there, mark seen, forget', async () => {
  let rows = [row('alpha')]
  const { panel, sent } = await open((role) => answer(role, { rows }), { detail: 'alpha' })
  await panel.press({ type: 'Button', text: 'Open file' })
  assert.deepEqual(sent.at(-1), { name: 'errors.open', input: { role: 'sandbox', signature: 'alpha', frame: 0 } })
  await panel.press({ type: 'Button', text: 'Add breakpoint here' })
  assert.deepEqual(sent.at(-1), { name: 'debugger.breakpoint', input: { path: 'cartridges/app_example/cartridge/scripts/cart.js', line: 12, on: true } })
  rows = [row('alpha', { markedAt: NOW })]
  await panel.press({ type: 'Button', text: 'Mark seen' })
  assert.deepEqual(sent.at(-1), { name: 'errors.mark', input: { role: 'sandbox', signatures: ['alpha'] } })
  assert.ok(panel.find({ type: 'Badge', text: 'Seen' }))
  rows = []
  await panel.press({ type: 'Button', text: 'Forget' })
  assert.deepEqual(sent.at(-1), { name: 'errors.forget', input: { role: 'sandbox', signature: 'alpha' } })
  // A forgotten error is gone: the detail closes with it.
  assert.equal(panel.persisted.plugin.errorsDetail, null)
  assert.ok(panel.find({ type: 'EmptyState', label: 'No errors' }))
})

test('an error with no stack trace, or none in the workspace, offers no file and no breakpoint', async () => {
  const { panel } = await open((role) => answer(role, { rows: [row('alpha', { frames: [] }), row('beta', { frames: [row('x').frames[1]] })] }), { detail: 'alpha' })
  assert.ok(panel.find({ text: 'No stack trace in the entry.' }))
  assert.equal(panel.find({ role: 'button', text: 'Open file' }), null)
  assert.equal(panel.find({ role: 'button', text: 'Add breakpoint here' }), null)
  await panel.press({ role: 'button', label: 'All errors' })
  await panel.press({ type: 'Link', text: 'TypeError: beta is undefined' })
  assert.ok(panel.find({ type: 'Code', text: 'Engine.java:3' }))
  assert.equal(panel.find({ role: 'button', label: 'Add breakpoint here' }), null)
})

test('no errors: an empty state that says what brings some', async () => {
  const { panel } = await open((role) => answer(role))
  const empty = panel.find({ type: 'EmptyState', label: 'No errors' })
  assert.equal(empty?.props.description, 'Read now to look at the sandbox log.')
  assert.equal(panel.find({ text: 'New' }), null)
})

test('an environment that is not ready says so in one line that leads to the setup, and offers no read', async () => {
  const { panel, sent } = await open((role) => answer(role, { state: 'absent', lastRead: null }), { role: 'production' })
  assert.deepEqual(sent[0], { name: 'errors.list', input: { role: 'production' } })
  assert.ok(panel.find({ text: 'Production not set up' }))
  assert.equal(panel.find({ type: 'Callout' }), null, 'the status line says it already: no callout')
  assert.equal(panel.find({ type: 'Button', text: 'Read now' }), null)
  assert.ok(panel.find({ text: /by hand/ }))
  await panel.press({ type: 'Button', text: 'Open setup' })
  assert.equal(panel.persisted.plugin.view, 'setup')
})

test('a read that failed shows why, worded, with a retry; the rows read before stay', async () => {
  const { panel, sent } = await open((role) => answer(role, { error: 'b2c_timeout', rows: [row('alpha')] }))
  assert.match(panel.summary().join('\n'), /Log not read/)
  assert.ok(panel.find({ text: 'b2c took too long and was stopped.' }))
  assert.ok(panel.find({ type: 'Link', text: 'TypeError: alpha is undefined' }))
  await panel.press({ type: 'Button', text: 'Retry' })
  assert.deepEqual(sent.at(-1), { name: 'errors.refresh', input: { role: 'sandbox' } })
})

test('a read that may have skipped entries says so in one line, with the time', async () => {
  const { panel } = await open((role) => answer(role, { rows: [row('alpha')], missedSince: Date.UTC(2026, 10, 26, 8, 30) }))
  assert.ok(panel.find({ text: /^Some entries may have been missed since .*2026/ }))
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('picking another environment asks the worker for it', async () => {
  const { panel, sent } = await open((role) => answer(role, { rows: role === 'staging' ? [row('stg')] : [] }))
  await panel.select({ label: 'Environment' }, 'staging')
  assert.deepEqual(sent.at(-1), { name: 'errors.list', input: { role: 'staging' } })
  assert.ok(panel.find({ type: 'Link', text: 'TypeError: stg is undefined' }))
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
  assert.ok(panel.find({ type: 'Link', text: 'TypeError: late is undefined' }))
  assert.ok(panel.find({ type: 'Button', text: 'Read now' }))
})

test('the worker telling of a change redraws the environment on screen', async () => {
  let rows: ErrorRow[] = []
  const { panel } = await open((role) => answer(role, { rows }))
  assert.ok(panel.find({ type: 'EmptyState', label: 'No errors' }))
  rows = [row('fresh')]
  await panel.post('errors.changed', { role: 'sandbox', newCount: 1 })
  assert.ok(panel.find({ type: 'Link', text: 'TypeError: fresh is undefined' }))
})

test('in Spanish', async () => {
  const { panel } = await open((role) => answer(role, { rows: [row('alpha'), row('gamma', { markedAt: NOW })], intervalMinutes: 5 }), { locale: 'es-ES' })
  for (const words of ['Nuevos', 'Leer ahora']) assert.ok(panel.find({ text: words }), words)
  assert.ok(panel.find({ type: 'Collapsible', label: 'Vistos (1)' }))
  assert.ok(panel.find({ text: /cada 5 min/ }))
  await panel.press({ type: 'Link', text: 'TypeError: alpha is undefined' })
  for (const words of ['Mensaje', 'Dónde', 'Traza de pila', 'Controlador', 'Nivel']) assert.ok(panel.find({ text: words }), words)
  assert.ok(panel.find({ role: 'button', label: 'Todos los errores' }))
})

test('every scenario of the piece draws its view without an error, the detail ones their detail', async () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    const host = mockHost({ capabilities: CAPABILITIES, ...scenario, requests: { 'core.status': () => READY_STATUS, ...scenario.requests } })
    panel = await mount(panelModule, { host, persisted: { plugin: { view: 'errors', ...scenario.persisted?.plugin } } })
    assert.deepEqual(panel.errors, [], name)
    assert.deepEqual(panel.warnings, [], name)
    assert.equal(Boolean(panel.find({ text: 'Stack trace' })), name.startsWith('errorsDetail'), name)
    panel.unmount()
    panel = undefined
  }
})

test('every text the view draws fits two lines of a 300 px sidebar, in both languages', () => {
  // Notifications, status bar items and command replies are not drawn in the panel.
  const notDrawn = /^(reply|notify|notice|bar|cmd)|^statusTooltip$|^notReadyBody$/
  for (const language of ['en', 'es'] as const) {
    for (const [key, value] of Object.entries(pieceMessages[language])) {
      if (!notDrawn.test(key)) assert.ok(value.length <= NOTICE_MAX_CHARS, `${language} ${key}: ${value.length} characters`)
    }
  }
})
