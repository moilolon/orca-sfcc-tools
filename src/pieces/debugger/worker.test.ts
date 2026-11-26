// The debugger's worker half over a mock host and the scripted fake adapter: the requests, the
// commands, coalesced posts, the sandbox-only rule, the store of breakpoints, and the disconnect
// when the worker goes away. No b2c runs.
import { EventEmitter } from 'node:events'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { B2c } from '../../core/b2c'
import { translator } from '../../core/i18n'
import type { RoleState } from '../../core/instances'
import { createOpenFile, type OpenFileChild } from '../../core/open-file'
import type { Disposable, PieceContext, Workspace, Workspaces } from '../../core/piece'
import { createStore } from '../../core/store'
import { plainSettings } from '../../core/test-support'
import { FAKE_HOST, FAKE_ROOT, FakeAdapter } from './fake-adapter'
import type { ReadDir } from './files'
import type { SourceFileSystem } from './source'
import type { DebuggerState } from './protocol'
import { createActivate, deactivate } from '../../worker/worker'
import { activateDebugger } from './worker'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const COMMANDS = ['debugger.start', 'debugger.stop', 'debugger.continue', 'debugger.stepOver', 'debugger.stepIn', 'debugger.stepOut']
const PAGE = 'cartridges/app_example/cartridge/controllers/Page.js'
const LOCAL: Workspace = { id: 'w1', name: 'shop', path: FAKE_ROOT, branch: 'main', kind: 'worktree', hostId: 'local' }

async function until(check: () => boolean, what: string, limitMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > limitMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const readDir: ReadDir = async (path) => {
  const rel = path.replace(/\\/g, '/').slice(FAKE_ROOT.length)
  const tree: Record<string, string[]> = {
    '': ['cartridges/'],
    '/cartridges': ['app_example/'],
    '/cartridges/app_example': ['.project', 'cartridge/'],
    '/cartridges/app_example/cartridge': ['controllers/'],
    '/cartridges/app_example/cartridge/controllers': ['Page.js', 'Home.js']
  }
  return (tree[rel] ?? []).map((name) => ({ name: name.replace(/\/$/, ''), isDirectory: () => name.endsWith('/'), isFile: () => !name.endsWith('/') }))
}

/** The Orca beside the running one, as src/core/open-file.ts finds it on this invented machine. */
const ORCA_EXEC = '/opt/orca/orca'
const ORCA_CLI = '/opt/orca/resources/bin/orca'

/**
 * `orca file open` over a fake process: `runs` exits 0, `fails` exits 1, `missing` has no Orca
 * command line at all. Every call is recorded; nothing is started.
 */
function fakeOrca(behaviour: 'runs' | 'fails' | 'missing') {
  const calls: { file: string; args: readonly string[] }[] = []
  const openFile = createOpenFile({
    platform: 'linux',
    execPath: ORCA_EXEC,
    env: { PATH: '/nowhere' },
    homedir: '/home/someone',
    isFile: async (path) => (path === ORCA_CLI ? behaviour !== 'missing' : path.startsWith(`${FAKE_ROOT}/`)),
    realPath: async (path) => path,
    spawn: (file, args) => {
      calls.push({ file, args })
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true })
      queueMicrotask(() => child.emit('exit', behaviour === 'runs' ? 0 : 1))
      return child as unknown as OpenFileChild
    }
  })
  return { openFile, calls }
}

/**
 * The debugger's worker half over a mock host. `throughCore` starts it as the plugin's worker does
 * (src/worker/worker.ts, with this piece alone), so deactivation is core's own.
 */
/**
 * Files on disk for the source view, by path: `Page.js` holds a line with the invented host, and
 * `Home.js` is a link that leads out of the workspace.
 */
const SOURCE_FILES: Record<string, string> = {
  [`${FAKE_ROOT}/${PAGE}`]: `'use strict';\r\nvar url = 'https://${FAKE_HOST}/';\n\tmodule.exports = url;\n`,
  '/elsewhere/Home.js': 'outside'
}
const sourceFs: SourceFileSystem = {
  realpath: async (path) => {
    const slashed = path.replace(/\\/g, '/')
    if (slashed.endsWith('/controllers/Home.js')) return '/elsewhere/Home.js'
    if (slashed === FAKE_ROOT || slashed in SOURCE_FILES) return slashed
    throw new Error('ENOENT')
  },
  read: async (path, limit) => {
    const bytes = new TextEncoder().encode(SOURCE_FILES[path] ?? '')
    return { bytes: bytes.subarray(0, limit), more: bytes.length > limit }
  }
}

async function mount({ sandbox = 'ready' as RoleState, workspace = LOCAL as Workspace | null, storage = {} as Record<string, boolean>, throughCore = false, orca = 'runs' as 'runs' | 'fails' | 'missing' } = {}) {
  const opening = fakeOrca(orca)
  const adapter = new FakeAdapter({
    frames: [{ id: 70000, name: 'show()', source: { name: 'Page.js', path: `${FAKE_ROOT}/${PAGE}` }, line: 11 }],
    threads: [{ id: 7, name: 'Thread 7' }],
    scopes: [{ name: 'Local', variablesReference: 1 }],
    variables: { 1: [{ name: 'host', value: `https://${FAKE_HOST}/`, variablesReference: 0 }] }
  })
  const logs: string[] = []
  let disposable: Disposable | undefined
  const workspaces: Workspaces = {
    list: async () => (workspace ? [workspace] : []),
    focused: async () => workspace,
    uploading: async () => null,
    upload: async () => null,
    setUploading: async () => {},
    configRoot: async () => workspace?.path ?? null
  }
  const b2c = {
    ...adapter.b2c,
    instances: async () => ({ config: 'ok', instances: { sandbox, development: 'absent', staging: 'absent', production: 'absent' } }),
    isHost: async () => false
  } as unknown as B2c
  const options = { coalesceMs: 20, platform: 'linux', readDir, sourceFs, openFile: opening.openFile, timeouts: { requestMs: 500, launchMs: 500, disconnectMs: 300, exitMs: 50 } }
  const module = throughCore
    ? {
        default: createActivate({
          pieces: [{ id: 'debugger', activate: (ctx) => activateDebugger({ ...ctx, b2c, workspaces, log: (line) => logs.push(line) }, options) }],
          platform: 'linux',
          env: { PATH: '/nowhere' },
          homedir: '/home/someone',
          isFile: async () => false,
          isDirectory: async () => true
        }),
        deactivate
      }
    : {
        default: (orca: PieceContext['orca']) => {
          disposable = activateDebugger(
            { orca, b2c, settings: plainSettings(), store: createStore(orca.storage, 'debugger'), workspaces, t: translator(() => 'en'), log: (line) => logs.push(line) },
            options
          )
        },
        deactivate: () => disposable?.dispose()
      }
  const worker = await mountWorker(module, { host: mockHost({ capabilities: CAPABILITIES, storage, results: { 'editor.open': { opened: true } } }), commands: COMMANDS })
  const states = () => worker.posts.filter((post) => post.event === 'debugger.state').map((post) => post.payload as DebuggerState)
  return { worker, adapter, logs, states, opened: opening.calls }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return String((error as { code?: unknown }).code)
  }
}

test('sandbox only: a sandbox that is not ready shows as such, and nothing starts', async () => {
  const { worker, adapter } = await mount({ sandbox: 'incomplete' })
  const state = await worker.request('debugger.state', {})
  assert.deepEqual([state.status, state.sandbox, state.workspace], ['idle', 'incomplete', 'ok'])
  assert.equal(await codeOf(worker.request('debugger.start', {})), 'sandbox_not_ready')
  assert.equal(await worker.command('debugger.start'), 'The sandbox is not ready in dw.json: the debugger did not start.')
  assert.equal(adapter.processes.length, 0)
})

test('no workspace, or one on another machine: shown as such, and nothing starts', async () => {
  const none = await mount({ workspace: null })
  assert.equal((await none.worker.request('debugger.state', {})).workspace, 'none')
  assert.equal(await codeOf(none.worker.request('debugger.start', {})), 'no_workspace')
  const remote = await mount({ workspace: { ...LOCAL, hostId: 'ssh:box' } })
  assert.equal((await remote.worker.request('debugger.state', {})).workspace, 'remote')
  assert.equal(await codeOf(remote.worker.request('debugger.files', { query: 'page' })), 'no_workspace')
  assert.equal(remote.adapter.processes.length + none.adapter.processes.length, 0)
})

test('breakpoints are kept per workspace with relative paths; a bad one is refused by code', async () => {
  const { worker } = await mount()
  const state = await worker.request('debugger.setBreakpoints', { path: PAGE, lines: [24, 11] })
  assert.deepEqual(state.breakpoints, [
    {
      path: PAGE,
      lines: [
        { line: 11, verified: null },
        { line: 24, verified: null }
      ]
    }
  ])
  assert.deepEqual(worker.host.data().storage['debugger.breakpoints'], { w1: { [PAGE]: [11, 24] } })
  assert.equal(await codeOf(worker.request('debugger.setBreakpoints', { path: `${FAKE_ROOT}/x.js`, lines: [1] })), 'invalid_path')
  assert.deepEqual((await worker.request('debugger.clearBreakpoints', {})).breakpoints, [])
  // Files to pick from: the cartridges' scripts, by name.
  assert.deepEqual(await worker.request('debugger.files', { query: 'page' }), { files: [PAGE], truncated: false })
})

test('one breakpoint is set or removed at a time, the file’s other lines kept; a bad line or path is refused', async () => {
  const { worker } = await mount()
  await worker.request('debugger.setBreakpoints', { path: PAGE, lines: [11] })
  let state = await worker.request('debugger.breakpoint', { path: PAGE, line: 24, on: true })
  assert.deepEqual(state.breakpoints[0].lines.map((each) => each.line), [11, 24])
  state = await worker.request('debugger.breakpoint', { path: PAGE, line: 11, on: false })
  assert.deepEqual(state.breakpoints[0].lines.map((each) => each.line), [24])
  // Setting one that is there, or removing one that is not, changes nothing.
  state = await worker.request('debugger.breakpoint', { path: PAGE, line: 24, on: true })
  state = await worker.request('debugger.breakpoint', { path: PAGE, line: 99, on: false })
  assert.deepEqual(state.breakpoints[0].lines.map((each) => each.line), [24])
  assert.deepEqual(worker.host.data().storage['debugger.breakpoints'], { w1: { [PAGE]: [24] } })
  assert.equal(await codeOf(worker.request('debugger.breakpoint', { path: PAGE, line: 0, on: true })), 'invalid_input')
  assert.equal(await codeOf(worker.request('debugger.breakpoint', { path: PAGE, line: 1.5, on: true })), 'invalid_input')
  assert.equal(await codeOf(worker.request('debugger.breakpoint', { path: `${FAKE_ROOT}/${PAGE}`, line: 3, on: true })), 'invalid_path')
  assert.equal(await codeOf(worker.request('debugger.breakpoint', { path: '../outside.js', line: 3, on: true })), 'invalid_path')
})

test('the scripts of the workspace come by cartridge, named by their folder, paths relative to the workspace', async () => {
  const { worker } = await mount()
  assert.deepEqual(await worker.request('debugger.scripts', {}), {
    cartridges: [{ name: 'app_example', path: 'cartridges/app_example', files: ['cartridges/app_example/cartridge/controllers/Home.js', PAGE] }],
    truncated: false
  })
  const none = await mount({ workspace: null })
  assert.equal(await codeOf(none.worker.request('debugger.scripts', {})), 'no_workspace')
})

test('a script’s lines: read only for a script of the cartridges, inside the workspace, masked, never stored', async () => {
  const { worker } = await mount()
  const source = await worker.request('debugger.source', { path: PAGE })
  assert.deepEqual(source, { path: PAGE, lines: ["'use strict';", "var url = 'https://***/';", '\tmodule.exports = url;'], truncated: false })
  assert.ok(!JSON.stringify(worker.host.data().storage).includes('use strict'), 'nothing of it is stored')
  // Only a file the walk of the cartridges found, and never through a link out of the workspace.
  assert.equal(await codeOf(worker.request('debugger.source', { path: 'dw.json' })), 'invalid_path')
  assert.equal(await codeOf(worker.request('debugger.source', { path: 'cartridges/app_example/.project' })), 'invalid_path')
  assert.equal(await codeOf(worker.request('debugger.source', { path: `${FAKE_ROOT}/${PAGE}` })), 'invalid_path')
  assert.equal(await codeOf(worker.request('debugger.source', { path: 'cartridges/app_example/cartridge/controllers/Home.js' })), 'outside_workspace')
})

test('a whole session: start answers at once, posts are coalesced, a halt shows its stack, values come on demand, stop disconnects', async () => {
  const { worker, adapter, states, logs, opened } = await mount()
  await worker.request('debugger.setBreakpoints', { path: PAGE, lines: [11] })
  const started = await worker.request('debugger.start', {})
  assert.equal(started.status, 'connecting')
  await until(() => states().some((state) => state.status === 'attached'), 'attached')
  const attached = states().at(-1) as DebuggerState
  assert.deepEqual(attached.breakpoints, [{ path: PAGE, lines: [{ line: 11, verified: true }] }])
  // connecting, the breakpoint answer and attached changed the state at least three times in a burst: one post.
  assert.ok(states().length <= 2, `coalesced into ${states().length} posts`)
  assert.equal(adapter.last.options.cwd, FAKE_ROOT)
  // A file changed while attached reaches the adapter at once.
  await worker.request('debugger.setBreakpoints', { path: PAGE, lines: [11, 12] })
  assert.equal(adapter.last.commands.at(-1), 'setBreakpoints')

  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  await until(() => (states().at(-1)?.frames.length ?? 0) > 0, 'the halted stack')
  const halted = states().at(-1) as DebuggerState
  assert.equal(halted.status, 'halted')
  assert.deepEqual(halted.frames, [{ id: 70000, name: 'show()', file: 'Page.js', line: 11, path: PAGE }])
  assert.deepEqual(await worker.request('debugger.threads', {}), [{ id: 7, name: 'Thread 7', halted: true }])
  assert.deepEqual(await worker.request('debugger.stack', { threadId: 7 }), halted.frames)
  const scopes = await worker.request('debugger.variables', { frameId: 70000 })
  assert.deepEqual(await worker.request('debugger.variables', { reference: scopes[0].reference }), [{ name: 'host', value: 'https://***/', reference: 0, expensive: false }])
  assert.deepEqual(await worker.request('debugger.evaluate', { expression: 'req.host', frameId: 70000 }), { result: 'value of req.host at ***', reference: 0 })
  // Jumping to a frame opens its file at its line, through Orca's command line, in the workspace.
  assert.deepEqual(await worker.request('debugger.open', { frameId: 70000 }), { opened: true })
  assert.deepEqual(opened.at(-1), { file: ORCA_CLI, args: ['file', 'open', `${FAKE_ROOT}/${PAGE}`, '--worktree', `path:${FAKE_ROOT}`, '--line', '11', '--focus', '--json'] })
  assert.deepEqual(await worker.request('debugger.open', { path: PAGE, line: 3 }), { opened: true })
  assert.deepEqual(opened.at(-1)?.args.slice(5, 7), ['--line', '3'])
  assert.equal(worker.host.calls.filter((call) => call.method === 'editor.open').length, 0, 'no fallback while Orca’s command line runs')
  assert.deepEqual(worker.refusals, [])

  const stepped = await worker.request('debugger.step', { kind: 'over' })
  assert.equal(stepped.status, 'attached')
  assert.equal(adapter.last.commands.at(-1), 'next')
  assert.equal(await codeOf(worker.request('debugger.step', { kind: 'sideways' as never })), 'invalid_input')

  const stopped = await worker.request('debugger.stop', {})
  assert.equal(stopped.status, 'ended')
  assert.ok(adapter.last.commands.includes('disconnect') && adapter.last.ended)
  assert.equal(worker.host.data().storage['debugger.unclean'], undefined, 'a clean end leaves no flag')

  // Nothing of the host reached a post, storage or the log.
  const everything = JSON.stringify([worker.posts, worker.host.data().storage, logs])
  assert.ok(!everything.includes(FAKE_HOST), 'no host anywhere')
})

test('a frame opens at its line and column through orca file open, with the workspace’s folder as its root', async () => {
  const { worker, adapter, states, opened } = await mount()
  adapter.config.frames = [{ id: 1, name: 'show()', source: { name: 'Page.js', path: `${FAKE_ROOT}/${PAGE}` }, line: 24, column: 7 }]
  await worker.request('debugger.start', {})
  await until(() => states().some((state) => state.status === 'attached'), 'attached')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  await until(() => (states().at(-1)?.frames.length ?? 0) > 0, 'halted')
  assert.deepEqual(await worker.request('debugger.open', { frameId: 1 }), { opened: true })
  assert.deepEqual(opened.at(-1)?.args, ['file', 'open', `${FAKE_ROOT}/${PAGE}`, '--worktree', `path:${FAKE_ROOT}`, '--line', '24', '--column', '7', '--focus', '--json'])
})

test('when Orca’s command line cannot run, the file still opens through editor.open, at the top', async () => {
  for (const orca of ['missing', 'fails'] as const) {
    const { worker, opened } = await mount({ orca })
    assert.deepEqual(await worker.request('debugger.open', { path: PAGE, line: 3 }), { opened: true }, orca)
    assert.equal(opened.length, orca === 'missing' ? 0 : 1, `${orca}: started only when found`)
    // editor.open takes the path relative to the workspace, and no line.
    assert.deepEqual(worker.host.calls.filter((call) => call.method === 'editor.open').at(-1)?.params, { workspaceId: 'w1', path: PAGE }, orca)
  }
  // A path outside the workspace is refused before anything runs, and is no reason to fall back.
  const { worker, opened } = await mount()
  assert.equal(await codeOf(worker.request('debugger.open', { path: '../outside.js', line: 1 })), 'invalid_path')
  assert.equal(opened.length, 0)
  assert.equal(worker.host.calls.filter((call) => call.method === 'editor.open').length, 0)
})

test('the commands start, step and stop the session, and say when there is nothing to do', async () => {
  const { worker, adapter, states } = await mount()
  assert.equal(await worker.command('debugger.continue'), 'No request is halted.')
  assert.equal(await worker.command('debugger.stop'), 'The debugger is not running.')
  assert.equal(await worker.command('debugger.start'), 'Debugger connecting to the sandbox.')
  await until(() => states().some((state) => state.status === 'attached'), 'attached')
  assert.equal(await worker.command('debugger.start'), 'The debugger is already running.')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  assert.equal(await worker.command('debugger.stepIn'), 'Sent.')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  assert.equal(await worker.command('debugger.stepOut'), 'Sent.')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  assert.equal(await worker.command('debugger.stepOver'), 'Sent.')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  assert.equal(await worker.command('debugger.continue'), 'Sent.')
  assert.deepEqual(
    adapter.last.commands.filter((command) => ['next', 'stepIn', 'stepOut', 'continue'].includes(command)),
    ['stepIn', 'stepOut', 'next', 'continue']
  )
  assert.equal(await worker.command('debugger.stop'), 'Debugger stopped.')
  assert.ok(adapter.last.commands.includes('disconnect'))
})

test('deactivating the worker disconnects a running session at once', async () => {
  const { worker, adapter, states } = await mount()
  await worker.request('debugger.start', {})
  await until(() => states().some((state) => state.status === 'attached'), 'attached')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  await worker.deactivate()
  assert.equal(adapter.last.commands.at(-1), 'disconnect', 'the halted request is released')
  assert.ok(adapter.last.ended, 'stdin closed once it answered')
})

test('core’s deactivation waits for the debugger’s disconnect answer, then the adapter closes and no flag is left', async () => {
  const { worker, adapter, states, logs } = await mount({ throughCore: true })
  await worker.request('debugger.start', {})
  await until(() => states().some((state) => state.status === 'attached'), 'attached')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  assert.equal(worker.host.data().storage['debugger.unclean'], true)
  // The instance takes a while to delete the debugger client.
  let answered = false
  adapter.handlers.disconnect = (request, process) => {
    setTimeout(() => {
      answered = true
      process.respond(request, {})
    }, 80)
    return 'none'
  }
  await worker.deactivate()
  assert.ok(answered, 'deactivation resolved only after the disconnect was answered')
  assert.ok(adapter.last.ended, 'stdin closed after the answer')
  assert.ok(!adapter.last.stopped, 'the adapter exited by itself; nothing was killed')
  assert.equal(worker.host.data().storage['debugger.unclean'], undefined, 'a clean end leaves no flag')
  assert.ok(!worker.logs.some((line) => /did not stop|failed to stop/.test(line)), worker.logs.join(' | '))
  assert.ok(!JSON.stringify([worker.logs, logs]).includes(FAKE_HOST))
})

test('deactivating tells an open view once that the session ended, with nothing halted, and posts nothing after', async () => {
  const { worker, adapter, states } = await mount()
  await worker.request('debugger.start', {})
  await until(() => states().some((state) => state.status === 'attached'), 'attached')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  await until(() => (states().at(-1)?.frames.length ?? 0) > 0, 'halted')
  await worker.deactivate()
  const last = states().at(-1) as DebuggerState
  assert.equal(last.status, 'ended')
  assert.deepEqual([last.frames, last.threads, last.threadId], [[], [], null])
  assert.ok(last.breakpoints.every((file) => file.lines.every((each) => each.verified === null)), 'no line is said to be set any more')
  const count = worker.posts.length
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(worker.posts.length, count, 'nothing is posted after it')
})

test('a session that did not end cleanly is cleaned up on the next start, from the flag in storage', async () => {
  const { worker, adapter, states } = await mount({ storage: { 'debugger.unclean': true } })
  await worker.request('debugger.start', {})
  await until(() => states().some((state) => state.status === 'attached'), 'attached')
  assert.equal(adapter.processes.length, 2)
  assert.deepEqual(adapter.processes[0].commands, ['initialize', 'launch', 'disconnect'])
  assert.equal(worker.host.data().storage['debugger.unclean'], true, 'set again while the new session runs')
})
