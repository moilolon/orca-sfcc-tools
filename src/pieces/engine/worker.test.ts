// The engine piece's worker over a mock host and the invented checkout in memory: which
// workspace it indexes, that `engine.index.status` never waits for a build, the watcher's changes
// taken in, the settings, and a workspace on another host.
import { assert, mockHost, mountWorker, test, type MockHost } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { translator } from '../../core/i18n'
import type { PieceContext } from '../../core/piece'
import { createSettings } from '../../core/settings'
import { createStore } from '../../core/store'
import { createWorkspaces } from '../../core/workspaces'
import type { B2c } from '../../core/b2c'
import { GitError, type RefReader } from './checkout/checkout'
import type { CheckoutFiles } from './checkout/files'
import { MemoryFiles } from './checkout/memory'
import { fixtureFiles, FakeRef } from './checkout/testing'
import type { EngineIndexStatus } from './protocol'
import { createEnginePiece, DEBOUNCE_MS, loadDw, START_DELAY_MS, type EngineDeps } from './worker'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const SHOP = { id: 'w-shop', kind: 'worktree', name: 'Shop', path: 'C:/work/shop', branch: 'main', hostId: 'local' }
const FIX = { id: 'w-fix', kind: 'worktree', name: 'Fix', path: 'C:/work/fix', branch: 'fix', hostId: 'local' }
const REMOTE = { id: 'w-remote', kind: 'folder', name: 'Remote', path: '/srv/shop', branch: null, hostId: 'ssh:build-01' }

function hostFor(focused: string | null, settings: Record<string, string> = {}, storage: Record<string, string> = {}) {
  return mockHost({
    capabilities: CAPABILITIES,
    settings,
    storage,
    results: {
      'workspace.list': { workspaces: [SHOP, FIX, REMOTE], truncated: false },
      'workspace.readContext': focused ? { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] } : null
    }
  })
}

type Timer = { run: () => void; ms: number; cleared: boolean }

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function mount(host: MockHost, roots: Record<string, CheckoutFiles>, extra: Partial<EngineDeps> = {}) {
  const timers: Timer[] = []
  const watched: { root: string; onChange: (path: string) => void; onError: () => void; disposed: boolean }[] = []
  const piece = createEnginePiece({
    files: (root) => roots[root] ?? new MemoryFiles(),
    watch: (root, onChange, onError) => {
      const watcher = { root, onChange, onError, disposed: false }
      watched.push(watcher)
      return { dispose: () => void (watcher.disposed = true) }
    },
    git: () => new FakeRef({}, {}),
    dw: async () => (module) => (module.startsWith('dw/') ? module.replace(/\//g, '.') : null),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => void ((timer as Timer).cleared = true),
    ...extra
  })
  let api: OrcaWorkerApi | null = null
  let disposable: { dispose(): void | Promise<void> } | void = undefined
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        api = orca
        const settings = createSettings(orca.settings)
        const workspaces = createWorkspaces(orca.host, createStore(orca.storage, 'core'))
        const ctx: PieceContext = { orca, b2c: {} as B2c, settings, store: createStore(orca.storage, 'engine'), workspaces, t: translator(() => 'en'), log: (message) => orca.log(message) }
        disposable = await piece.activate(ctx)
      },
      deactivate: () => disposable?.dispose()
    },
    { host }
  )
  const status = () => worker.request('engine.index.status', {}) as Promise<EngineIndexStatus>
  /** Asks until the build ended. */
  const ready = async (): Promise<EngineIndexStatus> => {
    for (let i = 0; i < 2000; i++) {
      const answer = await status()
      if (answer.state !== 'building') return answer
      await settle()
    }
    throw new Error('the build never ended')
  }
  const fire = (ms: number) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
      timer.cleared = true
      timer.run()
    }
  }
  return { worker, status, ready, watched, timers, fire, orca: () => api as unknown as OrcaWorkerApi, dispose: () => disposable?.dispose() }
}

test('engine.index.status answers at once while the first build runs, then with the index of the focused workspace', async () => {
  const files = fixtureFiles()
  const host = hostFor('w-shop')
  const { status, ready, watched, timers } = await mount(host, { 'C:/work/shop': files })
  // The worker waits before its first build, so it never slows the start.
  assert.ok(timers.some((timer) => timer.ms === START_DELAY_MS))
  const first = await status()
  assert.equal(first.workspaceId, 'w-shop')
  assert.equal(first.state, 'building')
  assert.equal(first.index, null)
  const answer = await ready()
  assert.equal(answer.state, 'ready')
  assert.equal(answer.watching, true)
  assert.deepEqual(watched.map((w) => w.root), ['C:/work/shop'])
  assert.ok(answer.index)
  assert.deepEqual(
    answer.index.storefronts.map((s) => [s.id, s.source]),
    [
      ['GardenOutlet', 'site-archive'],
      ['GardenShop', 'site-archive']
    ]
  )
  assert.equal(answer.index.counts.requiresUnresolved, 1)
  assert.ok(answer.index.builtAt !== null && answer.index.buildMs !== null)
  assert.deepEqual(
    answer.index.cartridges.map((c) => c.name),
    ['app_garden_base', 'app_garden_core', 'app_garden_outlet', 'modules']
  )
})

test('the uploading workspace is indexed over the focused one; switching keeps the old index for later', async () => {
  const shop = fixtureFiles()
  const fix = fixtureFiles()
  fix.delete('cartridges/app_garden_outlet')
  const host = hostFor('w-shop', {}, { 'core.uploading': 'w-fix' })
  const { ready, watched, orca } = await mount(host, { 'C:/work/shop': shop, 'C:/work/fix': fix })
  const answer = await ready()
  assert.equal(answer.workspaceId, 'w-fix')
  assert.equal(answer.index?.cartridges.length, 3)
  assert.deepEqual(watched.map((w) => w.root), ['C:/work/fix'])
  // Nothing uploads any more: the focused workspace is indexed, and the other one's watcher stops.
  await orca().storage.delete('core.uploading')
  const focused = await ready()
  assert.equal(focused.workspaceId, 'w-shop')
  assert.equal(focused.index?.cartridges.length, 4)
  assert.ok(watched[0].disposed)
  // Back to the first: its index was kept, and walking it again reads no file whose time is the same.
  const reads = new Map(fix.reads)
  await orca().storage.set('core.uploading', 'w-fix')
  const back = await ready()
  assert.equal(back.workspaceId, 'w-fix')
  assert.deepEqual(fix.reads, reads)
  assert.deepEqual(watched.map((w) => w.root), ['C:/work/fix', 'C:/work/shop', 'C:/work/fix'])
})

test('a changed file reported by the watcher is taken in after the debounce; a ref change reads the ref again', async () => {
  const files = fixtureFiles()
  const { ready, watched, fire, timers } = await mount(hostFor('w-shop'), { 'C:/work/shop': files })
  const before = await ready()
  assert.equal(before.index?.updatedAt, null)
  const watcher = watched[0]
  files.set('cartridges/app_garden_outlet/cartridge/scripts/helpers/cartHelper.js', 'module.exports = {};', 5)
  watcher.onChange('cartridges/app_garden_outlet/cartridge/scripts/helpers/cartHelper.js')
  watcher.onChange('node_modules/x/y.js')
  assert.ok(timers.some((timer) => timer.ms === DEBOUNCE_MS && !timer.cleared))
  fire(DEBOUNCE_MS)
  await settle()
  const after = await ready()
  assert.equal(after.index?.counts.requiresUnresolved, 0)
  assert.ok(after.index?.updatedAt !== null)
  watcher.onChange('.git/refs/heads/main')
  fire(DEBOUNCE_MS)
  await settle()
  assert.equal((await ready()).state, 'ready')
})

test('a changed setting rebuilds the paths: the setting wins over the site archives', async () => {
  const { ready, orca } = await mount(hostFor('w-shop'), { 'C:/work/shop': fixtureFiles() })
  await ready()
  await orca().settings.set('cartridgePath', 'app_garden_core:app_garden_base')
  await settle()
  const answer = await ready()
  assert.equal(answer.index?.pathSource, 'setting')
  assert.deepEqual(answer.index?.storefronts.map((s) => s.id), ['setting'])
})

test('the git ref setting is read when the checkout has no site archive, and its failure is a code', async () => {
  const files = fixtureFiles()
  files.delete('sites')
  const failing: RefReader = new FakeRef({}, {}, new GitError('git_not_found'))
  const { ready } = await mount(hostFor('w-shop', { metadataRef: 'origin/main' }), { 'C:/work/shop': files }, { git: () => failing })
  const answer = await ready()
  assert.equal(answer.index?.pathSource, 'none')
  assert.equal(answer.index?.gitError, 'git_not_found')
})

test('no workspace, or one on another host, is not indexed', async () => {
  const none = await mount(hostFor(null), {})
  assert.deepEqual(await none.status(), { workspaceId: null, state: 'none', error: null, watching: false, index: null })
  const remote = await mount(hostFor('w-remote'), {})
  assert.equal((await remote.status()).state, 'none')
  assert.deepEqual(remote.watched, [])
})

test('a watcher that stops on its own is replaced on the next request, and dispose stops everything', async () => {
  const { ready, watched, status, dispose } = await mount(hostFor('w-shop'), { 'C:/work/shop': fixtureFiles() })
  await ready()
  watched[0].onError()
  await status()
  assert.equal(watched.length, 2)
  assert.equal((await ready()).watching, true)
  await dispose()
  assert.ok(watched[1].disposed)
})

test('the committed dw.* index answers a class and a package, as require(“dw/…”) may name either', async () => {
  const lookup = await loadDw()
  assert.ok(lookup)
  assert.equal(lookup('dw/catalog/ProductMgr'), 'dw.catalog.ProductMgr')
  assert.equal(lookup('dw/system'), 'dw.system')
  assert.equal(lookup('dw/nothing/Here'), null)
})
