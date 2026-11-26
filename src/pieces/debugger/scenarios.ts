// The debugger piece's check scenarios: each state of its view worth a look, drawn by
// `orca plugin check` and captured with `orca plugin shot . --scenario <name>`. src/panel/checks.ts
// merges them; every name starts with `debugger`. The worker is stubbed: no b2c runs. Every name
// and value below is invented.
import type { PieceScenarios } from '../../panel/scenarios'
import type { DebuggerFiles, DebuggerScripts, DebuggerSource, DebuggerState, Variable } from './protocol'

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

/** Two cartridges and their scripts. */
const SCRIPTS: DebuggerScripts = {
  cartridges: [
    {
      name: 'app_example',
      path: 'cartridges/app_example',
      files: [PAGE, 'cartridges/app_example/cartridge/controllers/Cart.js', HELPERS, 'cartridges/app_example/cartridge/scripts/helpers/cartHelpers.js']
    },
    { name: 'app_example_base', path: 'cartridges/app_example_base', files: [BASE_PAGE, 'cartridges/app_example_base/cartridge/scripts/middleware/cache.js'] }
  ],
  truncated: false
}

/** An invented controller, as the worker would answer its lines. */
const PAGE_SOURCE: DebuggerSource = {
  path: PAGE,
  truncated: false,
  lines: [
    "'use strict';",
    '',
    "var server = require('server');",
    "var cache = require('*/cartridge/scripts/middleware/cache');",
    "var pageHelpers = require('*/cartridge/scripts/helpers/pageHelpers');",
    '',
    '/**',
    ' * Shows a content page.',
    ' */',
    "server.get('Show', cache.applyDefaultCache, function (req, res, next) {",
    '    var page = pageHelpers.find(req.querystring.cid);',
    '    if (!page) {',
    "        res.setStatusCode(404);",
    "        res.render('error/notFound');",
    '        return next();',
    '    }',
    '    res.render(page.template, {',
    '        page: page,',
    '        breadcrumbs: pageHelpers.breadcrumbs(page)',
    '    });',
    '    next();',
    '});',
    '',
    "server.get('Include', function (req, res, next) {",
    '    var page = pageHelpers.find(req.querystring.cid);',
    "    res.render('content/include', { page: page });",
    '    next();',
    '});',
    '',
    'module.exports = server.exports();'
  ]
}

/** The requests every scenario of the view answers: the list of scripts and a script's lines. */
const BROWSE = { 'debugger.files': () => FILES, 'debugger.scripts': () => SCRIPTS, 'debugger.source': () => PAGE_SOURCE }

export const scenarios: PieceScenarios = {
  /** No session yet and no breakpoint: the view offers to start and to add one. */
  debugger: { requests: { 'debugger.state': () => IDLE, ...BROWSE } },
  /** Attached, waiting for a request, with breakpoints the sandbox accepted and one it did not. */
  debuggerAttached: { requests: { 'debugger.state': () => ATTACHED, ...BROWSE } },
  /** A script open from the list: its lines, with the two breakpoints of the file marked; a click on a line toggles one. */
  debuggerSource: { persisted: { plugin: { debuggerScript: PAGE } }, requests: { 'debugger.state': () => ATTACHED, ...BROWSE } },
  /** The list of scripts with a cartridge and two of its folders open: files with breakpoints say how many. */
  debuggerScripts: {
    persisted: { plugin: { debuggerScriptsOpen: ['c:cartridges/app_example', 'd:cartridges/app_example/cartridge', 'd:cartridges/app_example/cartridge/controllers'] } },
    requests: { 'debugger.state': () => ATTACHED, ...BROWSE }
  },
  /** A request halted at a breakpoint: continue and step, threads, call stack, scopes, evaluate. */
  debuggerHalted: {
    requests: { 'debugger.state': () => HALTED, 'debugger.variables': () => SCOPES, ...BROWSE }
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
      ...BROWSE
    }
  },
  /** The sandbox role is not ready in dw.json: nothing can start. */
  debuggerSandboxNotReady: { requests: { 'debugger.state': (): DebuggerState => ({ ...IDLE, sandbox: 'incomplete' }), ...BROWSE } }
}
