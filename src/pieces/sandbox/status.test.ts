// The sandbox's state from `sandbox list`, with the runner faked: the live entry is found by host
// even beside a deleted twin of the same id, a refused list leaves the state unknown, and start
// and stop are fired without waiting on b2c and followed on the list.
import { assert, test } from 'orca/testing'
import type { SandboxAction } from './protocol'
import { findSandbox, FOLLOW_INTERVAL_MS, FOLLOW_TIMEOUT_MS, SandboxWatch, stateOf } from './status'
import { coded, FakeB2c, FakeTimers, SANDBOX_HOST, settle } from './testing'

const ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const live = (state: string) => ({ id: ID, realm: 'zzzz', instance: '003', state, hostName: SANDBOX_HOST, createdAt: '2024-01-02T03:04:05Z' })
/** The stale record `sandbox get` returns for the same id: deleted, without a host. */
const deletedTwin = { id: ID, realm: 'zzzz', instance: '003', state: 'deleted', createdAt: '2024-01-01T00:00:00Z', deletedAt: '2024-01-01T05:00:00Z' }
const other = { id: 'bbbbbbbb-1111-2222-3333-444444444444', state: 'stopped', hostName: 'sandbox-02.example.com', createdAt: '2024-03-01T00:00:00Z' }

/**
 * A watch over a faked runner. With `focus`, the dw.json in force is the one of the folder
 * `focus.root` names (`SHOP_ROOT` names the sandbox, `FIX_ROOT` another one), and b2c reads each
 * call's file as the real runner does.
 */
function watch(b2c = new FakeB2c(), focus?: { root: string | null }) {
  const timers = new FakeTimers()
  const problems: { action: SandboxAction; code: string | null }[] = []
  if (focus) b2c.files = { configRoot: async () => focus.root, hosts: { [SHOP_ROOT]: SANDBOX_HOST, [FIX_ROOT]: other.hostName } }
  const configRoot = focus ? async () => focus.root : undefined
  const sandbox = new SandboxWatch({ b2c, timers, onChange: () => {}, onProblem: (action, code) => void problems.push({ action, code }), configRoot })
  return { b2c, timers, problems, sandbox }
}

const SHOP_ROOT = 'C:/work/shop'
const FIX_ROOT = 'C:/work/checkout-fix'

test('the API states are shown in four words', () => {
  assert.equal(stateOf('started'), 'started')
  assert.equal(stateOf('stopped'), 'stopped')
  for (const busy of ['new', 'creating', 'starting', 'stopping', 'resetting', 'upgrading', 'deleting']) assert.equal(stateOf(busy), 'busy', busy)
  for (const unknown of ['failed', 'unknown', 'deleted', 'something-new', undefined]) assert.equal(stateOf(unknown), 'unknown', String(unknown))
})

test('the live entry is the one with the sandbox’s host, never a deleted twin of the same id', async () => {
  const b2c = new FakeB2c()
  assert.deepEqual(await findSandbox(b2c, { data: [deletedTwin, other, live('started')] }), { id: ID, state: 'started' })
  assert.deepEqual(await findSandbox(b2c, { data: [live('stopped'), { ...deletedTwin, hostName: SANDBOX_HOST.toUpperCase() }] }), { id: ID, state: 'stopped' })
  assert.deepEqual(await findSandbox(b2c, [live('started')]), { id: ID, state: 'started' }, 'a bare list too')
  assert.equal(await findSandbox(b2c, { data: [deletedTwin, other] }), null)
  assert.equal(await findSandbox(b2c, { count: 0 }), null)
  assert.equal(await findSandbox(b2c, null), null)
  // Two live entries with the host: the newest.
  const newer = { ...live('stopped'), id: 'cccccccc-1111-2222-3333-444444444444', createdAt: '2025-05-05T00:00:00Z' }
  assert.deepEqual(await findSandbox(b2c, { data: [live('started'), newer] }), { id: newer.id, state: 'stopped' })
})

test('the state is read from sandbox list, never sandbox get', async () => {
  const { b2c, sandbox } = watch()
  b2c.sandboxList = { data: [deletedTwin, live('started')] }
  await sandbox.refresh()
  assert.deepEqual(b2c.commands(), ['sandbox list'])
  assert.equal(b2c.runs[0].options.role, 'sandbox')
  assert.equal(sandbox.snapshot().state, 'started')
  assert.ok(sandbox.snapshot().checkedAt)
})

test('a refused list leaves the state unknown, with why, and nothing else breaks', async () => {
  const { b2c, sandbox, problems } = watch()
  b2c.sandboxList = { fail: 'b2c_failed' }
  await sandbox.refresh()
  assert.deepEqual(sandbox.snapshot(), { state: 'unknown', following: null, reason: 'b2c_failed', checkedAt: null })
  assert.deepEqual(problems, [{ action: 'status', code: 'b2c_failed' }])
  await assert.rejects(sandbox.fire('start'), coded('sandbox_not_listed'))
  b2c.sandboxList = { data: [other] }
  await sandbox.refresh()
  assert.equal(sandbox.snapshot().reason, 'sandbox_not_listed')
})

test('start is fired with the id the list gave and followed on the list until it is started', async () => {
  const { b2c, timers, sandbox, problems } = watch()
  b2c.sandboxList = { data: [live('stopped')] }
  await sandbox.refresh()
  b2c.hold.add('sandbox start')
  await sandbox.fire('start')
  // Fired, not awaited: the state is followed while b2c has not answered.
  assert.deepEqual(b2c.runs.at(-1)?.args, ['sandbox', 'start', ID])
  assert.deepEqual(sandbox.snapshot().following, 'start')
  assert.equal(sandbox.snapshot().state, 'busy')
  await assert.rejects(sandbox.fire('start'), coded('sandbox_busy'))

  // The list still shows the old state: busy, still followed.
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.equal(sandbox.snapshot().state, 'busy')
  b2c.sandboxList = { data: [live('starting')] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.equal(sandbox.snapshot().state, 'busy')
  b2c.sandboxList = { data: [deletedTwin, live('started')] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.deepEqual(sandbox.snapshot().state, 'started')
  assert.equal(sandbox.snapshot().following, null)
  const lists = b2c.commands().filter((c) => c === 'sandbox list').length
  await timers.advance(FOLLOW_INTERVAL_MS * 4)
  assert.equal(b2c.commands().filter((c) => c === 'sandbox list').length, lists, 'no more polling once settled')
  b2c.release()
  await settle()
  assert.ok(!problems.some((p) => p.code))
})

test('stop is followed the same way; refused when already stopped', async () => {
  const { b2c, timers, sandbox } = watch()
  b2c.sandboxList = { data: [live('started')] }
  await sandbox.refresh()
  await assert.rejects(sandbox.fire('start'), coded('sandbox_already_started'))
  await sandbox.fire('stop')
  assert.deepEqual(b2c.runs.at(-1)?.args, ['sandbox', 'stop', ID])
  b2c.sandboxList = { data: [live('stopping')] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.equal(sandbox.snapshot().following, 'stop')
  b2c.sandboxList = { data: [live('stopped')] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.equal(sandbox.snapshot().state, 'stopped')
  await assert.rejects(sandbox.fire('stop'), coded('sandbox_already_stopped'))
})

test('following ends after the timeout, and when b2c refuses the operation', async () => {
  const { b2c, timers, sandbox, problems } = watch()
  b2c.sandboxList = { data: [live('stopped')] }
  await sandbox.refresh()
  await sandbox.fire('start')
  await timers.advance(FOLLOW_TIMEOUT_MS + FOLLOW_INTERVAL_MS)
  assert.equal(sandbox.snapshot().following, null)
  assert.ok(problems.some((p) => p.action === 'start' && p.code === 'sandbox_follow_timeout'))
  assert.equal(sandbox.snapshot().state, 'stopped')

  b2c.fail.set('sandbox start', 'role_refused')
  await sandbox.fire('start')
  await settle()
  assert.equal(sandbox.snapshot().following, null)
  assert.ok(problems.some((p) => p.action === 'start' && p.code === 'role_refused'))
})

test('a sandbox that turns failed while followed is unknown', async () => {
  const { b2c, timers, sandbox } = watch()
  b2c.sandboxList = { data: [live('stopped')] }
  await sandbox.refresh()
  await sandbox.fire('start')
  b2c.sandboxList = { data: [live('failed')] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.deepEqual(sandbox.snapshot().state, 'unknown')
  assert.equal(sandbox.snapshot().reason, 'sandbox_failed')
  assert.equal(sandbox.snapshot().following, null)
})

test('a start takes the dw.json in force when it is pressed, even when the list was read with another', async () => {
  const focus = { root: SHOP_ROOT as string | null }
  const { b2c, timers, sandbox } = watch(new FakeB2c(), focus)
  b2c.sandboxList = { data: [live('stopped'), other] }
  await sandbox.refresh()
  assert.equal(sandbox.snapshot().state, 'stopped')

  // The focus moves to the fix, whose dw.json names the other sandbox; nothing reads the list.
  focus.root = FIX_ROOT
  await sandbox.fire('start')
  const fired = b2c.runs.find((run) => run.args[1] === 'start')
  assert.deepEqual(fired?.args, ['sandbox', 'start', other.id], 'the id its own dw.json names, read again at the press')
  assert.equal(fired?.root, FIX_ROOT)
  assert.equal(sandbox.snapshot().following, 'start')

  // Then back to Shop: the follow keeps the fix's dw.json and finds its sandbox.
  focus.root = SHOP_ROOT
  b2c.sandboxList = { data: [live('stopped'), { ...other, state: 'starting' }] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.equal(sandbox.snapshot().state, 'busy')
  assert.equal(sandbox.snapshot().reason, null)
  b2c.sandboxList = { data: [live('stopped'), { ...other, state: 'started' }] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.equal(sandbox.snapshot().state, 'started')
  assert.equal(sandbox.snapshot().following, null)
  const reads = b2c.runs.filter((run) => run.args.join(' ') === 'sandbox list')
  assert.ok(reads.slice(1).every((run) => run.root === FIX_ROOT), 'every read of the follow used the fix’s dw.json')

  // Settled: the next read follows the dw.json of the moment again.
  await sandbox.refresh()
  assert.equal(b2c.runs.at(-1)?.root, SHOP_ROOT)
  assert.equal(sandbox.snapshot().state, 'stopped')
})

test('a list already running with another dw.json does not count for a start asked meanwhile', async () => {
  const focus = { root: FIX_ROOT as string | null }
  const { b2c, timers, sandbox } = watch(new FakeB2c(), focus)
  // A list starts with the fix's dw.json (a refresh, or the slow timer) and takes its time.
  b2c.hold.add('sandbox list')
  const slow = sandbox.refresh()
  await settle()
  assert.equal(b2c.held.length, 1)

  // The person focuses Shop and presses Start: its own list, with Shop's dw.json, answers first.
  focus.root = SHOP_ROOT
  const firing = sandbox.fire('start')
  await settle()
  assert.equal(b2c.held.length, 2)
  b2c.held[1].resolve({ data: [live('stopped'), other] })
  await firing
  const fired = b2c.runs.find((run) => run.args[1] === 'start')
  assert.deepEqual(fired?.args, ['sandbox', 'start', ID])
  assert.equal(fired?.root, SHOP_ROOT)

  // The old list arrives, made with the fix's dw.json, where Shop's sandbox is not: it is dropped.
  b2c.held[0].resolve({ data: [other] })
  await slow
  assert.equal(sandbox.snapshot().following, 'start')
  assert.equal(sandbox.snapshot().state, 'busy')
  assert.equal(sandbox.snapshot().reason, null)

  b2c.hold.clear()
  b2c.sandboxList = { data: [live('started'), other] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.equal(sandbox.snapshot().state, 'started')
  assert.equal(sandbox.snapshot().following, null)
  assert.equal(b2c.runs.at(-1)?.root, SHOP_ROOT)
})

test('a follow matches its sandbox by the id it fired, whatever else the list holds', async () => {
  const { b2c, timers, sandbox } = watch()
  b2c.sandboxList = { data: [live('stopped')] }
  await sandbox.refresh()
  await sandbox.fire('start')
  // A newer entry with the same host and another id is not the one being started.
  const newer = { ...live('stopped'), id: 'cccccccc-1111-2222-3333-444444444444', createdAt: '2025-01-01T00:00:00Z' }
  b2c.sandboxList = { data: [newer, live('started')] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.equal(sandbox.snapshot().state, 'started')
  assert.equal(sandbox.snapshot().following, null)
})
