// The debugger's view inside the plugin's panel, over a stubbed worker: each state it draws, and
// what its controls ask the worker.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from '../../panel/panel'
import { READY_STATUS } from '../../panel/scenarios'
import type { DebuggerState, Variable } from './protocol'
import { scenarios } from './scenarios'
import { shortNames, wordReason } from './section'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']

type Requests = NonNullable<Parameters<typeof mockHost>[0]>['requests']

async function open(requests: Requests, locale = 'en'): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost({ capabilities: CAPABILITIES, requests: { 'core.status': () => READY_STATUS, ...requests } }),
    persisted: { plugin: { view: 'debugger' } },
    locale
  })
  return panel
}

function stateOf(name: keyof typeof scenarios): DebuggerState {
  return (scenarios[name].requests?.['debugger.state'] as () => DebuggerState)()
}

function requested(target: TestPanel, name: string): unknown[] {
  return target.host.calls
    .filter((call) => call.method === 'plugin.request')
    .map((call) => call.params as { name?: string; input?: unknown })
    .filter((params) => params.name === name)
    .map((params) => params.input)
}

test('idle: the state, a start button and an empty list of breakpoints that says how to add one', async () => {
  const target = await open(scenarios.debugger.requests)
  assert.ok(target.find({ type: 'Badge', text: 'Not started' }))
  assert.ok(target.find({ type: 'Button', text: 'Start' }))
  assert.ok(target.find({ type: 'EmptyState' }))
  assert.equal(target.find({ type: 'Button', text: 'Continue' }), null, 'nothing to continue')
  await target.press({ type: 'Button', text: 'Start' })
  assert.equal(requested(target, 'debugger.start').length, 1)
})

test('attached: each breakpoint with whether the sandbox accepted it, told apart by the shortest path', async () => {
  const target = await open(scenarios.debuggerAttached.requests)
  assert.ok(target.find({ type: 'Badge', text: 'Attached' }))
  assert.ok(target.find({ type: 'Button', text: 'Stop' }))
  const text = JSON.stringify(target.tree())
  for (const row of ['app_example/…/Page.js:11', 'app_example/…/Page.js:24', 'app_example_base/…/Page.js:30', 'pageHelpers.js:7']) assert.ok(text.includes(row), row)
  assert.ok(text.includes('not set') && text.includes('Not set: the sandbox did not accept'), 'a refused line says so, in words')
  await target.press({ type: 'IconButton', label: 'Remove pageHelpers.js:7' })
  assert.deepEqual(requested(target, 'debugger.setBreakpoints').at(-1), { path: 'cartridges/app_example/cartridge/scripts/helpers/pageHelpers.js', lines: [] })
  await target.press({ type: 'Button', text: 'Remove all' })
  assert.equal(requested(target, 'debugger.clearBreakpoints').length, 1)
})

test('a breakpoint is added from a file found by name and a line', async () => {
  const target = await open(scenarios.debuggerAttached.requests)
  await target.type({ type: 'Input', label: 'Find a script' }, 'page')
  assert.deepEqual(requested(target, 'debugger.files').at(-1), { query: 'page' })
  assert.equal(target.valueOf({ type: 'Select', label: 'File' }), 'cartridges/app_example/cartridge/controllers/Page.js')
  await target.type({ type: 'Input', label: 'Line' }, '40', { submit: true })
  assert.deepEqual(requested(target, 'debugger.setBreakpoints').at(-1), { path: 'cartridges/app_example/cartridge/controllers/Page.js', lines: [11, 24, 40] })
})

test('halted: continue and the steps, the threads, the call stack, scopes read and expanded on demand, evaluate', async () => {
  const variables: Record<number, Variable[]> = { 1: [{ name: 'req', value: '[object Object]', reference: 5, expensive: false }] }
  const target = await open({
    ...scenarios.debuggerHalted.requests,
    'debugger.variables': (input: { frameId?: number; reference?: number }) =>
      typeof input.frameId === 'number' ? (scenarios.debuggerHalted.requests?.['debugger.variables'] as () => Variable[])() : (variables[input.reference ?? 0] ?? []),
    'debugger.evaluate': () => ({ result: 'GET', reference: 0 }),
    'debugger.step': () => ({ ...stateOf('debuggerHalted'), status: 'attached', frames: [] }),
    'debugger.open': () => ({ opened: true }),
    'debugger.stack': () => stateOf('debuggerHalted').frames
  })
  assert.ok(target.find({ type: 'Badge', text: 'Halted' }))
  for (const label of ['Continue', 'Step over', 'Step in', 'Step out']) assert.ok(target.find({ type: 'Button', text: label }), label)
  const text = JSON.stringify(target.tree())
  for (const part of ['Thread 7', 'Thread 9', 'show()', 'Page.js:11', 'route.js:83']) assert.ok(text.includes(part), part)
  // The top frame's scopes are read at once, without values; a scope's variables only when opened.
  assert.deepEqual(requested(target, 'debugger.variables'), [{ frameId: 70000 }])
  await target.expand({ type: 'Tree' }, 'f70000/0')
  assert.deepEqual(requested(target, 'debugger.variables').at(-1), { reference: 1 })
  assert.ok(JSON.stringify(target.tree()).includes('[object Object]'))
  // Pressing a frame picks it and opens its file.
  await target.press({ type: 'Link', text: 'next()' })
  assert.deepEqual(requested(target, 'debugger.open').at(-1), { frameId: 70001 })
  assert.deepEqual(requested(target, 'debugger.variables').at(-1), { frameId: 70001 })
  await target.type({ type: 'Input', label: 'Expression' }, 'req.httpMethod', { submit: true })
  assert.deepEqual(requested(target, 'debugger.evaluate').at(-1), { expression: 'req.httpMethod', frameId: 70001 })
  assert.ok(JSON.stringify(target.tree()).includes('GET'))
  await target.press({ type: 'Button', text: 'Step over' })
  assert.deepEqual(requested(target, 'debugger.step').at(-1), { kind: 'over' })
  assert.ok(target.find({ type: 'Badge', text: 'Attached' }), 'the answer redraws the view')
})

test('failed: the reason in words and the adapter’s own, with a retry', async () => {
  const target = await open(scenarios.debuggerFailed.requests)
  assert.ok(target.find({ type: 'Badge', text: 'Failed' }))
  const text = JSON.stringify(target.tree())
  assert.ok(text.includes('The sandbox refused the debugger.'))
  assert.ok(text.includes('Script debugger is not enabled'))
  await target.press({ type: 'Button', text: 'Start again' })
  assert.equal(requested(target, 'debugger.start').length, 1)
})

test('a sandbox that is not ready says so and the start is disabled', async () => {
  const target = await open(scenarios.debuggerSandboxNotReady.requests)
  assert.ok(target.find({ type: 'Callout', text: /Sandbox not ready/ }))
  assert.equal(target.find({ type: 'Button', text: 'Start' })?.props.disabled, true)
})

test('an ended session says when the sandbox did not confirm the disconnect, instead of saying the debugger left', async () => {
  const target = await open({ 'debugger.state': (): DebuggerState => ({ ...stateOf('debugger'), status: 'ended', reason: 'disconnect_unconfirmed' }) })
  const text = JSON.stringify(target.tree())
  assert.ok(text.includes('the sandbox did not confirm the debugger left it'))
  assert.ok(!text.includes('the debugger left the sandbox'))
  // A clean end still says it left.
  panel?.unmount()
  const clean = await open({ 'debugger.state': (): DebuggerState => ({ ...stateOf('debugger'), status: 'ended' }) })
  assert.ok(JSON.stringify(clean.tree()).includes('The session ended and the debugger left the sandbox.'))
})

test('the worker’s posts redraw the view', async () => {
  const target = await open(scenarios.debugger.requests)
  target.post('debugger.state', stateOf('debuggerHalted'))
  await target.settled()
  assert.ok(target.find({ type: 'Badge', text: 'Halted' }))
})

test('in Spanish', async () => {
  const target = await open(scenarios.debuggerHalted.requests, 'es-ES')
  for (const label of ['Continuar', 'Saltar', 'Entrar', 'Salir', 'Detener']) assert.ok(target.find({ type: 'Button', text: label }), label)
  assert.ok(target.find({ type: 'Badge', text: 'Detenido' }))
  assert.equal(wordReason('es', 'launch_failed'), 'El sandbox ha rechazado el depurador.')
  assert.equal(wordReason('es', 'credentials_missing'), 'dw.json no tiene client id y secret para ese entorno.')
})

test('short names keep a file’s own name and add only what tells two apart', () => {
  assert.deepEqual(shortNames(['a/b/c/Page.js', 'x/b/c/Page.js', 'a/b/helper.js', 'a/c/Page2.js']), {
    'a/b/c/Page.js': 'a/…/Page.js',
    'x/b/c/Page.js': 'x/…/Page.js',
    'a/b/helper.js': 'helper.js',
    'a/c/Page2.js': 'Page2.js'
  })
  assert.deepEqual(shortNames(['one/Page.js', 'two/Page.js']), { 'one/Page.js': 'one/Page.js', 'two/Page.js': 'two/Page.js' })
})
