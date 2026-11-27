// Which workspace the engine indexes as the focus moves (the one the plugin works on, kept while
// the focus is on a workspace with no configuration file), and the indexes kept for the last two
// targets: going back reads only what changed, the oldest is dropped, and only the target is
// watched.
import { assert, mockHost, mountWorker, test, type MockHost } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { B2c } from '../../core/b2c'
import { translator } from '../../core/i18n'
import type { PieceContext, Workspaces } from '../../core/piece'
import { createSettings } from '../../core/settings'
import { createStore } from '../../core/store'
import { createWorkspaces } from '../../core/workspaces'
import { MemoryFiles } from './checkout/memory'
import { fixtureFiles, FakeRef } from './checkout/testing'
import type { EngineIndexStatus, ProblemsList } from './protocol'
import { createEnginePiece, DEBOUNCE_MS, KEPT_INDEXES } from './worker'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const listed = (id: string, path: string, hostId = 'local') => ({ id, kind: 'worktree', name: id, path, branch: 'main', hostId })
const SHOP = listed('w-shop', 'C:/work/shop')
const FIX = listed('w-fix', 'C:/work/fix')
const HOTFIX = listed('w-hotfix', 'C:/work/hotfix')
const NOTES = listed('w-notes', 'C:/home/notes')
const REMOTE = listed('w-remote', '/srv/shop', 'ssh:build-01')
/** The folders with a configuration file: every one but the notes. */
const WITH_FILE = ['C:/work/shop', 'C:/work/fix', 'C:/work/hotfix', '/srv/shop']

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Every read of a checkout, whatever the file. */
const readsOf = (files: MemoryFiles) => [...files.reads.values()].reduce((sum, count) => sum + count, 0)

async function mount(roots: Record<string, MemoryFiles>, storage: Record<string, string> = {}) {
  const host: MockHost = mockHost({
    capabilities: CAPABILITIES,
    storage,
    results: { 'workspace.list': { workspaces: [SHOP, FIX, HOTFIX, NOTES, REMOTE], truncated: false }, 'workspace.readContext': null }
  })
  const timers: { run: () => void; ms: number; cleared: boolean }[] = []
  const watched: { root: string; onChange: (path: string) => void; disposed: boolean }[] = []
  const piece = createEnginePiece({
    files: (root) => roots[root] ?? new MemoryFiles(),
    watch: (root, onChange) => {
      const watcher = { root, onChange, disposed: false }
      watched.push(watcher)
      return { dispose: () => void (watcher.disposed = true) }
    },
    git: () => new FakeRef({}, {}),
    exists: async () => true,
    dw: async () => (module) => (module.startsWith('dw/') ? module.replace(/\//g, '.') : null),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
    // A loaded machine, always: each slice of a problems pass ends at once and pauses on a real
    // timer, so a pass is still reading files long after the index is ready. The counts below
    // hold only because each move waits for the pass to end (`quiet`).
    now: (() => {
      let at = 0
      return () => (at += 1_000)
    })(),
    pause: () => new Promise<void>((resolve) => setTimeout(resolve, 1))
  })
  let disposable: { dispose(): void | Promise<void> } | void = undefined
  let made: Workspaces | null = null
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        // The rule of the real worker: a folder counts as SFCC when it has a configuration file.
        const workspaces = createWorkspaces(orca.host, createStore(orca.storage, 'core'), { hasConfig: async (root) => WITH_FILE.includes(root) })
        made = workspaces
        const ctx: PieceContext = {
          orca,
          b2c: { mask: async (text: string) => text } as unknown as B2c,
          settings: createSettings(orca.settings),
          store: createStore(orca.storage, 'engine'),
          workspaces,
          t: translator(() => 'en'),
          log: (message) => orca.log(message)
        }
        disposable = await piece.activate(ctx)
      },
      deactivate: () => disposable?.dispose()
    },
    { host }
  )
  const status = () => worker.request('engine.index.status', {}) as Promise<EngineIndexStatus>
  const ready = async (): Promise<EngineIndexStatus> => {
    for (let i = 0; i < 2000; i++) {
      const answer = await status()
      if (answer.state !== 'building') return answer
      await settle()
    }
    throw new Error('the build never ended')
  }
  /**
   * Asks until no problems pass runs: a pass reads files of the same checkout, so a count of reads
   * taken while one runs would depend on how fast the machine is.
   */
  const quiet = async () => {
    for (let i = 0; i < 5000; i++) {
      const list = (await worker.request('engine.problems.list', {})) as ProblemsList
      if (!list.busy && list.state !== 'indexing' && list.state !== 'analysing') return
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    throw new Error('the problems pass never ended')
  }
  /** Moves the focus, then asks until the index of the target is ready and its pass has ended. */
  const focus = async (id: string | null) => {
    host.respond('workspace.readContext', id ? { workspaceId: id, branch: 'main', displayName: id, terminals: [] } : null)
    const answer = await ready()
    await quiet()
    return answer
  }
  const fire = (ms: number) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
      timer.cleared = true
      timer.run()
    }
  }
  return { host, focus, ready, status, watched, fire, workspaces: () => made as unknown as Workspaces, dispose: () => disposable?.dispose() }
}

test('two indexes are kept: the last two targets', () => {
  assert.equal(KEPT_INDEXES, 2)
})

test('focus moves to a workspace with no file, to none, or to a remote one: the index stays on the last SFCC one', async () => {
  const shop = fixtureFiles()
  const { focus, watched } = await mount({ 'C:/work/shop': shop })
  assert.equal((await focus('w-shop')).workspaceId, 'w-shop')
  const reads = readsOf(shop)
  for (const elsewhere of ['w-notes', null, 'w-shop', 'w-notes']) {
    const answer = await focus(elsewhere)
    assert.equal(answer.workspaceId, 'w-shop', `focus on ${elsewhere}`)
    assert.equal(answer.state, 'ready')
  }
  assert.equal(readsOf(shop), reads, 'never built again: no file read')
  assert.deepEqual(
    watched.map((w) => [w.root, w.disposed]),
    [['C:/work/shop', false]],
    'watched once, and still'
  )
  // A remote workspace with a file is never indexed, and never replaces the kept one.
  assert.equal((await focus('w-remote')).workspaceId, 'w-shop')
})

test('A → B → A: A is not rebuilt, and a file changed in A while B was the target is read again on return', async () => {
  const shop = fixtureFiles()
  const fix = fixtureFiles()
  const { focus, watched } = await mount({ 'C:/work/shop': shop, 'C:/work/fix': fix })
  await focus('w-shop')
  const shopFiles = [...shop.reads.keys()]
  assert.ok(shopFiles.length > 10)
  assert.equal((await focus('w-fix')).workspaceId, 'w-fix')
  assert.ok(watched[0].disposed, 'A is no longer watched while B is the target')
  // A file of A changes while nobody watches it.
  const changed = shopFiles.find((path) => path.endsWith('.js'))!
  const before = new Map(shop.reads)
  shop.set(changed, `${await shop.read(changed)}\nvar added = 1;\n`, 2)
  shop.reads.set(changed, before.get(changed) ?? 0)
  const back = await focus('w-shop')
  assert.equal(back.workspaceId, 'w-shop')
  assert.equal(back.state, 'ready')
  const readAgain = [...shop.reads].filter(([path, count]) => count !== (before.get(path) ?? 0)).map(([path]) => path)
  assert.ok(readAgain.includes(changed), 'the changed file is read again')
  assert.ok(readAgain.length <= 2, `only what changed is read again: ${readAgain.join(', ')}`)
  assert.deepEqual(
    watched.map((w) => [w.root, w.disposed]),
    [
      ['C:/work/shop', true],
      ['C:/work/fix', true],
      ['C:/work/shop', false]
    ],
    'only the target is watched'
  )
})

test('a third target drops the least recently used index: going back to it builds it again', async () => {
  const shop = fixtureFiles()
  const fix = fixtureFiles()
  const hotfix = fixtureFiles()
  const { focus, watched } = await mount({ 'C:/work/shop': shop, 'C:/work/fix': fix, 'C:/work/hotfix': hotfix })
  await focus('w-shop')
  await focus('w-fix')
  await focus('w-shop')
  const shopReads = readsOf(shop)
  const fixReads = readsOf(fix)
  // Shop was used last: the hotfix drops the fix's index.
  await focus('w-hotfix')
  assert.equal((await focus('w-shop')).workspaceId, 'w-shop')
  assert.equal(readsOf(shop), shopReads, 'kept: not read again')
  // Now the hotfix is the older of the two kept; the fix comes back with nothing kept.
  assert.equal((await focus('w-fix')).workspaceId, 'w-fix')
  assert.ok(readsOf(fix) > fixReads, 'dropped: every file read again')
  const hotfixReads = readsOf(hotfix)
  assert.equal((await focus('w-hotfix')).workspaceId, 'w-hotfix')
  assert.ok(readsOf(hotfix) > hotfixReads, 'dropped by the fix: built again')
  // Every watcher but the target's is closed, the dropped ones' included.
  assert.deepEqual(
    watched.filter((w) => !w.disposed).map((w) => w.root),
    ['C:/work/hotfix']
  )
})

test('a dropped index runs no more passes, and a change in its folder is never taken in', async () => {
  const shop = fixtureFiles()
  const fix = fixtureFiles()
  const hotfix = fixtureFiles()
  const { focus, watched, fire } = await mount({ 'C:/work/shop': shop, 'C:/work/fix': fix, 'C:/work/hotfix': hotfix })
  await focus('w-shop')
  const shopWatcher = watched[0]
  await focus('w-fix')
  await focus('w-hotfix')
  const reads = readsOf(shop)
  // The watcher of a dropped target was closed; a late event of it changes nothing.
  assert.ok(shopWatcher.disposed)
  shopWatcher.onChange('cartridges/app_garden_core/cartridge/scripts/helpers.js')
  fire(DEBOUNCE_MS)
  await settle()
  assert.equal(readsOf(shop), reads)
})

test('an uploading workspace picked and released: indexed while it uploads, kept once released', async () => {
  const shop = fixtureFiles()
  const fix = fixtureFiles()
  const { focus, workspaces } = await mount({ 'C:/work/shop': shop, 'C:/work/fix': fix })
  await focus('w-shop')
  await workspaces().setUploading('w-fix', 'ws-fix')
  assert.equal((await focus('w-shop')).workspaceId, 'w-fix', 'the uploading one over the focused one')
  assert.equal((await focus('w-notes')).workspaceId, 'w-fix')
  await workspaces().setUploading(null)
  assert.equal((await focus('w-notes')).workspaceId, 'w-fix', 'released while the focus has no file: it stays')
  const reads = readsOf(shop)
  assert.equal((await focus('w-shop')).workspaceId, 'w-shop', 'a workspace with a file focused takes over')
  assert.equal(readsOf(shop), reads, 'its index was kept')
})
