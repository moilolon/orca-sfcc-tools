// The debugger's view inside the plugin's panel, over a stubbed worker: each state it draws, the
// list of scripts and a script's lines where a click toggles a breakpoint, *Add breakpoint here* on
// the call stack, and what its controls ask the worker.
import { messages as pieceMessages } from './i18n'
import { NOTICE_MAX_CHARS } from '../../panel/ui'
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from '../../panel/panel'
import { READY_STATUS } from '../../panel/scenarios'
import type { DebuggerState, Variable } from './protocol'
import { scenarios } from './scenarios'
import { findScripts, MAX_CHILDREN, shortNames, toggledLine, visibleLines, WINDOW_LINES, wordReason } from './section'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const PAGE = 'cartridges/app_example/cartridge/controllers/Page.js'

type Requests = NonNullable<Parameters<typeof mockHost>[0]>['requests']

async function open(requests: Requests, locale = 'en', plugin: Record<string, unknown> = {}): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost({ capabilities: CAPABILITIES, requests: { 'core.status': () => READY_STATUS, ...requests } }),
    persisted: { plugin: { view: 'debugger', ...plugin } },
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

/** A worker that keeps the breakpoints it is sent, over the attached state. */
function breakpointWorker() {
  let state = stateOf('debuggerAttached')
  return {
    'debugger.state': () => state,
    'debugger.breakpoint': (input: { path: string; line: number; on: boolean }): DebuggerState => {
      state = {
        ...state,
        breakpoints: state.breakpoints.map((file) =>
          file.path === input.path ? { ...file, lines: input.on ? [...file.lines, { line: input.line, verified: null }] : file.lines.filter((each) => each.line !== input.line) } : file
        )
      }
      return state
    }
  }
}

test('idle: the state, a start button, an empty list of breakpoints that says how to add one, and the scripts', async () => {
  const target = await open(scenarios.debugger.requests)
  assert.deepEqual(target.errors, [])
  assert.ok(target.find({ type: 'Text', text: 'Not started' }))
  assert.ok(target.find({ type: 'Button', text: 'Start' }))
  assert.equal(target.find({ type: 'EmptyState' })?.props.description, 'Open a script below and click a line.')
  assert.equal(target.find({ type: 'Button', text: 'Continue' }), null, 'nothing to continue')
  // The scripts, by cartridge, folded.
  assert.match(target.summary().join('\n'), /Tree "Scripts": 2 top-level item/)
  await target.press({ type: 'Button', text: 'Start' })
  assert.equal(requested(target, 'debugger.start').length, 1)
})

test('attached: each breakpoint with whether the sandbox accepted it, told apart by the shortest path', async () => {
  const target = await open(scenarios.debuggerAttached.requests)
  assert.ok(target.find({ type: 'Text', text: 'Attached' }))
  assert.ok(target.find({ type: 'Text', text: 'waiting for a request' }))
  assert.ok(target.find({ type: 'Button', text: 'Stop' }))
  for (const row of ['app_example/…/Page.js:11', 'app_example/…/Page.js:24', 'app_example_base/…/Page.js:30', 'pageHelpers.js:7']) assert.ok(target.find({ type: 'Link', text: row }), row)
  assert.ok(target.find({ text: 'not set' }), 'a refused line says so, in words')
  await target.press({ type: 'IconButton', label: 'Remove pageHelpers.js:7' })
  assert.deepEqual(requested(target, 'debugger.setBreakpoints').at(-1), { path: 'cartridges/app_example/cartridge/scripts/helpers/pageHelpers.js', lines: [] })
  await target.press({ type: 'Button', text: 'Remove all' })
  assert.equal(requested(target, 'debugger.clearBreakpoints').length, 1)
})

test('the scripts: a tree by cartridge and folder, or the matches of a search; a file opens its lines', async () => {
  const target = await open(scenarios.debuggerAttached.requests)
  assert.deepEqual(requested(target, 'debugger.scripts'), [{}])
  await target.expand({ type: 'Tree' }, 'c:cartridges/app_example')
  await target.expand({ type: 'Tree' }, 'd:cartridges/app_example/cartridge')
  await target.expand({ type: 'Tree' }, 'd:cartridges/app_example/cartridge/controllers')
  assert.deepEqual(target.persisted.plugin.debuggerScriptsOpen, ['c:cartridges/app_example', 'd:cartridges/app_example/cartridge', 'd:cartridges/app_example/cartridge/controllers'])
  // A file with breakpoints says how many.
  assert.ok(JSON.stringify(target.tree()).includes('2 breakpoint(s)'))
  // A search lists the matches flat, by name.
  await target.type({ type: 'Input', label: 'Find a script' }, 'page')
  assert.match(target.summary().join('\n'), /Tree "Scripts": 3 top-level item/)
  await target.selectItem({ type: 'Tree' }, `f:${PAGE}`)
  assert.deepEqual(requested(target, 'debugger.source').at(-1), { path: PAGE })
  assert.equal(target.persisted.plugin.debuggerScript, PAGE)
  assert.match(target.summary().join('\n'), /Table "Lines of Page\.js": 30 row/)
  // Back to the list.
  await target.press({ role: 'button', label: 'All scripts' })
  assert.equal(target.persisted.plugin.debuggerScript, null)
  assert.equal(target.find({ type: 'Table' }), null)
})

test('a script’s lines: its breakpoints marked and selected; a click on a line sets or removes one there', async () => {
  const target = await open({ ...scenarios.debuggerSource.requests, ...breakpointWorker() }, 'en', { debuggerScript: PAGE })
  assert.deepEqual(target.errors, [])
  const table = { type: 'Table' } as const
  assert.equal(target.rowsOf(table).length, 30)
  assert.deepEqual(target.valueOf(table), ['11', '24'])
  const cells = target.find(table)?.props.rows as { key: string; cells: { mark: boolean; line: number; code: string } }[]
  assert.equal(cells[10].cells.mark, true)
  assert.equal(cells[9].cells.mark, false)
  // Indentation is kept: a cell folds spaces, so they are drawn as no-break spaces.
  assert.equal(cells[10].cells.code, '    var page = pageHelpers.find(req.querystring.cid);')
  // A plain click selects only that row: a line without a breakpoint gets one.
  await target.selectRows(table, ['13'])
  assert.deepEqual(requested(target, 'debugger.breakpoint').at(-1), { path: PAGE, line: 13, on: true })
  assert.deepEqual(target.valueOf(table), ['11', '24', '13'])
  // A click on a marked line removes it.
  await target.selectRows(table, ['11'])
  assert.deepEqual(requested(target, 'debugger.breakpoint').at(-1), { path: PAGE, line: 11, on: false })
  assert.deepEqual(target.valueOf(table), ['24', '13'])
})

test('a script’s lines can be filtered by words or opened at a line', async () => {
  const target = await open(scenarios.debuggerSource.requests, 'en', { debuggerScript: PAGE })
  // A short script fits one window: every line, and no page to move to.
  assert.ok(target.find({ text: 'Lines 1 to 30 of 30' }))
  assert.equal(target.find({ role: 'button', label: 'Next lines' })?.disabled, true)
  await target.type({ type: 'Input', label: 'Find text or line' }, 'pageHelpers')
  assert.deepEqual(target.rowsOf({ type: 'Table' }), ['5', '11', '19', '25'])
  assert.ok(target.find({ text: '4 matching lines' }))
  // A line number shows the window that holds it: here, the whole script.
  await target.type({ type: 'Input', label: 'Find text or line' }, '24', { replace: true })
  assert.ok(target.rowsOf({ type: 'Table' }).includes('24'))
  // A breakpoint row opens its script at its line.
  await target.press({ role: 'button', label: 'All scripts' })
  await target.press({ type: 'Link', text: 'app_example/…/Page.js:24' })
  assert.equal(target.valueOf({ type: 'Input', label: 'Find text or line' }), '24')
  assert.ok(target.rowsOf({ type: 'Table' }).includes('24'))
})

test('a long script: a window of lines moved by page, by a line number, or by a search, never growing', async () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`)
  const target = await open({ ...scenarios.debuggerSource.requests, 'debugger.source': () => ({ path: PAGE, truncated: false, lines }) }, 'en', { debuggerScript: PAGE })
  const table = { type: 'Table' } as const
  const rows = () => target.rowsOf(table)
  assert.equal(rows().length, WINDOW_LINES)
  assert.ok(target.find({ text: `Lines 1 to ${WINDOW_LINES} of 1000` }))
  assert.equal(target.find({ role: 'button', label: 'Previous lines' })?.disabled, true)
  await target.press({ role: 'button', label: 'Next lines' })
  assert.deepEqual([rows()[0], rows().at(-1)], [String(WINDOW_LINES + 1), String(2 * WINDOW_LINES)])
  await target.press({ role: 'button', label: 'Previous lines' })
  assert.equal(rows()[0], '1')
  // A line number opens the window a few lines before it; paging from there lets the number go.
  await target.type({ type: 'Input', label: 'Find text or line' }, '700')
  assert.equal(rows()[0], '695')
  await target.press({ role: 'button', label: 'Next lines' })
  // The next page would pass the end: the last window ends at the last line.
  assert.equal(rows()[0], String(1000 - WINDOW_LINES + 1))
  assert.equal(target.valueOf({ type: 'Input', label: 'Find text or line' }), '')
  // The last window ends at the last line.
  assert.equal(rows().at(-1), '1000')
  assert.equal(target.find({ role: 'button', label: 'Next lines' })?.disabled, true)
  // A search draws at most a window of matches, and says how many there are.
  await target.type({ type: 'Input', label: 'Find text or line' }, 'line')
  assert.equal(rows().length, WINDOW_LINES)
  assert.ok(target.find({ text: `First ${WINDOW_LINES} of 1000 matching lines` }))
})

test('opening a scope with thousands of variables draws the first ones and says how many more', async () => {
  const many: Variable[] = Array.from({ length: MAX_CHILDREN + 300 }, (_, i) => ({ name: `[${i}]`, value: `value ${i}`, reference: 0, expensive: false }))
  const target = await open({
    ...scenarios.debuggerHalted.requests,
    'debugger.variables': (input: { frameId?: number; reference?: number }) =>
      typeof input.frameId === 'number' ? (scenarios.debuggerHalted.requests?.['debugger.variables'] as () => Variable[])() : many
  })
  await target.expand({ type: 'Tree', label: 'Variables' }, 'f70000/0')
  const tree = JSON.stringify(target.tree())
  assert.ok(tree.includes(`[${MAX_CHILDREN - 1}]`))
  assert.ok(!tree.includes(`"[${MAX_CHILDREN}]"`))
  assert.ok(tree.includes('300 more not shown'))
})

test('the open script and folders are let go when another workspace is debugged', async () => {
  let state = { ...stateOf('debuggerAttached'), workspaceId: 'w-one' }
  const target = await open({ ...scenarios.debuggerSource.requests, 'debugger.state': () => state }, 'en', { debuggerScript: PAGE, debuggerScriptsOpen: ['c:cartridges/app_example'] })
  assert.ok(target.find({ type: 'Table' }))
  assert.equal(target.persisted.plugin.debuggerWorkspace, 'w-one')
  // The same workspace again changes nothing.
  target.post('debugger.state', { ...state, status: 'halted' })
  await target.settled()
  assert.equal(target.persisted.plugin.debuggerScript, PAGE)
  // Another one: its own list, nothing of the last one open.
  state = { ...state, workspaceId: 'w-two' }
  target.post('debugger.state', state)
  await target.settled()
  assert.equal(target.persisted.plugin.debuggerScript, null)
  assert.deepEqual(target.persisted.plugin.debuggerScriptsOpen, [])
  assert.equal(target.persisted.plugin.debuggerWorkspace, 'w-two')
  assert.equal(target.find({ type: 'Table' }), null)
  assert.equal(requested(target, 'debugger.scripts').length, 2)
})

test('the notes of the list of scripts follow Orca’s language', async () => {
  const folders = ['c:cartridges/app_example', 'd:cartridges/app_example/cartridge', 'd:cartridges/app_example/cartridge/controllers']
  let target = await open(scenarios.debuggerScripts.requests, 'en', { debuggerScriptsOpen: folders })
  assert.ok(JSON.stringify(target.tree()).includes('2 breakpoint(s)'))
  panel?.unmount()
  target = await open(scenarios.debuggerScripts.requests, 'es-ES', { debuggerScriptsOpen: folders })
  const tree = JSON.stringify(target.tree())
  assert.ok(tree.includes('2 punto(s)'))
  assert.ok(!tree.includes('2 breakpoint(s)'))
})

test('which line a click on the table changed', () => {
  assert.equal(toggledLine([], ['5']), '5')
  assert.equal(toggledLine(['3', '7'], ['7']), '7', 'a plain click on a marked line')
  assert.equal(toggledLine(['3'], ['3', '9']), '9', 'a click with Ctrl adds one')
  assert.equal(toggledLine(['3', '7', '9'], ['3', '9']), '7', 'a click with Ctrl drops one')
  assert.equal(toggledLine(['3'], []), null)
  assert.equal(toggledLine(['3'], ['4', '5', '6']), null, 'a range changes nothing')
})

test('which lines are drawn: a window from a line, around a line number, or those holding every word', () => {
  const lines = Array.from({ length: 50 }, (_, i) => (i === 31 ? 'var Total = 1' : `line ${i + 1}`))
  assert.deepEqual(visibleLines(lines, '', 1, 10), { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], matches: null })
  assert.deepEqual(visibleLines(lines, '', 46, 10).numbers, [41, 42, 43, 44, 45, 46, 47, 48, 49, 50], 'the last window ends at the last line')
  assert.deepEqual(visibleLines(lines, '40', 1, 5).numbers, [35, 36, 37, 38, 39])
  assert.deepEqual(visibleLines(lines, '999', 1, 10).numbers.at(-1), 50)
  assert.deepEqual(visibleLines(lines, 'VAR total', 1, 10), { numbers: [32], matches: 1 })
  assert.deepEqual(visibleLines(lines, 'line', 1, 10), { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], matches: 49 })
  assert.deepEqual(visibleLines(['only'], '', 1).numbers, [1])
})

test('a search for scripts puts the file’s own name first, then the shorter path', () => {
  const files = ['a/scripts/pageHelpers.js', 'b/controllers/Page.js', 'a/controllers/Cart.js', 'page/other.js']
  assert.deepEqual(findScripts(files, 'page'), { files: ['b/controllers/Page.js', 'a/scripts/pageHelpers.js', 'page/other.js'], more: false })
  assert.deepEqual(findScripts(files, '   '), { files: [], more: false })
})

test('halted: continue and the steps, the threads, the call stack with Add breakpoint here, scopes on demand, evaluate', async () => {
  const variables: Record<number, Variable[]> = { 1: [{ name: 'req', value: '[object Object]', reference: 5, expensive: false }] }
  const target = await open({
    ...scenarios.debuggerHalted.requests,
    'debugger.variables': (input: { frameId?: number; reference?: number }) =>
      typeof input.frameId === 'number' ? (scenarios.debuggerHalted.requests?.['debugger.variables'] as () => Variable[])() : (variables[input.reference ?? 0] ?? []),
    'debugger.evaluate': () => ({ result: 'GET', reference: 0 }),
    'debugger.step': () => ({ ...stateOf('debuggerHalted'), status: 'attached', frames: [] }),
    'debugger.open': () => ({ opened: true }),
    'debugger.stack': () => stateOf('debuggerHalted').frames,
    'debugger.breakpoint': () => stateOf('debuggerHalted')
  })
  assert.ok(target.find({ type: 'Text', text: 'Halted' }))
  assert.ok(target.find({ type: 'Button', text: 'Continue' }))
  for (const label of ['Step over', 'Step in', 'Step out']) assert.ok(target.find({ role: 'button', label }), label)
  for (const part of ['Thread 7', 'Thread 9', 'show()']) assert.ok(target.find({ text: part }), part)
  // Each frame: its function, then its file and line as code.
  assert.ok(target.find({ type: 'Code', text: 'Page.js:11' }))
  assert.ok(target.find({ type: 'Code', text: 'route.js:83' }))
  // The top frame's line holds a breakpoint already; the next one gets one from its button.
  const flags = target.findAll({ type: 'IconButton' }).filter((item) => /breakpoint here/i.test(String(item.props.label)))
  assert.deepEqual(
    flags.map((item) => [item.props.label, item.disabled]),
    [
      ['Breakpoint here', true],
      ['Add breakpoint here', false],
      ['Add breakpoint here', false]
    ]
  )
  await target.press(flags[1])
  assert.deepEqual(requested(target, 'debugger.breakpoint').at(-1), { path: 'cartridges/modules/server/route.js', line: 83, on: true })
  // The top frame's scopes are read at once, without values; a scope's variables only when opened.
  assert.deepEqual(requested(target, 'debugger.variables'), [{ frameId: 70000 }])
  await target.expand({ type: 'Tree', label: 'Variables' }, 'f70000/0')
  assert.deepEqual(requested(target, 'debugger.variables').at(-1), { reference: 1 })
  assert.ok(JSON.stringify(target.tree()).includes('[object Object]'))
  // Pressing a frame picks it and opens its file.
  await target.press({ type: 'Link', text: 'next()' })
  assert.deepEqual(requested(target, 'debugger.open').at(-1), { frameId: 70001 })
  assert.deepEqual(requested(target, 'debugger.variables').at(-1), { frameId: 70001 })
  await target.type({ type: 'Input', label: 'Expression' }, 'req.httpMethod', { submit: true })
  assert.deepEqual(requested(target, 'debugger.evaluate').at(-1), { expression: 'req.httpMethod', frameId: 70001 })
  assert.ok(target.find({ text: 'GET' }))
  await target.press({ role: 'button', label: 'Step over' })
  assert.deepEqual(requested(target, 'debugger.step').at(-1), { kind: 'over' })
  assert.ok(target.find({ type: 'Text', text: 'Attached' }), 'the answer redraws the view')
})

test('failed: the reason in a compact notice with Retry; the adapter’s own words folded under Details', async () => {
  const target = await open(scenarios.debuggerFailed.requests)
  assert.ok(target.find({ type: 'Text', text: 'Failed' }))
  assert.match(target.summary().join('\n'), /Session failed/)
  assert.ok(target.find({ text: 'The sandbox refused the debugger.' }))
  assert.ok(target.find({ type: 'Collapsible', label: 'Details' }))
  assert.ok(JSON.stringify(target.tree()).includes('Script debugger is not enabled'))
  await target.press({ type: 'Button', text: 'Retry' })
  assert.equal(requested(target, 'debugger.start').length, 1)
})

test('a sandbox that is not ready says so in one line that leads to the setup, and the start is disabled', async () => {
  const target = await open(scenarios.debuggerSandboxNotReady.requests)
  assert.ok(target.find({ text: 'Sandbox not set up' }))
  assert.equal(target.find({ type: 'Callout' }), null, 'the status line says it already: no callout')
  assert.equal(target.find({ type: 'Button', text: 'Start' })?.props.disabled, true)
  await target.press({ type: 'Button', text: 'Open setup' })
  assert.equal(target.persisted.plugin.view, 'setup')
})

test('an ended session says when the sandbox did not confirm the disconnect', async () => {
  const target = await open({ ...scenarios.debugger.requests, 'debugger.state': (): DebuggerState => ({ ...stateOf('debugger'), status: 'ended', reason: 'disconnect_unconfirmed' }) })
  assert.ok(target.find({ text: 'Leaving was not confirmed: the next start cleans up.' }))
  // A clean end says only that it ended.
  panel?.unmount()
  const clean = await open({ ...scenarios.debugger.requests, 'debugger.state': (): DebuggerState => ({ ...stateOf('debugger'), status: 'ended' }) })
  assert.ok(clean.find({ type: 'Text', text: 'Ended' }))
  assert.equal(clean.find({ text: /not confirmed/ }), null)
})

test('the worker’s posts redraw the view', async () => {
  const target = await open(scenarios.debugger.requests)
  target.post('debugger.state', stateOf('debuggerHalted'))
  await target.settled()
  assert.ok(target.find({ type: 'Text', text: 'Halted' }))
})

test('in Spanish', async () => {
  const target = await open(scenarios.debuggerHalted.requests, 'es-ES')
  assert.ok(target.find({ type: 'Button', text: 'Continuar' }))
  assert.ok(target.find({ type: 'Button', text: 'Detener' }))
  for (const label of ['Saltar', 'Entrar', 'Salir', 'Poner un punto aquí']) assert.ok(target.find({ role: 'button', label }), label)
  assert.ok(target.find({ type: 'Text', text: 'Detenido' }))
  assert.equal(wordReason('es', 'launch_failed'), 'El sandbox ha rechazado el depurador.')
  assert.equal(wordReason('es', 'credentials_missing'), 'dw.json no tiene client id y secret para ese entorno.')
  panel?.unmount()
  const source = await open(scenarios.debuggerSource.requests, 'es-ES', { debuggerScript: PAGE })
  assert.ok(source.find({ text: 'Pulsa una línea para poner o quitar un punto.' }))
  assert.match(source.summary().join('\n'), /Líneas de Page\.js/)
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

test('every scenario of the piece draws its view without an error', async () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    panel = await mount(panelModule, {
      host: mockHost({ capabilities: CAPABILITIES, ...scenario, requests: { 'core.status': () => READY_STATUS, ...scenario.requests } }),
      persisted: { plugin: { view: 'debugger', ...scenario.persisted?.plugin } }
    })
    assert.deepEqual(panel.errors, [], name)
    assert.deepEqual(panel.warnings, [], name)
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
