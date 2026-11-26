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

function watch(b2c = new FakeB2c()) {
  const timers = new FakeTimers()
  const problems: { action: SandboxAction; code: string | null }[] = []
  /** How many holds on dw.json are taken and not released. */
  const holds = { taken: 0, held: 0 }
  const hold = async () => {
    holds.taken++
    holds.held++
    let released = false
    return () => {
      if (!released) holds.held--
      released = true
    }
  }
  const sandbox = new SandboxWatch({ b2c, timers, onChange: () => {}, onProblem: (action, code) => void problems.push({ action, code }), hold })
  return { b2c, timers, problems, sandbox, holds }
}

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

test('dw.json is held from the fire until following ends, whichever way it ends', async () => {
  const { b2c, timers, sandbox, holds } = watch()
  b2c.sandboxList = { data: [live('stopped')] }
  await sandbox.refresh()
  assert.equal(holds.taken, 0, 'a read alone holds nothing')

  // Settled on the list.
  await sandbox.fire('start')
  assert.equal(holds.held, 1)
  b2c.sandboxList = { data: [live('started')] }
  await timers.advance(FOLLOW_INTERVAL_MS)
  assert.equal(holds.held, 0)

  // Refused by b2c.
  b2c.fail.set('sandbox stop', 'role_refused')
  await sandbox.fire('stop')
  await settle()
  assert.equal(holds.held, 0)
  b2c.fail.clear()

  // Gone from the list, failed, timed out, or the worker stopped.
  for (const end of ['gone', 'failed', 'timeout', 'dispose'] as const) {
    b2c.sandboxList = { data: [live('started')] }
    await sandbox.refresh()
    await sandbox.fire('stop')
    assert.equal(holds.held, 1, end)
    if (end === 'gone') b2c.sandboxList = { data: [other] }
    if (end === 'failed') b2c.sandboxList = { data: [live('failed')] }
    if (end === 'dispose') sandbox.dispose()
    else await timers.advance(end === 'timeout' ? FOLLOW_TIMEOUT_MS + FOLLOW_INTERVAL_MS : FOLLOW_INTERVAL_MS)
    assert.equal(holds.held, 0, end)
    assert.equal(sandbox.snapshot().following, null, end)
  }
  assert.equal(holds.taken, 6)
})
