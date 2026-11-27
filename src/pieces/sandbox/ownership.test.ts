// The ownership state machine with the runner faked: every transition, a failed deploy, picks
// that overlap a deploy, a restore or each other, deletion only on removal (deferred while
// active), restore after a worker restart (whole, short or failing list; interrupted deploy), and
// the code version kept across a rename.
import { assert, test } from 'orca/testing'
import { HOST_TIMEOUT_MS, LIST_TIMEOUT_MS, Ownership, type Notice } from './ownership'
import type { SandboxAction } from './protocol'
import { coded, FakeB2c, FakeTimers, FIX, fakeWorkspaces, memoryStorage, pieceStore, REMOTE, SANDBOX_HOST, settle, SHOP, type Listed } from './testing'

function setup(options: { listed?: Listed[]; storage?: ReturnType<typeof memoryStorage>; b2c?: FakeB2c } = {}) {
  const b2c = options.b2c ?? new FakeB2c()
  const storage = options.storage ?? memoryStorage()
  const host = fakeWorkspaces(options.listed, storage)
  const timers = new FakeTimers()
  const problems: { action: SandboxAction; code: string | null }[] = []
  const notices: Notice[] = []
  const ownership = new Ownership({
    b2c,
    store: pieceStore(storage),
    workspaces: host.workspaces,
    listing: host.listing,
    timers,
    prefix: async () => 'ws-',
    onChange: () => {},
    onProblem: (action, code) => void problems.push({ action, code }),
    onNotice: (notice) => void notices.push(notice),
    log: () => {}
  })
  return { b2c, storage, host, timers, problems, notices, ownership }
}

const stateOf = (ownership: Ownership) => ownership.snapshot().state

/** The `code watch` processes still running. */
const alive = (b2c: FakeB2c) => b2c.watchers.filter((watcher) => !watcher.stopped)

/** Stores Shop as the owner, deployed and watched, as a first run of the worker leaves it. */
async function firstRun(storage: ReturnType<typeof memoryStorage>, finish = true) {
  const first = setup({ storage })
  if (!finish) first.b2c.hold.add('code deploy')
  await first.ownership.pick(SHOP.id)
  await settle()
  first.ownership.dispose()
  return first
}

test('none → deploying → watching: the whole workspace is deployed to its own version, activated, then watched', async () => {
  const { b2c, ownership, host, notices, timers } = setup()
  assert.equal(stateOf(ownership), 'none')
  b2c.hold.add('code deploy')
  await ownership.pick(SHOP.id)
  assert.equal(stateOf(ownership), 'deploying')
  assert.deepEqual(b2c.commands(), ['code list', 'code deploy --code-version ws-shop --activate'], 'a new name is checked against the sandbox first')
  assert.equal(b2c.runs.at(-1)?.options.role, 'sandbox')
  assert.equal(b2c.runs.at(-1)?.options.cwd, SHOP.path, 'b2c runs in the workspace, the path is never an argument')
  assert.deepEqual(await host.workspaces.upload(), { workspace: { ...SHOP }, codeVersion: 'ws-shop' }, 'other pieces see the upload')
  assert.equal(ownership.snapshot().deployed, false)

  b2c.release()
  await settle()
  assert.equal(stateOf(ownership), 'watching')
  const watcher = b2c.watchers[0]
  assert.deepEqual(watcher.args, ['code', 'watch', '--code-version', 'ws-shop'])
  assert.equal(watcher.options.jsonl, true)
  assert.equal(watcher.options.cwd, SHOP.path)
  assert.equal(ownership.snapshot().lastDeployAt, timers.now())
  assert.equal(ownership.snapshot().deployed, true)
  assert.equal(ownership.snapshot().restored, false, 'a fresh deploy is not a restored watcher')
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
  assert.equal(ownership.snapshot().deployed, false)
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

test('two picks at once both keep their version name, and one watcher runs', async () => {
  const { b2c, ownership } = setup()
  await Promise.all([ownership.pick(SHOP.id), ownership.pick(FIX.id)])
  await settle()
  assert.equal(ownership.versionOf(SHOP.id), 'ws-shop', 'the first pick’s name is not lost')
  assert.equal(ownership.versionOf(FIX.id), 'ws-checkout-fix')
  assert.equal(ownership.current()?.workspaceId, FIX.id, 'the last pick wins')
  assert.equal(alive(b2c).length, 1)
  assert.equal(ownership.watching(), 1)

  // Two workspaces whose names give one slug never share a version, even picked together.
  const twins = setup({ listed: [SHOP, { ...FIX, name: 'shop' }] })
  await Promise.all([twins.ownership.pick(SHOP.id), twins.ownership.pick(FIX.id)])
  await settle()
  assert.equal(twins.ownership.versionOf(SHOP.id), 'ws-shop')
  assert.equal(twins.ownership.versionOf(FIX.id), 'ws-shop-2')
})

test('a new name never takes a version that is already on the sandbox', async () => {
  const b2c = new FakeB2c()
  b2c.codeVersions = [{ id: 'ws-shop', active: true }]
  const { ownership } = setup({ b2c })
  await ownership.pick(SHOP.id)
  await settle()
  assert.equal(ownership.versionOf(SHOP.id), 'ws-shop-2')
  assert.ok(b2c.codeVersions.some((v) => v.id === 'ws-shop'), 'the existing one is left alone')

  const refused = setup()
  refused.b2c.fail.set('code list', 'b2c_failed')
  await assert.rejects(refused.ownership.pick(SHOP.id), coded('b2c_failed'))
  assert.equal(refused.ownership.current(), null, 'no name without the sandbox’s list')
  assert.equal(await refused.host.workspaces.upload(), null)
})

test('picking another workspace stops the first one’s watcher and activates the second one’s version', async () => {
  const { b2c, ownership, host } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  const first = b2c.watchers[0]
  await ownership.pick(FIX.id)
  assert.ok(first.stopped, 'the previous owner stops uploading at once')
  await settle()
  assert.equal(alive(b2c).length, 1)
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

test('removing a workspace with no version deletes nothing', async () => {
  const { b2c, ownership } = setup()
  await ownership.removed('w-unknown')
  await settle()
  assert.equal(ownership.pendingCount(), 0)
  assert.deepEqual(b2c.commands(), [])
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

test('a delete that times out while Salesforce goes on deleting counts as done; one still listed is retried', async () => {
  const { b2c, ownership, problems } = setup()
  await ownership.pick(FIX.id)
  await settle()
  await ownership.pick(SHOP.id)
  await settle()
  // The server renames the version it deletes, and the delete answers a timeout.
  b2c.fail.set('code delete', 'b2c_timeout')
  b2c.sideEffects.set('code delete', (args) => {
    b2c.codeVersions = b2c.codeVersions.map((v) => (v.id === args[2] ? { ...v, id: `.deleted_1_${v.id}` } : v))
  })
  await ownership.removed(FIX.id)
  await settle()
  assert.equal(ownership.pendingCount(), 0, 'renamed: deleted')
  assert.deepEqual(problems.at(-1), { action: 'delete', code: null }, 'not shown as a failure')
  assert.equal(b2c.commands().filter((c) => c === 'code delete ws-checkout-fix --force').length, 1)
  assert.equal(b2c.commands().at(-1), 'code list', 'the list was read again after the failure')

  // A renamed version is never a workspace's and never deleted again, even when queued.
  assert.equal(ownership.versionOf(FIX.id), null)
  assert.ok(!Object.values(ownership.storedVersions()).some((v) => v.startsWith('.deleted_')))
  await ownership.reload()
  await settle()
  assert.ok(!b2c.commands().some((c) => c.startsWith('code delete .deleted_')))

  // Gone altogether after the timeout: deleted too.
  await ownership.pick(FIX.id)
  await settle()
  await ownership.pick(SHOP.id)
  await settle()
  b2c.sideEffects.set('code delete', (args) => {
    b2c.codeVersions = b2c.codeVersions.filter((v) => v.id !== args[2])
  })
  await ownership.removed(FIX.id)
  await settle()
  assert.equal(ownership.pendingCount(), 0, 'gone: deleted')
  assert.deepEqual(problems.at(-1), { action: 'delete', code: null })

  // Still listed under its own name: a real failure, retried at the next activation.
  await ownership.pick(FIX.id)
  await settle()
  await ownership.pick(SHOP.id)
  await settle()
  b2c.sideEffects.clear()
  await ownership.removed(FIX.id)
  await settle()
  assert.equal(ownership.pendingCount(), 1, 'still there: kept')
  assert.deepEqual(problems.at(-1), { action: 'delete', code: 'b2c_timeout' })
  b2c.fail.clear()
  await ownership.reload()
  await settle()
  assert.equal(ownership.pendingCount(), 0, 'retried')
  assert.ok(!b2c.codeVersions.some((v) => v.id === 'ws-checkout-fix-2' || v.id === 'ws-checkout-fix'))
})

test('a version is deleted with its own workspace’s dw.json, taken when it is queued, whatever the focus does next', async () => {
  const { b2c, ownership, host } = setup()
  b2c.files = { configRoot: () => host.workspaces.configRoot(), hosts: { [SHOP.path]: SANDBOX_HOST, [FIX.path]: SANDBOX_HOST } }
  host.state.focused = SHOP.id
  await ownership.pick(FIX.id)
  await settle()
  await ownership.pick(SHOP.id)
  await settle()

  // The delete times out and the version is still there: the list, the delete and the check all
  // name the fix's folder, though Shop uploads.
  b2c.fail.set('code delete', 'b2c_timeout')
  const before = b2c.runs.length
  await ownership.removed(FIX.id)
  await settle()
  assert.equal(ownership.pendingCount(), 1)
  const deletion = b2c.runs.slice(before)
  assert.deepEqual(deletion.map((run) => run.args.join(' ')), ['code list', 'code delete ws-checkout-fix --force', 'code list'])
  assert.ok(deletion.every((run) => run.root === FIX.path), 'every call used the fix’s dw.json')

  // Nothing uploads now and the focus is on a workspace whose folder has no dw.json: the retry
  // still uses the fix's.
  await ownership.release()
  host.state.focused = REMOTE.id
  b2c.fail.clear()
  const retry = b2c.runs.length
  await ownership.deletePending()
  assert.equal(ownership.pendingCount(), 0)
  assert.ok(b2c.runs.slice(retry).every((run) => run.root === FIX.path))
  assert.ok(!b2c.codeVersions.some((v) => v.id === 'ws-checkout-fix'))
})

test('a removed worktree whose folder no longer configures the sandbox is deleted with the dw.json in force when it was queued', async () => {
  const { b2c, ownership, host } = setup()
  const files = { [SHOP.path]: SANDBOX_HOST, [FIX.path]: SANDBOX_HOST }
  b2c.files = { configRoot: () => host.workspaces.configRoot(), hosts: files }
  await ownership.pick(FIX.id)
  await settle()
  await ownership.pick(SHOP.id)
  await settle()
  // The worktree's folder is gone with its dw.json.
  delete files[FIX.path]
  b2c.fail.set('code delete', 'b2c_timeout')
  await ownership.removed(FIX.id)
  await settle()
  assert.equal(ownership.pendingCount(), 1)
  assert.equal(b2c.runs.at(-1)?.root, SHOP.path, 'Shop uploaded when it was queued')

  await ownership.release()
  host.state.focused = REMOTE.id
  b2c.fail.clear()
  const retry = b2c.runs.length
  await ownership.deletePending()
  assert.equal(ownership.pendingCount(), 0)
  assert.ok(b2c.runs.slice(retry).length > 0 && b2c.runs.slice(retry).every((run) => run.root === SHOP.path))
})

test('a version left by a workspace removed unheard is deleted only by hand, and only from a whole list', async () => {
  const { b2c, ownership, host } = setup()
  await ownership.pick(FIX.id)
  await settle()
  await ownership.pick(SHOP.id)
  await settle()
  host.state.listed = [SHOP, REMOTE]
  await assert.rejects(ownership.forget(SHOP.id), coded('workspace_uploads'))
  host.state.truncated = true
  await assert.rejects(ownership.forget(FIX.id), coded('workspace_list_unavailable'))
  host.state.truncated = false
  host.state.listed = [SHOP, FIX]
  await assert.rejects(ownership.forget(FIX.id), coded('workspace_listed'))
  assert.ok(!b2c.commands().some((c) => c.startsWith('code delete')), 'nothing deleted from a list')
  host.state.listed = [SHOP]
  await ownership.forget(FIX.id)
  await settle()
  assert.ok(b2c.commands().includes('code delete ws-checkout-fix --force'))
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

test('reload is refused for a version whose last deploy failed: nothing is activated', async () => {
  const { b2c, ownership } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  b2c.fail.set('code deploy', 'b2c_failed')
  await ownership.redeploy()
  await settle()
  assert.equal(stateOf(ownership), 'failed')
  await assert.rejects(ownership.reload(), coded('deploy_needed'))
  assert.ok(!b2c.commands().some((c) => c.startsWith('code activate')))
})

test('after a worker restart the owner’s watcher starts again, with no redeploy', async () => {
  const storage = memoryStorage()
  const first = await firstRun(storage)
  const deployedAt = first.ownership.snapshot().lastDeployAt

  const b2c = new FakeB2c()
  const second = setup({ storage, b2c })
  await second.ownership.restore()
  await settle()
  assert.equal(stateOf(second.ownership), 'watching')
  assert.equal(second.ownership.snapshot().restored, true)
  assert.equal(second.ownership.current()?.codeVersion, 'ws-shop')
  assert.equal(second.ownership.snapshot().lastDeployAt, deployedAt, 'the last full deploy is remembered')
  assert.deepEqual(b2c.commands(), ['code watch --code-version ws-shop'])
  assert.equal(b2c.watchers[0].options.cwd, SHOP.path)
  assert.equal(second.ownership.versionOf(SHOP.id), 'ws-shop')
})

test('a restart that cut a deploy short shows a deploy is needed: no watcher, no reload', async () => {
  const storage = memoryStorage()
  await firstRun(storage, false)

  const b2c = new FakeB2c()
  const second = setup({ storage, b2c })
  await second.ownership.restore()
  await settle()
  assert.equal(stateOf(second.ownership), 'failed')
  assert.equal(second.ownership.snapshot().reason, 'deploy_needed')
  assert.equal(second.ownership.snapshot().deployed, false)
  assert.equal(b2c.watchers.length, 0)
  await assert.rejects(second.ownership.reload(), coded('deploy_needed'))
  assert.deepEqual(b2c.commands(), [])
  await second.ownership.redeploy()
  await settle()
  assert.equal(stateOf(second.ownership), 'watching')
})

test('a pick that lands while the restore awaits the list waits for it: one owner, one watcher', async () => {
  const storage = memoryStorage()
  await firstRun(storage)

  const b2c = new FakeB2c()
  const second = setup({ storage, b2c })
  const letGo = second.host.holdList()
  const restoring = second.ownership.restore()
  await settle()
  const picking = second.ownership.pick(FIX.id)
  await settle()
  letGo()
  await Promise.all([restoring, picking])
  await settle()
  assert.equal(second.ownership.current()?.workspaceId, FIX.id, 'the pick is not undone')
  assert.equal((await second.host.workspaces.upload())?.workspace.id, FIX.id)
  assert.equal(alive(b2c).length, 1, 'never two watchers')
  assert.equal(alive(b2c)[0].options.cwd, FIX.path)

  // The next restart restores the pick, not the old owner.
  second.ownership.dispose()
  const third = setup({ storage })
  await third.ownership.restore()
  await settle()
  assert.equal(third.ownership.current()?.workspaceId, FIX.id)
})

test('an owner missing from a whole list at restart is kept and shown as not found; nothing is deleted', async () => {
  const storage = memoryStorage()
  await firstRun(storage)

  const b2c = new FakeB2c()
  b2c.codeVersions = [{ id: 'ws-shop', active: true }]
  const second = setup({ storage, b2c, listed: [FIX] })
  await second.ownership.restore()
  await settle()
  assert.equal(stateOf(second.ownership), 'failed')
  assert.equal(second.ownership.snapshot().reason, 'workspace_not_found')
  assert.equal(second.ownership.current()?.workspaceId, SHOP.id, 'kept until released or removed')
  assert.equal(second.ownership.pendingCount(), 0)
  assert.equal(b2c.watchers.length, 0)
  // The list is whole again and another workspace is picked: Shop's version stays.
  second.host.state.listed = [SHOP, FIX]
  await second.ownership.pick(FIX.id)
  await settle()
  assert.ok(!b2c.commands().some((c) => c.startsWith('code delete')))
  assert.equal(second.ownership.versionOf(SHOP.id), 'ws-shop')
})

test('a short or failing list at restart never clears the owner', async () => {
  for (const cut of ['truncated', 'fails'] as const) {
    const storage = memoryStorage()
    await firstRun(storage)
    const b2c = new FakeB2c()
    const second = setup({ storage, b2c, listed: [FIX] })
    if (cut === 'truncated') second.host.state.truncated = true
    else second.host.state.listFails = true
    await second.ownership.restore()
    await settle()
    assert.equal(second.ownership.snapshot().reason, 'workspace_list_unavailable', cut)
    assert.equal(second.ownership.current()?.workspaceId, SHOP.id, cut)
    assert.equal(await second.storage.source.get('core.uploading'), SHOP.id, cut)
    assert.deepEqual(b2c.commands(), [], cut)
  }
})

test('restore never looks at the focused workspace, and never picks one', async () => {
  const { b2c, ownership, host } = setup()
  host.state.focused = FIX.id
  await ownership.restore()
  await settle()
  assert.equal(host.state.focusReads, 0, 'the focus is never read')
  assert.equal(ownership.current(), null)
  assert.equal(stateOf(ownership), 'none')
  assert.deepEqual(b2c.commands(), [])

  const storage = memoryStorage()
  await firstRun(storage)
  const second = setup({ storage })
  second.host.state.focused = FIX.id
  await second.ownership.restore()
  await settle()
  assert.equal(second.host.state.focusReads, 0)
  assert.equal(second.ownership.current()?.workspaceId, SHOP.id)
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
  assert.equal(host.state.focusReads, 0)
})

test('a workspace list that never answers fails the step with a worded reason, and the queue moves on', async () => {
  const { b2c, ownership, host, timers } = setup()
  host.state.listHangs = true
  const hung = ownership.pick(SHOP.id)
  const after = ownership.pick(FIX.id)
  await settle()
  await timers.advance(HOST_TIMEOUT_MS)
  await assert.rejects(hung, coded('workspace_list_unavailable'))
  // The pick queued behind it runs once the first one gave up; its list hangs too, and it fails alike.
  await settle()
  await timers.advance(HOST_TIMEOUT_MS)
  await assert.rejects(after, coded('workspace_list_unavailable'))
  host.state.listHangs = false
  await ownership.pick(FIX.id)
  await settle()
  assert.equal(ownership.current()?.workspaceId, FIX.id)
  assert.equal(stateOf(ownership), 'watching')
  assert.ok(b2c.commands().includes('code deploy --code-version ws-checkout-fix --activate'))
})

test('a b2c that never exits fails the step with a worded reason, and the queue moves on', async () => {
  const { b2c, ownership, host, timers } = setup()
  b2c.hold.add('code list')
  const hung = ownership.pick(SHOP.id)
  await settle()
  await timers.advance(LIST_TIMEOUT_MS)
  await assert.rejects(hung, coded('b2c_timeout'))
  assert.equal(ownership.current(), null, 'nothing taken over')
  assert.equal(await host.workspaces.upload(), null)
  assert.ok(!b2c.commands().some((c) => c.startsWith('code deploy')))
  b2c.hold.clear()
  await ownership.pick(SHOP.id)
  await settle()
  assert.equal(stateOf(ownership), 'watching')
})

test('release while a pick hangs stops the watcher at once and cancels the pick', async () => {
  const { b2c, ownership, host, storage, timers } = setup()
  await ownership.pick(SHOP.id)
  await settle()
  host.state.listHangs = true
  const hung = ownership.pick(FIX.id)
  await settle()
  const released = ownership.release()
  // At once, before the hanging pick has given up.
  assert.ok(b2c.watchers[0].stopped, 'the watcher stops without waiting on the queue')
  assert.equal(stateOf(ownership), 'none')
  assert.equal(ownership.current(), null)
  await timers.advance(HOST_TIMEOUT_MS)
  await assert.rejects(hung)
  await released
  assert.equal(await storage.source.get('sandbox.owner'), null, 'the stored owner is cleared once its turn comes')
  assert.equal(await host.workspaces.upload(), null)
  assert.ok(!b2c.commands().includes('code deploy --code-version ws-checkout-fix --activate'), 'the cancelled pick deploys nothing')
  assert.equal(alive(b2c).length, 0)
})

test('dispose: a running pick stops at its next wait and a queued one never starts; nothing is deployed', async () => {
  const { b2c, ownership } = setup()
  b2c.hold.add('code list')
  const running = ownership.pick(SHOP.id)
  await settle()
  const queued = ownership.pick(FIX.id)
  ownership.dispose()
  b2c.release()
  await assert.rejects(running, coded('disposed'))
  await assert.rejects(queued, coded('disposed'))
  await settle()
  assert.ok(!b2c.commands().some((c) => c.startsWith('code deploy') || c.startsWith('code activate')), b2c.commands().join(', '))
  assert.equal(b2c.watchers.length, 0)
  await assert.rejects(ownership.redeploy(), coded('disposed'))
})

test('the deploy record is written before the owner, so a crash between them never shows a stale version as deployed', async () => {
  const storage = memoryStorage()
  const writes: string[] = []
  const set = storage.source.set
  storage.source.set = async (key, value) => {
    writes.push(key)
    await set(key, value)
  }
  const { ownership } = setup({ storage })
  await ownership.pick(SHOP.id)
  await settle()
  await ownership.pick(FIX.id)
  await settle()
  writes.length = 0
  await ownership.pick(SHOP.id)
  const deploys = writes.indexOf('sandbox.deploys')
  const owner = writes.indexOf('sandbox.owner')
  assert.ok(deploys !== -1 && owner !== -1 && deploys < owner, writes.join(', '))
})
