// The debugger's worker half over a mock host and the scripted fake adapter: the requests, the
// commands, coalesced posts, the sandbox-only rule, the store of breakpoints, and the disconnect
// when the worker goes away. No b2c runs.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { B2c } from '../../core/b2c'
import { translator } from '../../core/i18n'
import type { RoleState } from '../../core/instances'
import type { PieceContext, Workspace, Workspaces } from '../../core/piece'
import { createStore } from '../../core/store'
import { plainSettings } from '../../core/test-support'
import { FAKE_HOST, FAKE_ROOT, FakeAdapter } from './fake-adapter'
import type { ReadDir } from './files'
import type { DebuggerState } from './protocol'
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

async function mount({ sandbox = 'ready' as RoleState, workspace = LOCAL as Workspace | null, storage = {} as Record<string, boolean> } = {}) {
  const adapter = new FakeAdapter({
    frames: [{ id: 70000, name: 'show()', source: { name: 'Page.js', path: `${FAKE_ROOT}/${PAGE}` }, line: 11 }],
    threads: [{ id: 7, name: 'Thread 7' }],
    scopes: [{ name: 'Local', variablesReference: 1 }],
    variables: { 1: [{ name: 'host', value: `https://${FAKE_HOST}/`, variablesReference: 0 }] }
  })
  const logs: string[] = []
  let disposable: { dispose(): void } | undefined
  const workspaces: Workspaces = {
    list: async () => (workspace ? [workspace] : []),
    focused: async () => workspace,
    uploading: async () => null,
    setUploading: async () => {},
    configRoot: async () => workspace?.path ?? null
  }
  const module = {
    default: (orca: PieceContext['orca']) => {
      const b2c = {
        ...adapter.b2c,
        instances: async () => ({ config: 'ok', instances: { sandbox, development: 'absent', staging: 'absent', production: 'absent' } }),
        isHost: async () => false
      } as unknown as B2c
      disposable = activateDebugger(
        { orca, b2c, settings: plainSettings(), store: createStore(orca.storage, 'debugger'), workspaces, t: translator(() => 'en'), log: (line) => logs.push(line) },
        { coalesceMs: 20, platform: 'linux', readDir, timeouts: { requestMs: 500, launchMs: 500, disconnectMs: 300, exitMs: 50 } }
      )
    },
    deactivate: () => disposable?.dispose()
  }
  const worker = await mountWorker(module, { host: mockHost({ capabilities: CAPABILITIES, storage, results: { 'editor.open': { opened: true } } }), commands: COMMANDS })
  const states = () => worker.posts.filter((post) => post.event === 'debugger.state').map((post) => post.payload as DebuggerState)
  return { worker, adapter, logs, states }
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

test('a whole session: start answers at once, posts are coalesced, a halt shows its stack, values come on demand, stop disconnects', async () => {
  const { worker, adapter, states, logs } = await mount()
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
  // Jumping to a frame opens its file in the workspace.
  assert.deepEqual(await worker.request('debugger.open', { frameId: 70000 }), { opened: true })
  // Orca takes the path relative to the workspace.
  assert.deepEqual(worker.host.calls.filter((call) => call.method === 'editor.open').at(-1)?.params, { workspaceId: 'w1', path: PAGE })
  assert.deepEqual(await worker.request('debugger.open', { path: PAGE, line: 3 }), { opened: true })
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
  await until(() => adapter.last.ended, 'stdin closed')
})

test('a session that did not end cleanly is cleaned up on the next start, from the flag in storage', async () => {
  const { worker, adapter, states } = await mount({ storage: { 'debugger.unclean': true } })
  await worker.request('debugger.start', {})
  await until(() => states().some((state) => state.status === 'attached'), 'attached')
  assert.equal(adapter.processes.length, 2)
  assert.deepEqual(adapter.processes[0].commands, ['initialize', 'launch', 'disconnect'])
  assert.equal(worker.host.data().storage['debugger.unclean'], true, 'set again while the new session runs')
})
