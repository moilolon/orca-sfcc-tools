// The errors piece's worker over a mock host, a fake b2c and an invented dw.json: what a read asks
// b2c, what it keeps, what it tells the person, and the sandbox's timer.
import { assert, mockHost, mountWorker, test, type MockHost, type TestWorker } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createB2c, type B2c } from '../../core/b2c'
import type { Role } from '../../core/instances'
import type { OpenFileRequest } from '../../core/open-file'
import { translator } from '../../core/i18n'
import type { PieceContext } from '../../core/piece'
import { createSettings } from '../../core/settings'
import { createStore } from '../../core/store'
import { assertNoSecrets, fakeSpawner, INVENTED_DW, makeWorkspace, type SpawnCall } from '../../core/test-support'
import { createWorkspaces } from '../../core/workspaces'
import { createActivate, deactivate } from '../../worker/worker'
import { cartError, LOGS_GET, paymentError } from './fixtures/logs'
import type { RoleErrors } from './protocol'
import { createErrorsPiece, FIRST_READ_MS, FULL_WINDOW_BYTES, intervalOf, MAX_ENTRIES, OVERLAP_MS, readArguments, RESUME_MS, START_DELAY_MS, STATUS_ITEM, type ErrorsDeps } from './worker'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const MACHINE = {
  platform: 'linux',
  env: { PATH: '/fake/bin' },
  homedir: '/home/someone',
  isFile: async (path: string) => path === '/fake/bin/b2c',
  isDirectory: async () => true
}
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)

function hostFor(root: string, settings: Record<string, string | number> = {}, storage: Record<string, never> = {}) {
  return mockHost({
    capabilities: CAPABILITIES,
    settings,
    storage,
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: root, branch: null, hostId: 'local' }], truncated: false },
      'workspace.readContext': { workspaceId: 'w1', branch: '', displayName: 'shop', terminals: [] }
    }
  })
}

/**
 * b2c answering `logs get` with `answer` (the invented fixtures by default), `logs list` with
 * `files` (none by default) and its version.
 */
function b2cAnswering(answer: () => unknown = () => LOGS_GET, files: () => unknown = () => ({ count: 0, files: [] })) {
  return (call: SpawnCall) => {
    if (call.args[0] === '--version') call.child.finish(0, '@salesforce/b2c-cli/9.8.7 linux-x64 node-v24.0.0\n')
    else if (call.args[0] === 'logs' && call.args[1] === 'list') call.child.finish(0, JSON.stringify(files()))
    else if (call.args[0] === 'logs') call.child.finish(0, JSON.stringify(answer()))
    else call.child.finish(1, '', 'ERROR: unexpected\n')
  }
}

/** The whole worker, as Orca starts it, over `host`. */
async function mountPlugin(host: MockHost, script: (call: SpawnCall) => void = b2cAnswering()) {
  const spawn = fakeSpawner(script)
  const worker = await mountWorker({ default: createActivate({ ...MACHINE, spawn: spawn.spawn, killTree: (child) => child.kill() }), deactivate }, { host })
  return { worker, calls: spawn.calls }
}

/** The errors piece alone, with its clock and timers in the test's hands. */
async function mountPiece(host: MockHost, script: (call: SpawnCall) => void, deps: ErrorsDeps = {}, wrap: (b2c: B2c) => B2c = (b2c) => b2c) {
  const spawn = fakeSpawner(script)
  const timers: { run: () => void; ms: number; cleared: boolean; fired: boolean }[] = []
  const piece = createErrorsPiece({
    now: () => NOW,
    setTimer: (run, ms) => {
      const timer = {
        run: () => {
          timer.fired = true
          run()
        },
        ms,
        cleared: false,
        fired: false
      }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
    ...deps
  })
  let disposable: { dispose(): void } | void = undefined
  let api: OrcaWorkerApi | null = null
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        api = orca
        const settings = createSettings(orca.settings)
        const workspaces = createWorkspaces(orca.host, createStore(orca.storage, 'core'))
        const b2c = createB2c({ ...MACHINE, spawn: spawn.spawn, killTree: (child) => child.kill(), settings, configRoot: () => workspaces.configRoot() })
        const ctx: PieceContext = { orca, b2c: wrap(b2c), settings, store: createStore(orca.storage, 'errors'), workspaces, t: translator(() => 'en'), log: (message) => orca.log(message) }
        disposable = await piece.activate(ctx)
      },
      deactivate: () => disposable?.dispose()
    },
    { host }
  )
  const logsCalls = () => spawn.calls.filter((call) => call.args[0] === 'logs' && call.args[1] === 'get')
  const listCalls = () => spawn.calls.filter((call) => call.args[0] === 'logs' && call.args[1] === 'list')
  const orca = (): OrcaWorkerApi => {
    if (!api) throw new Error('the worker did not start')
    return api
  }
  return { worker, orca, calls: spawn.calls, logsCalls, listCalls, timers, live: () => timers.filter((timer) => !timer.cleared && !timer.fired) }
}

/** The params of every call of `method` that reached the host. */
function paramsOf(host: MockHost, method: string): unknown[] {
  return host.calls.filter((call) => call.method === method).map((call) => call.params)
}

/** Lets the worker run until nothing is left to do but wait: a timer, a process, a request. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** The role's list once no read of it is running. */
async function readEnded(worker: TestWorker, role: Role): Promise<RoleErrors> {
  for (let i = 0; i < 5_000; i++) {
    const list = await worker.request('errors.list', { role })
    if (!list.reading) return list
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`the ${role} read never ended`)
}

/** What *Read now* does: starts a read, which answers at once, then waits for it to end. */
async function readNow(worker: TestWorker, { role }: { role: Role }): Promise<RoleErrors> {
  await worker.request('errors.refresh', { role })
  return readEnded(worker, role)
}

/** Lets the worker run until `done` holds; fails after a while. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000 && !done(); i++) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(done(), what)
  await settle()
}

function newCount(list: RoleErrors): number {
  return list.rows.filter((row) => row.markedAt === null).length
}

test('a read asks b2c for error-level entries since the last read, bounded, and keeps one row per signature', async () => {
  const root = makeWorkspace()
  try {
    const { worker, logsCalls } = await mountPiece(hostFor(root), b2cAnswering())
    const list = await readNow(worker, { role: 'sandbox' })
    const [first] = logsCalls()
    assert.deepEqual(first.args, [
      'logs',
      'get',
      '--no-normalize',
      '--filter=error',
      '--filter=customerror',
      '--level=ERROR',
      '--level=FATAL',
      `--count=${MAX_ENTRIES}`,
      `--since=${new Date(NOW - FIRST_READ_MS).toISOString()}`,
      '--json'
    ])
    // Seven entries: the cart error twice, the payment error twice, a job error, two near misses.
    assert.equal(list.rows.length, 5)
    assert.deepEqual(list.rows.map((row) => row.count).sort(), [1, 1, 1, 2, 2])
    assert.equal(newCount(list), 5)
    assert.equal(list.lastRead, NOW)
    assert.equal(list.error, null)
    assert.equal(list.state, 'ready')

    // The next read starts a few minutes before the newest entry read, and counts nothing twice.
    const again = await readNow(worker, { role: 'sandbox' })
    const newest = Math.max(...LOGS_GET.entries.map((entry) => Date.parse(entry.timestamp.replace(' GMT', 'Z').replace(' ', 'T'))))
    assert.ok(logsCalls()[1].args.includes(`--since=${new Date(newest - OVERLAP_MS).toISOString()}`))
    assert.equal(again.missedSince, null)
    assert.deepEqual(again.rows.map((row) => row.count), list.rows.map((row) => row.count))
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a new error appears once however many times it repeats, and stays seen once marked', async () => {
  const root = makeWorkspace()
  try {
    let batch = 0
    const at = (minute: number) => `2026-11-26 11:${String(minute).padStart(2, '0')}:00.000 GMT`
    const { worker } = await mountPiece(
      hostFor(root),
      b2cAnswering(() => {
        batch++
        return { entries: Array.from({ length: 4 }, (_, i) => cartError({ at: at(batch * 10 + i), pid: String(1000 + batch * 10 + i) })) }
      })
    )
    let list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.rows.length, 1)
    assert.equal(list.rows[0].count, 4)
    assert.equal(newCount(list), 1)
    list = await worker.request('errors.mark', { role: 'sandbox', signatures: [list.rows[0].signature] })
    assert.equal(newCount(list), 0)
    list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.rows.length, 1)
    assert.equal(list.rows[0].count, 8)
    assert.equal(newCount(list), 0, 'it repeated, and stays seen')
    list = await worker.request('errors.forget', { role: 'sandbox', signature: list.rows[0].signature })
    assert.equal(list.rows.length, 0)
    list = await readNow(worker, { role: 'sandbox' })
    assert.equal(newCount(list), 1, 'forgotten, it comes back as new')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('marking persists across a worker restart', async () => {
  const root = makeWorkspace()
  try {
    const host = hostFor(root)
    const first = await mountPlugin(host)
    const list = await readNow(first.worker, { role: 'sandbox' })
    const marked = list.rows[0].signature
    await first.worker.request('errors.mark', { role: 'sandbox', signatures: [marked] })
    await first.worker.deactivate()

    // A new worker over the same storage: Orca restarted it.
    const second = await mountPlugin(host)
    const after = await second.worker.request('errors.list', { role: 'sandbox' })
    assert.equal(after.rows.length, list.rows.length)
    assert.notEqual(after.rows.find((row) => row.signature === marked)?.markedAt, null)
    assert.equal(newCount(after), list.rows.length - 1)
    await second.worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the lists of two environments are independent', async () => {
  const root = makeWorkspace()
  try {
    const { worker } = await mountPiece(hostFor(root), b2cAnswering())
    const sandbox = await readNow(worker, { role: 'sandbox' })
    const development = await readNow(worker, { role: 'development' })
    assert.equal(development.rows.length, sandbox.rows.length)
    await worker.request('errors.mark', { role: 'sandbox', signatures: sandbox.rows.map((row) => row.signature) })
    assert.equal(newCount(await worker.request('errors.list', { role: 'sandbox' })), 0)
    assert.equal(newCount(await worker.request('errors.list', { role: 'development' })), development.rows.length)
    assert.equal((await worker.request('errors.list', { role: 'staging' })).rows.length, 0)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a role that is not ready is not read, and says so', async () => {
  const root = makeWorkspace()
  try {
    const { worker, logsCalls } = await mountPiece(hostFor(root), b2cAnswering())
    // Staging has no secret, production no host.
    for (const role of ['staging', 'production'] as const) {
      const list = await readNow(worker, { role })
      assert.notEqual(list.state, 'ready', role)
      assert.equal(list.rows.length, 0)
      assert.equal(list.lastRead, null)
    }
    assert.equal(logsCalls().length, 0)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a read that fails keeps its code, and the rows read before', async () => {
  const root = makeWorkspace()
  try {
    let fail = false
    const { worker } = await mountPiece(hostFor(root), (call) => {
      if (call.args[0] === 'logs' && fail) call.child.finish(126, '', `ERROR: Cannot read logs from ${INVENTED_DW.hostname}\n`)
      else b2cAnswering()(call)
    })
    const before = await readNow(worker, { role: 'sandbox' })
    fail = true
    const after = await readNow(worker, { role: 'sandbox' })
    assert.equal(after.error, 'b2c_failed')
    assert.equal(after.lastRead, before.lastRead)
    assert.equal(after.rows.length, before.rows.length)
    assertNoSecrets(JSON.stringify(after), 'the list')
    assertNoSecrets(worker.logs.join('\n'), 'the log')
    fail = false
    assert.equal((await readNow(worker, { role: 'sandbox' })).error, null, 'a good read clears it')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two reads in a row both complete and both move the time of the last read, a mark between them', async () => {
  const root = makeWorkspace()
  try {
    let clock = NOW
    const { worker, logsCalls } = await mountPiece(hostFor(root), b2cAnswering(), { now: () => clock })
    const first = await readNow(worker, { role: 'sandbox' })
    assert.equal(first.lastRead, NOW)
    await worker.request('errors.mark', { role: 'sandbox', signatures: [first.rows[0].signature] })
    clock += 60_000
    const second = await readNow(worker, { role: 'sandbox' })
    assert.equal(logsCalls().length, 2, 'the second read ran')
    assert.equal(second.lastRead, NOW + 60_000)
    clock += 60_000
    const third = await readNow(worker, { role: 'sandbox' })
    assert.equal(logsCalls().length, 3, 'the third read ran')
    assert.equal(third.lastRead, NOW + 120_000)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a read that cannot run with the dw.json read now says why at once, and leaves the last read and no mark behind', async () => {
  const root = makeWorkspace()
  try {
    let clock = NOW
    // The focus moves to a workspace with no dw.json: the runner reads none.
    let focusHasNoFile = false
    const { worker, logsCalls, orca } = await mountPiece(hostFor(root), b2cAnswering(), { now: () => clock }, (b2c) => ({
      ...b2c,
      instances: async (options) => (focusHasNoFile ? { config: 'missing', instances: { sandbox: 'absent', development: 'absent', staging: 'absent', production: 'absent' } } : b2c.instances(options))
    }))
    const first = await readNow(worker, { role: 'sandbox' })
    assert.equal(first.lastRead, NOW)

    focusHasNoFile = true
    clock += 60_000
    const refused = await worker.request('errors.refresh', { role: 'sandbox' })
    assert.equal(refused.reading, false, 'answered at once, with nothing running')
    assert.equal(refused.error, 'role_not_configured')
    assert.equal(refused.lastRead, NOW, 'the time of the last read is not touched')
    assert.notEqual(refused.state, 'ready')
    await settle()
    assert.equal(logsCalls().length, 1, 'nothing was read')
    assert.equal(await orca().storage.get('errors.asked.sandbox'), null, 'nothing is left marked as asked')
    assert.equal((await worker.request('errors.list', { role: 'sandbox' })).error, 'role_not_configured')

    // Back on the workspace: the next read runs, and clears why.
    focusHasNoFile = false
    clock += 60_000
    const again = await readNow(worker, { role: 'sandbox' })
    assert.equal(again.error, null)
    assert.equal(again.lastRead, NOW + 120_000)
    assert.equal(logsCalls().length, 2)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every answer is numbered: the one Read now gives while reading is older than the one after the read', async () => {
  const root = makeWorkspace()
  try {
    const pending: SpawnCall[] = []
    const { worker } = await mountPiece(hostFor(root), (call) => {
      if (call.args[0] === 'logs' && call.args[1] === 'get') pending.push(call)
      else b2cAnswering()(call)
    })
    const before = await worker.request('errors.list', { role: 'sandbox' })
    const started = await worker.request('errors.refresh', { role: 'sandbox' })
    await until(() => pending.length === 1, 'the read started')
    pending.shift()?.child.finish(0, JSON.stringify(LOGS_GET))
    const ended = await readEnded(worker, 'sandbox')
    assert.ok(before.version && started.version && ended.version)
    assert.equal(started.version.worker, ended.version.worker)
    assert.ok(before.version.seq < started.version.seq, 'the read starting is a change')
    assert.ok(started.version.seq < ended.version.seq, 'and so is its end')
    const marked = await worker.request('errors.mark', { role: 'sandbox', signatures: [ended.rows[0].signature] })
    assert.ok(marked.version && marked.version.seq > ended.version.seq, 'a mark too')
    // Each role counts on its own.
    const other = await worker.request('errors.list', { role: 'development' })
    assert.equal(other.version?.seq, 0)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a read a worker restart cut short runs again when the worker starts, and only within its window', async () => {
  const root = makeWorkspace()
  try {
    const host = hostFor(root)
    let clock = NOW
    const pending: SpawnCall[] = []
    const holding = (call: SpawnCall) => {
      if (call.args[0] === 'logs' && call.args[1] === 'get') pending.push(call)
      else b2cAnswering()(call)
    }
    /** Starts a read that never ends, then stops the worker as Orca restarts it. */
    async function cutShort(role: Role): Promise<void> {
      const doomed = await mountPiece(host, holding, { now: () => clock })
      assert.equal((await doomed.worker.request('errors.refresh', { role })).reading, true)
      await until(() => pending.length === 1, `the ${role} read started`)
      await doomed.worker.deactivate()
      // The old process goes away; its read ends, unfinished.
      pending.shift()?.child.finish(1, '', 'ERROR: stopped\n')
      await settle()
    }

    await cutShort('sandbox')
    clock += 60_000
    const second = await mountPiece(host, b2cAnswering(), { now: () => clock })
    await settle()
    assert.equal(second.logsCalls().length, 0, 'not while the worker starts')
    assert.deepEqual(second.live().map((timer) => timer.ms), [START_DELAY_MS], 'a read is scheduled shortly after the start')
    for (const timer of second.live()) timer.run()
    const list = await readEnded(second.worker, 'sandbox')
    assert.equal(second.logsCalls().length, 1, 'the cut read ran again')
    assert.equal(list.lastRead, clock)
    assert.equal(list.error, null)
    assert.equal(list.rows.length, 5)
    await second.worker.deactivate()

    // A read that ended is not run again.
    const third = await mountPiece(host, b2cAnswering(), { now: () => clock })
    await settle()
    assert.equal(third.live().length, 0)
    await third.worker.deactivate()

    // One asked too long ago neither.
    await cutShort('development')
    clock += RESUME_MS
    const late = await mountPiece(host, b2cAnswering(), { now: () => clock })
    await settle()
    assert.equal(late.live().length, 0, 'too old to run again')
    assert.equal(late.logsCalls().length, 0)
    await late.worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('what is stored is the counters and a masked, bounded sample: never a raw entry', async () => {
  const root = makeWorkspace()
  try {
    const secretEntry = paymentError('2026-11-26 11:00:00.000 GMT', '00012345', 'jane.doe@example.com', '59.90')
    secretEntry.message = secretEntry.message.replace('Payment authorization failed', `Payment authorization failed at ${INVENTED_DW.hostname} for ${INVENTED_DW['client-id']}`) + 'x'.repeat(5000)
    secretEntry.raw = `[${secretEntry.timestamp}] ERROR ${secretEntry.message}`
    const { worker } = await mountPiece(hostFor(root), b2cAnswering(() => ({ entries: [...LOGS_GET.entries, secretEntry] })))
    await readNow(worker, { role: 'sandbox' })
    const storage = worker.host.data().storage
    const stored = JSON.stringify(storage)
    assertNoSecrets(stored, 'storage')
    assert.ok(stored.includes('Payment authorization failed at *** for ***'), 'the host and the client id are masked')
    for (const entry of LOGS_GET.entries) {
      assert.ok(!stored.includes(entry.raw.slice(0, 80)), 'no raw entry')
      assert.ok(!stored.includes(entry.message.split('\n')[0]), 'no first line as written')
    }
    // No host of any kind: the storefront's is not in dw.json, so only the URL rule keeps it out.
    for (const volatile of ['www.example.com', 'example.org', 'https:', 'en_US', 'jane.doe@example.com', 'k3Jd8sLq0aZx2Vb7Nn4Mc1Pq', '3f6c2a9e-1b7d-4c5e-9a0f-2d8e6b4c1a37', 'Sites-Example-Site', 'pid=100234', 'System Information']) {
      assert.ok(!stored.includes(volatile), volatile)
    }
    const keys = Object.keys(storage).filter((key) => key.startsWith('errors.'))
    assert.deepEqual(keys.sort(), ['errors.cursor.sandbox', 'errors.seen.sandbox', 'errors.status.sandbox'])
    for (const record of Object.values(storage['errors.seen.sandbox'] as Record<string, { sample: { message: string } }>)) {
      assert.ok(record.sample.message.length <= 300)
      assert.deepEqual(Object.keys(record).sort(), ['count', 'firstSeen', 'lastSeen', 'sample'])
    }
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the sample is masked before it is normalised and again after', async () => {
  const root = makeWorkspace()
  try {
    const masked: string[] = []
    const { worker } = await mountPiece(hostFor(root), b2cAnswering(() => ({ entries: [cartError({ at: '2026-11-26 11:00:00.000 GMT' })] })), {}, (b2c) => ({
      ...b2c,
      mask: async (text) => {
        masked.push(text)
        return b2c.mask(text)
      }
    }))
    const list = await readNow(worker, { role: 'sandbox' })
    assert.equal(masked.length, 2)
    assert.match(masked[0], /https:\/\/www\.example\.com/, 'first the text as written')
    assert.ok(masked[1].includes(list.rows[0].message), 'then the normalised sample, as stored')
    assert.ok(!masked[1].includes('www.example.com'))
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a read that finds new signatures notifies how many, never what', async () => {
  const root = makeWorkspace()
  try {
    const { worker } = await mountPiece(hostFor(root), b2cAnswering())
    await readNow(worker, { role: 'sandbox' })
    const notifications = paramsOf(worker.host, 'notifications.show')
    assert.equal(notifications.length, 1)
    assert.deepEqual(notifications[0], { title: 'New errors on Sandbox', body: '5 new errors in the log. Open the Errors view of the SFCC panel to see them.' })
    const said = JSON.stringify(notifications)
    for (const piece of ['Cannot read', 'cartHelper', 'Payment', 'custom.', 'system.', 'example', 'TypeError', '<q>']) assert.ok(!said.includes(piece), piece)

    // Nothing new: no notification.
    await readNow(worker, { role: 'sandbox' })
    assert.equal(paramsOf(worker.host, 'notifications.show').length, 1)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the status bar counts the sandbox’s new errors, hidden at zero', async () => {
  const root = makeWorkspace()
  try {
    const { worker } = await mountPiece(hostFor(root), b2cAnswering())
    await settle()
    const updates = () => paramsOf(worker.host, 'statusBar.update') as { id: string; text: string; visible: boolean }[]
    assert.deepEqual(updates().at(-1), { id: STATUS_ITEM, text: '0', tooltip: 'New errors on the sandbox: 0', visible: false })
    const list = await readNow(worker, { role: 'sandbox' })
    assert.deepEqual(updates().at(-1), { id: STATUS_ITEM, text: '5', tooltip: 'New errors on the sandbox: 5', visible: true })
    const before = updates().length
    await readNow(worker, { role: 'development' })
    assert.equal(updates().length, before, 'another environment leaves it alone')
    await worker.request('errors.mark', { role: 'sandbox', signatures: list.rows.map((row) => row.signature) })
    assert.equal(updates().at(-1)?.visible, false)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('each change is posted to the panel with the environment and its new count', async () => {
  const root = makeWorkspace()
  try {
    const { worker } = await mountPiece(hostFor(root), b2cAnswering())
    await readNow(worker, { role: 'development' })
    const posts = worker.posts.filter((post) => post.event === 'errors.changed')
    assert.deepEqual(posts.at(-1)?.payload, { role: 'development', newCount: 5 })
    assertNoSecrets(JSON.stringify(worker.posts), 'the posts')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Read now answers at once while a slow read goes on, and the end of the read is posted', async () => {
  const root = makeWorkspace()
  try {
    const pending: SpawnCall[] = []
    const { worker, logsCalls } = await mountPiece(hostFor(root), (call) => {
      if (call.args[0] === 'logs' && call.args[1] === 'get') pending.push(call)
      else b2cAnswering()(call)
    })
    // b2c has not answered: the request does not wait for it, so it cannot time out.
    const started = await worker.request('errors.refresh', { role: 'sandbox' })
    assert.equal(started.reading, true)
    assert.equal(started.rows.length, 0)
    await until(() => logsCalls().length === 1, 'the read started')
    assert.deepEqual(worker.posts.filter((post) => post.event === 'errors.changed').at(-1)?.payload, { role: 'sandbox', newCount: 0 })

    // Asked again meanwhile: the same read, not a second one.
    const again = await worker.request('errors.refresh', { role: 'sandbox' })
    assert.equal(again.reading, true)
    await settle()
    assert.equal(logsCalls().length, 1)

    // Another environment reads alongside, on its own.
    await worker.request('errors.refresh', { role: 'development' })
    await until(() => logsCalls().length === 2, 'development reads too')

    pending.shift()?.child.finish(0, JSON.stringify(LOGS_GET))
    const done = await readEnded(worker, 'sandbox')
    assert.equal(done.rows.length, 5)
    assert.deepEqual(worker.posts.filter((post) => post.event === 'errors.changed').at(-1)?.payload, { role: 'sandbox', newCount: 5 })
    pending.shift()?.child.finish(0, JSON.stringify({ entries: [] }))
    await readEnded(worker, 'development')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the timer is off at 0: nothing is scheduled and nothing is read', async () => {
  const root = makeWorkspace()
  try {
    for (const interval of [0, '0', '', -5, 'soon']) {
      const { worker, timers, logsCalls } = await mountPiece(hostFor(root, { errorsInterval: interval as number }), b2cAnswering())
      await settle()
      assert.equal(timers.length, 0, String(interval))
      assert.equal(logsCalls().length, 0)
      await worker.deactivate()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the timer reads the sandbox every interval and never overlaps two reads', async () => {
  const root = makeWorkspace()
  try {
    const pending: SpawnCall[] = []
    const { worker, live, logsCalls } = await mountPiece(hostFor(root, { errorsInterval: 5 }), (call) => {
      if (call.args[0] === 'logs' && call.args[1] === 'get') pending.push(call)
      else b2cAnswering()(call)
    })
    await settle()
    assert.equal(live().length, 1)
    assert.equal(live()[0].ms, START_DELAY_MS)
    live()[0].run()
    await until(() => logsCalls().length === 1, 'the first tick reads')
    // Only the sandbox: its host in the child's environment, and its sign-in methods.
    assert.equal(logsCalls()[0].options.env.SFCC_SERVER, INVENTED_DW.hostname)
    assert.equal(logsCalls()[0].args.includes('--filter=error'), true)
    assert.equal(live().length, 0, 'no next tick while the read runs')

    // A person asks meanwhile: the request joins the running read.
    const asked = await worker.request('errors.refresh', { role: 'sandbox' })
    assert.equal(asked.reading, true)
    await settle()
    assert.equal(logsCalls().length, 1)
    pending.shift()?.child.finish(0, JSON.stringify(LOGS_GET))
    const list = await readEnded(worker, 'sandbox')
    assert.equal(list.rows.length, 5)
    await until(() => live().length === 1, 'the next tick is scheduled once the read ended')
    assert.equal(live()[0].ms, 5 * 60_000)

    live()[0].run()
    await until(() => logsCalls().length === 2, 'the second tick reads')
    assert.deepEqual(logsCalls().map((call) => call.options.env.SFCC_SERVER), [INVENTED_DW.hostname, INVENTED_DW.hostname])
    pending.shift()?.child.finish(0, JSON.stringify({ entries: [] }))
    await until(() => live().length === 1, 'and schedules the third')
    await worker.deactivate()
    assert.equal(live().length, 0, 'disposing clears the timer')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the timer follows its setting', async () => {
  const root = makeWorkspace()
  try {
    const { worker, live, orca } = await mountPiece(hostFor(root, { errorsInterval: 0 }), b2cAnswering())
    await settle()
    assert.equal(live().length, 0)
    await orca().settings.set('errorsInterval', 10)
    await until(() => live().length === 1, 'a timer once the interval is set')
    assert.deepEqual(live().map((timer) => timer.ms), [10 * 60_000])
    await orca().settings.set('errorsInterval', 0)
    await until(() => live().length === 0, 'set back to 0, the timer stops')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a frame opens its file when its script is in a cartridge of the workspace', async () => {
  const root = makeWorkspace()
  try {
    const script = join(root, 'cartridges', 'app_example', 'cartridge', 'scripts', 'helpers')
    mkdirSync(script, { recursive: true })
    writeFileSync(join(root, 'cartridges', 'app_example', '.project'), '<projectDescription/>')
    writeFileSync(join(script, 'cartHelper.js'), '// invented\n')
    const opened: OpenFileRequest[] = []
    const { worker } = await mountPiece(hostFor(root), b2cAnswering(), {
      openFile: async (request) => {
        opened.push(request)
        return { opened: true }
      }
    })
    const list = await readNow(worker, { role: 'sandbox' })
    const cart = list.rows.find((row) => row.frames[0]?.file === 'app_example/cartridge/scripts/helpers/cartHelper.js')
    assert.ok(cart)
    // Two frames are in the workspace; the controller is not, nor are Java frames.
    assert.deepEqual(cart.frames.map((frame) => frame.openable), [true, true, false])
    const job = list.rows.find((row) => row.logger === 'system.job')
    assert.ok(job?.frames.every((frame) => !frame.openable))

    assert.deepEqual(await worker.request('errors.open', { role: 'sandbox', signature: cart.signature, frame: 0 }), { opened: true })
    assert.deepEqual(opened, [{ root, path: join(script, 'cartHelper.js'), line: cart.frames[0].line ?? undefined, focus: true }])
    assert.deepEqual(await worker.request('errors.open', { role: 'sandbox', signature: cart.signature, frame: 2 }), { opened: false, reason: 'not_in_workspace' })
    assert.deepEqual(await worker.request('errors.open', { role: 'sandbox', signature: cart.signature, frame: 9 }), { opened: false, reason: 'not_found' })
    assert.deepEqual(await worker.request('errors.open', { role: 'sandbox', signature: 'nope', frame: 0 }), { opened: false, reason: 'not_found' })
    assert.equal(opened.length, 1)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('requests refuse an environment or a payload they do not know', async () => {
  const root = makeWorkspace()
  try {
    const { worker } = await mountPiece(hostFor(root), b2cAnswering())
    const bad: [string, unknown][] = [
      ['errors.list', { role: 'sandbox-01.example.com' }],
      ['errors.list', {}],
      ['errors.refresh', { role: 'none' }],
      ['errors.mark', { role: 'sandbox', signatures: 'a' }],
      ['errors.mark', { role: 'sandbox', signatures: [1] }],
      ['errors.forget', { role: 'sandbox' }],
      ['errors.open', { role: 'sandbox', signature: 'a', frame: -1 }]
    ]
    for (const [name, input] of bad) {
      let code: unknown = null
      await worker.request(name as 'errors.list', input as { role: 'sandbox' }).catch((error: { code?: unknown }) => void (code = error.code))
      assert.equal(code, 'invalid_params', name)
    }
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('entries of any other level than ERROR and FATAL are never read as errors', async () => {
  const root = makeWorkspace()
  try {
    const at = '2026-11-26 11:00:00.000 GMT'
    const warning = { ...paymentError(at, '1', 'a@example.com', '1'), level: 'WARN', file: 'custom-payment-blade0.log' }
    const info = { ...paymentError(at, '2', 'b@example.com', '2'), level: 'INFO', file: 'custom-payment-blade0.log' }
    const { worker, logsCalls } = await mountPiece(hostFor(root, { errorsFilter: 'custom-' }), b2cAnswering(() => ({ entries: [warning, info] })))
    const list = await readNow(worker, { role: 'sandbox' })
    assert.ok(logsCalls()[0].args.includes('--filter=custom-') && logsCalls()[0].args.includes('--level=ERROR') && logsCalls()[0].args.includes('--level=FATAL'))
    assert.equal(list.rows.length, 0)
    assert.equal(JSON.stringify(worker.host.data().storage).includes('Payment'), false, 'nothing of them is stored')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a read that may have skipped entries says so in the view, and never notifies it', async () => {
  const root = makeWorkspace()
  try {
    const at = (i: number) => `2026-11-26 11:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000 GMT`
    let answer: () => unknown = () => ({ entries: Array.from({ length: MAX_ENTRIES }, (_, i) => cartError({ at: at(i) })) })
    const { worker } = await mountPiece(hostFor(root), b2cAnswering(() => answer()))
    // As many entries as b2c keeps.
    let list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.missedSince, NOW - FIRST_READ_MS, 'since the start of the read')
    assert.equal(list.rows.length, 1)
    const notifications = paramsOf(worker.host, 'notifications.show')
    assert.deepEqual(notifications, [{ title: 'New errors on Sandbox', body: '1 new error in the log. Open the Errors view of the SFCC panel to see it.' }])

    // A read that got everything clears it.
    answer = () => ({ entries: [] })
    list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.missedSince, null)

    // Nearly a whole 64 KB window of one file, in few entries: since the newest entry read before.
    const before = Date.UTC(2026, 10, 26, 11, 3, 19)
    const big = (i: number) => {
      const entry = paymentError(`2026-11-26 11:50:${String(i).padStart(2, '0')}.000 GMT`, String(i), 'c@example.com', '1')
      return { ...entry, raw: entry.raw + ' '.repeat(Math.ceil(FULL_WINDOW_BYTES / 10)) }
    }
    answer = () => ({ entries: Array.from({ length: 10 }, (_, i) => big(i)) })
    list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.missedSince, before)
    assert.equal(paramsOf(worker.host, 'notifications.show').length, 2, 'one more for the new payment error, none for the gap')
    assert.ok(!JSON.stringify(paramsOf(worker.host, 'notifications.show')).match(/miss/i))
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file that grew past its 64 KB window is flagged, even when warnings filled it', async () => {
  const root = makeWorkspace()
  try {
    const file = 'error-blade0-1-appserver-20261126.log'
    // One small ERROR entry is all b2c returns: warnings fill the rest of the file's window.
    const oneError = (at: string) => ({ entries: [{ ...paymentError(at, '1', 'e@example.com', '1'), file }] })
    let answer = oneError('2026-11-26 11:00:00.000 GMT')
    let listed = { count: 1, files: [{ name: file, prefix: 'error', size: 20_000, lastModified: '2026-11-26T11:00:00.000Z', path: `logs/${file}` }] }
    const { worker, listCalls } = await mountPiece(hostFor(root), b2cAnswering(() => answer, () => listed))
    let list = await readNow(worker, { role: 'sandbox' })
    assert.deepEqual(listCalls()[0].args, ['logs', 'list', '--filter=error', '--filter=customerror', '--json'])
    assert.equal(list.missedSince, null, 'a small file, read whole')

    // 200 KB of warnings since: the error entries are tiny, the file grew past its window.
    answer = oneError('2026-11-26 11:30:00.000 GMT')
    listed = { ...listed, files: [{ ...listed.files[0], size: 220_000 }] }
    list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.missedSince, Date.UTC(2026, 10, 26, 11), 'since the newest entry read before')
    assert.ok(!JSON.stringify(paramsOf(worker.host, 'notifications.show')).match(/miss/i), 'never notified')

    // Grown by less than a window: nothing missed.
    answer = { entries: [] } as unknown as typeof answer
    listed = { ...listed, files: [{ ...listed.files[0], size: 250_000 }] }
    list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.missedSince, null)

    // A file not seen before, already past its window and written since the last read: flagged.
    // One past its window but untouched since long before: not.
    listed = {
      count: 3,
      files: [
        { ...listed.files[0], size: 250_000 },
        { name: 'error-blade1-1-appserver-20261126.log', prefix: 'error', size: 90_000, lastModified: '2026-11-26T11:45:00.000Z', path: 'logs/x' },
        { name: 'error-blade0-1-appserver-20261120.log', prefix: 'error', size: 900_000, lastModified: '2026-11-20T23:59:00.000Z', path: 'logs/y' }
      ]
    }
    list = await readNow(worker, { role: 'sandbox' })
    assert.notEqual(list.missedSince, null)
    listed = { ...listed, files: [listed.files[0], listed.files[2]] }
    list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.missedSince, null, 'the old file alone flags nothing')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a listing that fails changes nothing: the read goes on and the last sizes are kept', async () => {
  const root = makeWorkspace()
  try {
    const file = 'error-blade0-1-appserver-20261126.log'
    let listFails = false
    let size = 10_000
    const { worker } = await mountPiece(hostFor(root), (call) => {
      if (call.args[1] === 'list' && listFails) call.child.finish(126, '', 'ERROR: listing refused\n')
      else b2cAnswering(() => LOGS_GET, () => ({ files: [{ name: file, size, lastModified: '2026-11-26T11:00:00.000Z' }] }))(call)
    })
    await readNow(worker, { role: 'sandbox' })
    listFails = true
    size = 500_000
    let list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.error, null)
    assert.equal(list.missedSince, null)
    // The next listing that works compares with the last sizes known.
    listFails = false
    list = await readNow(worker, { role: 'sandbox' })
    assert.notEqual(list.missedSince, null)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an entry another server wrote late is read; one read before from its own file is not counted twice', async () => {
  const root = makeWorkspace()
  try {
    const entry = (file: string, at: string, order: string) => ({ ...paymentError(at, order, 'd@example.com', '1'), file })
    let answer: unknown = { entries: [entry('customerror-blade0-1.log', '2026-11-26 11:00:00.000 GMT', '1')] }
    const { worker, logsCalls } = await mountPiece(hostFor(root), b2cAnswering(() => answer))
    let list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.rows[0].count, 1)
    // The next read starts five minutes before: blade0's entry comes back and is not counted again;
    // blade1 wrote one a minute earlier than blade0's, but later.
    answer = {
      entries: [entry('customerror-blade0-1.log', '2026-11-26 11:00:00.000 GMT', '1'), entry('customerror-blade1-1.log', '2026-11-26 10:59:00.000 GMT', '2')]
    }
    list = await readNow(worker, { role: 'sandbox' })
    assert.ok(logsCalls()[1].args.includes(`--since=${new Date(Date.UTC(2026, 10, 26, 11) - OVERLAP_MS).toISOString()}`))
    assert.equal(list.rows[0].count, 2)
    // Read again: neither is counted again.
    list = await readNow(worker, { role: 'sandbox' })
    assert.equal(list.rows[0].count, 2)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('intervalOf and readArguments', () => {
  assert.equal(intervalOf(5), 5)
  assert.equal(intervalOf('15'), 15)
  assert.equal(intervalOf(2.4), 2)
  assert.equal(intervalOf(99999), 1440)
  for (const off of [0, -1, '', 'x', null, undefined, Number.NaN]) assert.equal(intervalOf(off), 0, String(off))
  assert.deepEqual(readArguments(['error'], 0), ['logs', 'get', '--no-normalize', '--filter=error', '--level=ERROR', '--level=FATAL', `--count=${MAX_ENTRIES}`, '--since=1970-01-01T00:00:00.000Z'])
})
