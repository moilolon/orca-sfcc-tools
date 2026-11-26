// The debugger piece's check scenarios: each state of its view worth a look, drawn by
// `orca plugin check` and captured with `orca plugin shot . --scenario <name>`. src/panel/checks.ts
// merges them; every name starts with `debugger`. The worker is stubbed: no b2c runs. Every name
// and value below is invented.
import type { PieceScenarios } from '../../panel/scenarios'
import type { DebuggerFiles, DebuggerState, Variable } from './protocol'

const PAGE = 'cartridges/app_example/cartridge/controllers/Page.js'
const HELPERS = 'cartridges/app_example/cartridge/scripts/helpers/pageHelpers.js'
const BASE_PAGE = 'cartridges/app_example_base/cartridge/controllers/Page.js'

const IDLE: DebuggerState = {
  status: 'idle',
  reason: null,
  message: null,
  sandbox: 'ready',
  workspace: 'ok',
  breakpoints: [],
  threads: [],
  threadId: null,
  frames: []
}

const ATTACHED: DebuggerState = {
  ...IDLE,
  status: 'attached',
  breakpoints: [
    { path: PAGE, lines: [{ line: 11, verified: true }, { line: 24, verified: true }] },
    { path: BASE_PAGE, lines: [{ line: 30, verified: false }] },
    { path: HELPERS, lines: [{ line: 7, verified: true }] }
  ]
}

const HALTED: DebuggerState = {
  ...ATTACHED,
  status: 'halted',
  threads: [
    { id: 7, name: 'Thread 7', halted: true },
    { id: 9, name: 'Thread 9', halted: false }
  ],
  threadId: 7,
  frames: [
    { id: 70000, name: 'show()', file: 'Page.js', line: 11, path: PAGE },
    { id: 70001, name: 'next()', file: 'route.js', line: 83, path: 'cartridges/modules/server/route.js' },
    { id: 70002, name: '-anonymous-()', file: 'route.js', line: 91, path: 'cartridges/modules/server/route.js' }
  ]
}

const SCOPES: Variable[] = [
  { name: 'Local', value: '', reference: 1, expensive: false },
  { name: 'Closure', value: '', reference: 2, expensive: false },
  { name: 'Global', value: '', reference: 3, expensive: true }
]

const FILES: DebuggerFiles = { files: [PAGE, BASE_PAGE], truncated: false }

export const scenarios: PieceScenarios = {
  /** No session yet and no breakpoint: the view offers to start and to add one. */
  debugger: { requests: { 'debugger.state': () => IDLE, 'debugger.files': () => FILES } },
  /** Attached, waiting for a request, with breakpoints the sandbox accepted and one it did not. */
  debuggerAttached: { requests: { 'debugger.state': () => ATTACHED, 'debugger.files': () => FILES } },
  /** A request halted at a breakpoint: continue and step, threads, call stack, scopes, evaluate. */
  debuggerHalted: {
    requests: { 'debugger.state': () => HALTED, 'debugger.variables': () => SCOPES, 'debugger.files': () => FILES }
  },
  /** The sandbox refused the debugger: the adapter's own words and a retry. */
  debuggerFailed: {
    requests: {
      'debugger.state': (): DebuggerState => ({
        ...IDLE,
        status: 'failed',
        reason: 'launch_failed',
        message: 'Failed to connect: Script debugger is not enabled on this instance. Enable it in Business Manager > Administration > Development Configuration.',
        breakpoints: ATTACHED.breakpoints.map((file) => ({ ...file, lines: file.lines.map((each) => ({ ...each, verified: null })) }))
      }),
      'debugger.files': () => FILES
    }
  },
  /** The sandbox role is not ready in dw.json: nothing can start. */
  debuggerSandboxNotReady: { requests: { 'debugger.state': (): DebuggerState => ({ ...IDLE, sandbox: 'incomplete' }), 'debugger.files': () => FILES } }
}
