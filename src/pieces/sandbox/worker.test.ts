// The sandbox piece's worker half over a stand-in Orca and a faked runner: its commands and
// requests, the removal event, the status bar items, a role that is not ready, and that the focus
// never decides who uploads.
import { assert, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { translator } from '../../core/i18n'
import type { PieceContext } from '../../core/piece'
import { plainSettings } from '../../core/test-support'
import type { SandboxStatus } from './protocol'
import { STATUS_ITEM, UPLOAD_ITEM } from './status-bar'
import { coded, FakeB2c, FakeTimers, FIX, fakeWorkspaces, memoryStorage, pieceStore, REMOTE, settle, SHOP } from './testing'
import { HOST_TIMEOUT_MS } from './ownership'
import { COMMANDS, startSandbox } from './worker'

type Handler = (input: unknown) => Promise<unknown>

function fakeOrca(settings: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, () => Promise<unknown>>()
  const events = new Map<string, ((payload: unknown) => unknown)[]>()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const posts: { event: string; payload: unknown }[] = []
  const orca = {
    panels: {
      handle: (name: string, fn: Handler) => {
        handlers.set(name, fn)
        return { dispose: () => handlers.delete(name) }
      },
      post: async (event: string, payload: unknown) => void posts.push({ event, payload })
    },
    commands: {
      register: (id: string, fn: () => Promise<unknown>) => {
        commands.set(id, fn)
        return { dispose: () => commands.delete(id) }
      }
    },
    events: {
      on: (event: string, fn: (payload: unknown) => unknown) => {
        events.set(event, [...(events.get(event) ?? []), fn])
        return { dispose() {} }
      }
    },
    host: {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        return { ok: true }
      }
    },
    settings: { get: async (key: string) => settings[key] },
    log: () => {}
  } as unknown as OrcaWorkerApi
  return {
    orca,
    calls,
    posts,
    request: (name: string, input: unknown = {}) => handlers.get(name)!(input) as Promise<SandboxStatus>,
    command: (id: string) => commands.get(id)!() as Promise<string>,
    async emit(event: string, payload: unknown) {
      for (const fn of events.get(event) ?? []) await fn(payload)
    },
    bar: (id: string) => calls.filter((call) => call.method === 'statusBar.update' && call.params.id === id).at(-1)?.params
  }
}

async function start(options: { b2c?: FakeB2c; settings?: Record<string, unknown>; locale?: string } = {}) {
  const b2c = options.b2c ?? new FakeB2c()
  const storage = memoryStorage()
  const host = fakeWorkspaces(undefined, storage)
  const fake = fakeOrca(options.settings)
  const timers = new FakeTimers()
  const ctx: PieceContext = {
    orca: fake.orca,
    b2c,
    settings: plainSettings(),
    store: pieceStore(storage),
    workspaces: host.workspaces,
    t: translator(() => options.locale ?? 'en'),
    log: () => {}
  }
  const sandbox = startSandbox(ctx, timers, host.listing)
  await sandbox.ready
  await settle()
  return { b2c, host, fake, timers, sandbox }
}

test('on start it reads the sandbox list once and shows the state in the status bar', async () => {
  const { b2c, fake, sandbox } = await start()
  assert.deepEqual(b2c.commands(), ['sandbox list'])
  await sandbox.flush()
  assert.deepEqual(fake.bar(STATUS_ITEM), { id: STATUS_ITEM, text: 'Sandbox started', tone: 'success', icon: 'cloud', tooltip: 'No workspace uploads. Press to refresh.', visible: true })
  assert.deepEqual(fake.bar(UPLOAD_ITEM), { id: UPLOAD_ITEM, visible: false })
  sandbox.dispose()
})

test('the requests answer with the state; a refused one rejects with its code', async () => {
  const { fake, sandbox } = await start()
  const before = await fake.request('sandbox.status')
  assert.equal(before.upload.state, 'none')
  assert.deepEqual(
    before.workspaces.map((w) => [w.id, w.local]),
    [
      [SHOP.id, true],
      [FIX.id, true],
      [REMOTE.id, false]
    ]
  )
  const picked = await fake.request('sandbox.pick', { workspaceId: SHOP.id })
  assert.equal(picked.upload.workspaceId, SHOP.id)
  assert.equal(picked.upload.codeVersion, 'ws-shop')
  await settle()
  assert.equal((await fake.request('sandbox.status')).upload.state, 'watching')
  await assert.rejects(fake.request('sandbox.pick', { workspaceId: REMOTE.id }), coded('workspace_remote'))
  const released = await fake.request('sandbox.release')
  assert.equal(released.upload.state, 'none')
  await assert.rejects(fake.request('sandbox.reload'), coded('no_owner'))
  sandbox.dispose()
})

test('the prefix setting names new code versions', async () => {
  const { fake, sandbox } = await start({ settings: { codeVersionPrefix: 'dev_' } })
  const picked = await fake.request('sandbox.pick', { workspaceId: FIX.id })
  assert.equal(picked.upload.codeVersion, 'dev_checkout-fix')
  sandbox.dispose()
})

test('"Upload from this workspace" picks the workspace it is run in, by hand', async () => {
  const { b2c, fake, host, sandbox } = await start()
  assert.equal(await fake.command(COMMANDS.pick), 'No workspace is focused.')
  host.state.focused = FIX.id
  assert.equal(await fake.command(COMMANDS.pick), 'Deploying Checkout Fix to ws-checkout-fix. Its changes upload once the deploy ends.')
  await settle()
  assert.ok(b2c.commands().includes('code deploy --code-version ws-checkout-fix --activate'))
  host.state.focused = REMOTE.id
  assert.equal(await fake.command(COMMANDS.pick), 'That workspace is on another machine: only local workspaces upload.')
  assert.equal(await fake.command(COMMANDS.release), 'Stopped uploading. ws-checkout-fix stays active on the sandbox.')
  assert.equal(await fake.command(COMMANDS.release), 'No workspace was uploading.')
  sandbox.dispose()
})

test('a focus change never changes the owner, and uploads nothing', async () => {
  const { b2c, fake, host, sandbox } = await start()
  await fake.request('sandbox.pick', { workspaceId: SHOP.id })
  await settle()
  const commands = b2c.commands().length
  for (const focused of [FIX.id, REMOTE.id, null]) {
    host.state.focused = focused
    await fake.emit('workspace.changed', { context: focused ? { workspaceId: focused, branch: '', displayName: '', terminals: [] } : null })
    await settle()
  }
  const status = await fake.request('sandbox.status')
  assert.equal(status.upload.workspaceId, SHOP.id)
  assert.equal(status.upload.state, 'watching')
  assert.equal((await host.workspaces.upload())?.workspace.id, SHOP.id)
  assert.equal(b2c.commands().length, commands, 'no deploy, no watcher for the focused workspace')
  assert.equal(b2c.watchers.filter((w) => !w.stopped).length, 1)
  assert.equal(b2c.watchers[0].options.cwd, SHOP.path)
  sandbox.dispose()
})

test('a removed workspace’s version is deleted; the owner’s waits for the next activation', async () => {
  const { b2c, fake, sandbox } = await start()
  await fake.request('sandbox.pick', { workspaceId: FIX.id })
  await settle()
  await fake.request('sandbox.pick', { workspaceId: SHOP.id })
  await settle()
  await fake.emit('workspace.removed', { workspaceId: 'orca-internal-id', workspaceListId: FIX.id, kind: 'worktree', path: FIX.path })
  await settle()
  assert.ok(b2c.commands().includes('code delete ws-checkout-fix --force'))

  await fake.emit('workspace.removed', { workspaceId: SHOP.id, kind: 'worktree', path: SHOP.path })
  await settle()
  const status = await fake.request('sandbox.status')
  assert.equal(status.upload.state, 'none')
  assert.equal(status.pendingDeletes, 1)
  assert.ok(!b2c.commands().includes('code delete ws-shop --force'))
  sandbox.dispose()
})

test('a sandbox role that is not ready shows as such, and every command answers why without running', async () => {
  const b2c = new FakeB2c()
  b2c.state = { config: 'ok', instances: { sandbox: 'incomplete', development: 'ready', staging: 'absent', production: 'absent' } }
  const { fake, host, sandbox } = await start({ b2c })
  host.state.focused = SHOP.id
  const reason = 'The sandbox is not ready in dw.json: it needs a host and credentials b2c can use.'
  for (const id of [COMMANDS.pick, COMMANDS.deploy, COMMANDS.reload, COMMANDS.refresh, COMMANDS.start, COMMANDS.stop]) {
    assert.equal(await fake.command(id), reason, id)
  }
  assert.equal(await fake.command(COMMANDS.release), 'No workspace was uploading.')
  await assert.rejects(fake.request('sandbox.start'), coded('sandbox_not_ready'))
  await assert.rejects(fake.request('sandbox.pick', { workspaceId: SHOP.id }), coded('sandbox_not_ready'))
  assert.deepEqual(b2c.commands(), [], 'b2c never ran')
  const status = await fake.request('sandbox.status')
  assert.equal(status.role, 'incomplete')
  assert.equal(status.sandbox.state, 'unknown')
  assert.equal(status.sandbox.reason, 'sandbox_not_ready')
  await sandbox.flush()
  assert.equal(fake.bar(STATUS_ITEM)?.text, 'Sandbox not ready')
  assert.equal(fake.bar(STATUS_ITEM)?.tone, 'warning')

  b2c.state = { config: 'missing', instances: { sandbox: 'absent', development: 'absent', staging: 'absent', production: 'absent' } }
  assert.equal(await fake.command(COMMANDS.start), 'No dw.json was found for that workspace.')
  sandbox.dispose()
})

test('start and stop are fired from a command and followed on the list', async () => {
  const b2c = new FakeB2c()
  b2c.sandboxList = { data: [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', state: 'stopped', hostName: 'sandbox-01.example.com' }] }
  const { fake, sandbox } = await start({ b2c })
  assert.equal(await fake.command(COMMANDS.start), 'Starting the sandbox. The status bar follows it until it is started.')
  assert.deepEqual(b2c.runs.at(-1)?.args, ['sandbox', 'start', 'aaaaaaaa-1111-2222-3333-444444444444'])
  await sandbox.flush()
  assert.equal(fake.bar(STATUS_ITEM)?.text, 'Sandbox starting')
  assert.equal(await fake.command(COMMANDS.stop), 'The sandbox is busy with another operation.')
  sandbox.dispose()
})

test('the status bar shows the owner and its version, and the upload only while it deploys, uploads or failed', async () => {
  const b2c = new FakeB2c()
  b2c.hold.add('code deploy')
  const { fake, sandbox } = await start({ b2c })
  await fake.request('sandbox.pick', { workspaceId: SHOP.id })
  await sandbox.flush()
  assert.equal(fake.bar(STATUS_ITEM)?.text, 'Sandbox started · ws-shop')
  assert.equal(fake.bar(STATUS_ITEM)?.tooltip, 'Shop uploads to ws-shop. Press to refresh.')
  assert.deepEqual(fake.bar(UPLOAD_ITEM), { id: UPLOAD_ITEM, text: 'Deploying ws-shop', tone: 'accent', icon: 'upload', tooltip: 'Shop uploads to ws-shop.', visible: true })
  b2c.release()
  await settle()
  await sandbox.flush()
  assert.deepEqual(fake.bar(UPLOAD_ITEM), { id: UPLOAD_ITEM, visible: false })
  b2c.watchers[0].emit({ level: 'info', event: 'change', path: 'x' })
  await sandbox.flush()
  assert.equal(fake.bar(UPLOAD_ITEM)?.text, 'Uploading to ws-shop')
  b2c.watchers[0].exit(1)
  await settle()
  await sandbox.flush()
  assert.deepEqual(fake.bar(UPLOAD_ITEM), { id: UPLOAD_ITEM, text: 'Upload failed', tone: 'danger', icon: 'error', tooltip: 'b2c stopped watching the workspace.', visible: true })
  assert.ok(fake.posts.some((post) => post.event === 'sandbox.changed'), 'the view hears every change')
  sandbox.dispose()
})

test('a deploy notifies when it ends, well or not', async () => {
  const b2c = new FakeB2c()
  const { fake, sandbox } = await start({ b2c })
  await fake.request('sandbox.pick', { workspaceId: SHOP.id })
  await settle()
  b2c.fail.set('code deploy', 'b2c_failed')
  await fake.request('sandbox.deploy')
  await settle()
  const notices = fake.calls.filter((call) => call.method === 'notifications.show').map((call) => call.params)
  assert.deepEqual(notices, [
    { title: 'Deployed ws-shop', body: 'The changes of Shop are uploaded as they are saved.' },
    { title: 'The deploy failed', body: 'Shop: b2c ended with an error.' }
  ])
  sandbox.dispose()
})

test('a stored version whose workspace a whole list no longer holds is offered for deletion, by hand only', async () => {
  const { b2c, fake, host, sandbox } = await start()
  await fake.request('sandbox.pick', { workspaceId: FIX.id })
  await settle()
  await fake.request('sandbox.pick', { workspaceId: SHOP.id })
  await settle()
  host.state.listed = [SHOP, REMOTE]
  host.state.truncated = true
  assert.deepEqual((await fake.request('sandbox.status')).leftovers, [], 'a short list offers nothing')
  host.state.truncated = false
  const status = await fake.request('sandbox.status')
  assert.deepEqual(status.leftovers, [{ workspaceId: FIX.id, codeVersion: 'ws-checkout-fix', checkable: true }])
  assert.ok(!b2c.commands().some((c) => c.startsWith('code delete')), 'listing it deletes nothing')
  await fake.request('sandbox.forget', { workspaceId: FIX.id })
  await settle()
  assert.ok(b2c.commands().includes('code delete ws-checkout-fix --force'))
  assert.deepEqual((await fake.request('sandbox.status')).leftovers, [])
  sandbox.dispose()
})

test('a leftover in a hidden project, or one Orca cannot vouch for, is shown but cannot be deleted', async () => {
  const { b2c, fake, host, sandbox } = await start()
  host.state.listed = [{ ...SHOP, projectId: 'p-shop' }, { ...FIX, projectId: 'p-hidden' }, REMOTE]
  await fake.request('sandbox.pick', { workspaceId: FIX.id })
  await settle()
  await fake.request('sandbox.pick', { workspaceId: SHOP.id })
  await settle()
  host.state.listed = [{ ...SHOP, projectId: 'p-shop' }, REMOTE]
  host.state.hidden = ['p-hidden']
  assert.deepEqual((await fake.request('sandbox.status')).leftovers, [{ workspaceId: FIX.id, codeVersion: 'ws-checkout-fix', checkable: false }])
  await assert.rejects(fake.request('sandbox.forget', { workspaceId: FIX.id }), coded('workspace_hidden'))
  host.state.hidden = null
  assert.equal((await fake.request('sandbox.status')).leftovers[0].checkable, false, 'Orca cannot say which projects are hidden')
  await assert.rejects(fake.request('sandbox.forget', { workspaceId: FIX.id }), coded('workspace_hidden'))
  assert.ok(!b2c.commands().some((c) => c.startsWith('code delete')))
  host.state.hidden = []
  assert.equal((await fake.request('sandbox.status')).leftovers[0].checkable, true)
  sandbox.dispose()
})

test('the view’s state is answered even when the workspace list never comes', async () => {
  const { fake, host, timers, sandbox } = await start()
  host.state.listHangs = true
  const answer = fake.request('sandbox.status')
  await timers.advance(HOST_TIMEOUT_MS)
  const status = await answer
  assert.deepEqual(status.workspaces, [])
  assert.deepEqual(status.leftovers, [])
  sandbox.dispose()
})
