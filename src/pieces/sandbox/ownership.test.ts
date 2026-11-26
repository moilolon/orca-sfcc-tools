// The ownership state machine with the runner faked: every transition, a failed deploy, a pick
// while another deploy runs, deletion on removal (deferred while active), restore after a worker
// restart, and the code version kept across a rename.
import { assert, test } from 'orca/testing'
import { Ownership, type Notice } from './ownership'
import type { SandboxAction } from './protocol'
import { coded, FakeB2c, FakeTimers, FIX, fakeWorkspaces, memoryStorage, pieceStore, REMOTE, settle, SHOP, type Listed } from './testing'

function setup(options: { listed?: Listed[]; storage?: ReturnType<typeof memoryStorage>; b2c?: FakeB2c } = {}) {
  const b2c = options.b2c ?? new FakeB2c()
  const storage = options.storage ?? memoryStorage()
  const host = fakeWorkspaces(options.listed, storage)
  const timers = new FakeTimers()
  const problems: { action: SandboxAction; code: string | null }[] = []
  const notices: Notice[] = []
  let changes = 0
  const make = () =>
    new Ownership({
      b2c,
      store: pieceStore(storage),
      workspaces: host.workspaces,
      timers,
      prefix: async () => 'ws-',
      onChange: () => void changes++,
      onProblem: (action, code) => void problems.push({ action, code }),
      onNotice: (notice) => void notices.push(notice),
      log: () => {}
    })
  const ownership = make()
  return { b2c, storage, host, timers, problems, notices, ownership, make, changes: () => changes }
}

const stateOf = (ownership: Ownership) => ownership.snapshot().state

test('none → deploying → watching: the whole workspace is deployed to its own version, activated, then watched', async () => {
  const { b2c, ownership, host, notices, timers } = setup()
  assert.equal(stateOf(ownership), 'none')
  b2c.hold.add('code deploy')
  await ownership.pick(SHOP.id)
  assert.equal(stateOf(ownership), 'deploying')
  assert.deepEqual(b2c.runs.at(-1)?.args, ['code', 'deploy', '--code-version', 'ws-shop', '--activate'])
  assert.equal(b2c.runs.at(-1)?.options.role, 'sandbox')
  assert.equal(b2c.runs.at(-1)?.options.cwd, SHOP.path, 'b2c runs in the workspace, the path is never an argument')
  assert.deepEqual(await host.workspaces.upload(), { workspace: { ...SHOP }, codeVersion: 'ws-shop' }, 'other pieces see the upload')

  b2c.release()
  await settle()
  assert.equal(stateOf(ownership), 'watching')
  const watcher = b2c.watchers[0]
  assert.deepEqual(watcher.args, ['code', 'watch', '--code-version', 'ws-shop'])
  assert.equal(watcher.options.jsonl, true)
  assert.equal(watcher.options.cwd, SHOP.path)
  assert.equal(ownership.snapshot().lastDeployAt, timers.now())
  assert.deepEqual(notices, [{ kind: 'deployed', workspace: 'Shop', codeVersion: 'ws-shop' }])
})

test('watching ⇄ uploading follows the watcher’s events; an upload error keeps it watching', async () => {
  const { b2c, ownership, problems } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  const watcher = b2c.watchers[0]
  watcher.emit({ level: 'info', event: 'change', path: 'x', msg: 'File event: change x' })
  assert.equal(stateOf(ownership), 'uploading')
  watcher.emit({ level: 'info', msg: '[UPLOAD] 2 file(s)' })
  assert.equal(stateOf(ownership), 'watching')
  assert.equal(ownership.snapshot().files, 2)
  assert.ok(ownership.snapshot().lastUploadAt)
  watcher.emit({ level: 'info', event: 'unlink', path: 'y', msg: 'File event: unlink y' })
  watcher.emit({ level: 'info', msg: '[DELETE] 1 file(s)' })
  assert.equal(ownership.snapshot().files, 3)
  watcher.emit({ level: 'error', msg: 'Upload failed' })
  assert.equal(stateOf(ownership), 'watching')
  assert.deepEqual(problems.at(-1), { action: 'upload', code: 'upload_failed' })
})

test('deploying → failed when the deploy fails; deploying again recovers', async () => {
  const { b2c, ownership, notices } = setup()
  b2c.fail.set('code deploy', 'b2c_failed')
  await ownership.pick(SHOP.id)
  await settle()
  assert.equal(stateOf(ownership), 'failed')
  assert.equal(ownership.snapshot().reason, 'b2c_failed')
  assert.equal(b2c.watchers.length, 0, 'nothing is watched after a failed deploy')
  assert.deepEqual(notices, [{ kind: 'deployFailed', workspace: 'Shop', code: 'b2c_failed' }])
  b2c.fail.clear()
  await ownership.redeploy()
  await settle()
  assert.equal(stateOf(ownership), 'watching')
  assert.equal(ownership.current()?.codeVersion, 'ws-shop')
})

test('watching → failed when the watcher ends by itself, with why', async () => {
  const { b2c, ownership } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  b2c.watchers[0].exit(1)
  await settle()
  assert.equal(stateOf(ownership), 'failed')
  assert.equal(ownership.snapshot().reason, 'watch_ended')

  await ownership.redeploy()
  await settle()
  b2c.watchers[1].exit(1, 'b2c_not_found')
  await settle()
  assert.equal(ownership.snapshot().reason, 'b2c_not_found')
})

test('a pick while another deploy runs abandons it: its late end starts no watcher', async () => {
  const { b2c, ownership } = setup()
  b2c.hold.add('code deploy')
  await ownership.pick(SHOP.id)
  await ownership.pick(FIX.id)
  assert.equal(b2c.held.length, 2)
  assert.equal(b2c.held[0].options.signal?.aborted, true, 'the first deploy is cancelled')
  assert.equal(stateOf(ownership), 'deploying')
  assert.equal(ownership.current()?.workspaceId, FIX.id)
  b2c.release(1)
  await settle()
  assert.equal(stateOf(ownership), 'watching')
  assert.equal(b2c.watchers.length, 1)
  assert.deepEqual(b2c.watchers[0].args, ['code', 'watch', '--code-version', 'ws-checkout-fix'])
  assert.equal(b2c.watchers[0].options.cwd, FIX.path)
})

test('picking another workspace stops the first one’s watcher and activates the second one’s version', async () => {
  const { b2c, ownership, host } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  const first = b2c.watchers[0]
  await ownership.pick(FIX.id)
  assert.ok(first.stopped, 'the previous owner stops uploading at once')
  await settle()
  assert.equal(b2c.watchers.length, 2)
  assert.ok(!b2c.watchers[1].stopped)
  assert.deepEqual(
    b2c.codeVersions.filter((v) => v.active).map((v) => v.id),
    ['ws-checkout-fix']
  )
  assert.equal((await host.workspaces.upload())?.codeVersion, 'ws-checkout-fix')
  // A late event of the stopped watcher changes nothing.
  first.emit({ level: 'info', event: 'change', path: 'x' })
  assert.equal(stateOf(ownership), 'watching')
})

test('releasing stops the watcher and leaves the version active', async () => {
  const { b2c, ownership, host } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  const before = b2c.commands().length
  await ownership.release()
  assert.equal(stateOf(ownership), 'none')
  assert.ok(b2c.watchers[0].stopped)
  assert.equal(b2c.commands().length, before, 'nothing is activated or deleted')
  assert.ok(b2c.codeVersions.find((v) => v.id === 'ws-shop')?.active)
  assert.equal(await host.workspaces.upload(), null)
  assert.equal(await host.workspaces.uploading(), null)
  await ownership.release()
  assert.equal(stateOf(ownership), 'none', 'releasing twice is harmless')
})

test('releasing during a deploy abandons it', async () => {
  const { b2c, ownership } = setup()
  b2c.hold.add('code deploy')
  await ownership.pick(SHOP.id)
  await ownership.release()
  assert.equal(b2c.held[0].options.signal?.aborted, true)
  await settle()
  assert.equal(stateOf(ownership), 'none')
  assert.equal(b2c.watchers.length, 0)
})

test('the name is derived once and kept: a renamed workspace keeps its version', async () => {
  const { b2c, ownership, host } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  await ownership.pick(FIX.id)
  await settle()
  host.state.listed = host.state.listed.map((w) => (w.id === SHOP.id ? { ...w, name: 'Shop renamed' } : w))
  await ownership.pick(SHOP.id)
  await settle()
  assert.equal(ownership.current()?.codeVersion, 'ws-shop')
  assert.equal(ownership.versionOf(SHOP.id), 'ws-shop')
  assert.deepEqual(
    b2c.commands().filter((c) => c.startsWith('code deploy')),
    ['code deploy --code-version ws-shop --activate', 'code deploy --code-version ws-checkout-fix --activate', 'code deploy --code-version ws-shop --activate']
  )
})

test('a workspace on another host, or no longer listed, is refused with nothing changed', async () => {
  const { b2c, ownership } = setup()
  await assert.rejects(ownership.pick(REMOTE.id), coded('workspace_remote'))
  await assert.rejects(ownership.pick('w-gone'), coded('workspace_unknown'))
  assert.equal(stateOf(ownership), 'none')
  assert.deepEqual(b2c.commands(), [])
})

test('a pick refused because the sandbox is not ready keeps the previous owner uploading', async () => {
  const { b2c, ownership, host } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  b2c.state = { config: 'ok', instances: { sandbox: 'incomplete', development: 'absent', staging: 'absent', production: 'absent' } }
  await assert.rejects(ownership.pick(FIX.id), coded('sandbox_not_ready'))
  assert.equal(ownership.current()?.workspaceId, SHOP.id)
  assert.equal(stateOf(ownership), 'watching')
  assert.ok(!b2c.watchers[0].stopped)
  assert.deepEqual(await host.workspaces.upload(), { workspace: { ...SHOP }, codeVersion: 'ws-shop' })
  b2c.state = { config: 'missing', instances: { sandbox: 'absent', development: 'absent', staging: 'absent', production: 'absent' } }
  await assert.rejects(ownership.pick(FIX.id), coded('config_missing'))
})

test('removing a workspace that does not upload deletes its version', async () => {
  const { b2c, ownership } = setup()
  await ownership.pick(FIX.id)
  await settle()
  await ownership.pick(SHOP.id)
  await settle()
  await ownership.removed(FIX.id)
  await settle()
  assert.ok(b2c.commands().includes('code delete ws-checkout-fix --force'))
  assert.equal(ownership.pendingCount(), 0)
  assert.equal(ownership.versionOf(FIX.id), null)
  assert.equal(ownership.current()?.workspaceId, SHOP.id, 'the owner is untouched')
})

test('removing the owner clears ownership; its active version is deleted after the next activation', async () => {
  const { b2c, ownership, host } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  await ownership.removed(SHOP.id)
  await settle()
  assert.equal(stateOf(ownership), 'none')
  assert.ok(b2c.watchers[0].stopped)
  assert.equal(await host.workspaces.upload(), null)
  assert.ok(!b2c.commands().some((c) => c.startsWith('code delete')), 'the active version is not deleted')
  assert.equal(ownership.pendingCount(), 1)

  await ownership.pick(FIX.id)
  await settle()
  assert.ok(b2c.commands().includes('code delete ws-shop --force'), 'deleted once another version is active')
  assert.equal(ownership.pendingCount(), 0)
  assert.deepEqual(
    b2c.codeVersions.map((v) => v.id),
    ['ws-checkout-fix']
  )
})

test('a queued version is also deleted after a reload, and forgotten when no longer listed', async () => {
  const { b2c, ownership } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  await ownership.removed(SHOP.id)
  await settle()
  // Someone activated another version by hand; the plugin reloads the new owner's.
  await ownership.pick(FIX.id)
  await settle()
  assert.equal(ownership.pendingCount(), 0)

  const second = setup()
  second.b2c.codeVersions = [{ id: 'ws-gone', active: false }]
  await second.ownership.pick(SHOP.id)
  await settle()
  await second.ownership.removed('w-unknown')
  await settle()
  assert.equal(second.ownership.pendingCount(), 0, 'a workspace with no version deletes nothing')
})

test('a failed delete keeps the version queued and says so', async () => {
  const { b2c, ownership, problems } = setup()
  await ownership.pick(FIX.id)
  await settle()
  await ownership.pick(SHOP.id)
  await settle()
  b2c.fail.set('code delete', 'b2c_failed')
  await ownership.removed(FIX.id)
  await settle()
  assert.equal(ownership.pendingCount(), 1)
  assert.deepEqual(problems.at(-1), { action: 'delete', code: 'b2c_failed' })
  b2c.fail.clear()
  await ownership.reload()
  await settle()
  assert.equal(ownership.pendingCount(), 0)
  assert.deepEqual(problems.at(-1), { action: 'delete', code: null })
})

test('reload runs code activate --reload on the owner’s version, in the background', async () => {
  const { b2c, ownership, problems } = setup()
  await assert.rejects(ownership.reload(), coded('no_owner'))
  await ownership.pick(SHOP.id)
  await settle()
  b2c.hold.add('code activate')
  await ownership.reload()
  assert.equal(ownership.snapshot().reloading, true)
  await assert.rejects(ownership.reload(), coded('sandbox_busy'))
  assert.deepEqual(b2c.held[0].args, ['code', 'activate', 'ws-shop', '--reload'])
  b2c.release(0, 'b2c_failed')
  await settle()
  assert.equal(ownership.snapshot().reloading, false)
  assert.deepEqual(problems.at(-1), { action: 'reload', code: 'b2c_failed' })
})

test('after a worker restart the owner’s watcher starts again, with no redeploy', async () => {
  const storage = memoryStorage()
  const first = setup({ storage })
  await first.ownership.pick(SHOP.id)
  await settle()
  const deployedAt = first.ownership.snapshot().lastDeployAt
  first.ownership.dispose()

  const b2c = new FakeB2c()
  const second = setup({ storage, b2c })
  await second.ownership.restore()
  await settle()
  assert.equal(stateOf(second.ownership), 'watching')
  assert.equal(second.ownership.current()?.codeVersion, 'ws-shop')
  assert.equal(second.ownership.snapshot().lastDeployAt, deployedAt, 'the last full deploy is remembered')
  assert.deepEqual(b2c.commands(), ['code watch --code-version ws-shop'])
  assert.equal(b2c.watchers[0].options.cwd, SHOP.path)
  assert.equal(second.ownership.versionOf(SHOP.id), 'ws-shop')
})

test('a restart whose owner was removed meanwhile clears it and queues its version', async () => {
  const storage = memoryStorage()
  const first = setup({ storage })
  await first.ownership.pick(SHOP.id)
  await settle()
  first.ownership.dispose()

  const b2c = new FakeB2c()
  b2c.codeVersions = [{ id: 'ws-shop', active: true }]
  const second = setup({ storage, b2c, listed: [FIX] })
  await second.ownership.restore()
  await settle()
  assert.equal(stateOf(second.ownership), 'none')
  assert.equal(second.ownership.pendingCount(), 1, 'still active: it waits')
  assert.equal(b2c.watchers.length, 0)
  assert.equal(await second.host.workspaces.upload(), null)
})

test('nothing here follows the focus: changing the focused workspace never changes the owner', async () => {
  const { b2c, ownership, host } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  const commands = b2c.commands().length
  host.state.focused = FIX.id
  await settle()
  assert.equal(ownership.current()?.workspaceId, SHOP.id)
  assert.equal((await host.workspaces.upload())?.workspace.id, SHOP.id)
  assert.equal(b2c.commands().length, commands)
})
