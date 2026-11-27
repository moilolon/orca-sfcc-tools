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
import { createDescriber, type Describer } from './dw/describe'
import type { EngineCompletion, EngineHover, EngineIndexStatus } from './protocol'
import { MAX_COMPLETION_ITEMS } from './query/complete'
import { committedDw } from './query/testing'
import { createEnginePiece, DEBOUNCE_MS, DESCRIBE_WAIT_MS, loadDw, MAX_WAIT_MS, REF_CHECK_MS, START_DELAY_MS, type EngineDeps } from './worker'

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

test('the watcher’s changes are debounced: each change restarts the wait, and MAX_WAIT_MS bounds it', async () => {
  let clock = 0
  const files = fixtureFiles()
  const { ready, watched, timers } = await mount(hostFor('w-shop'), { 'C:/work/shop': files }, { now: () => clock })
  await ready()
  const live = () => timers.filter((timer) => !timer.cleared && timer.ms !== REF_CHECK_MS && timer.ms !== START_DELAY_MS)
  const watcher = watched[0]
  watcher.onChange('cartridges/app_garden_base/cartridge/scripts/a.js')
  assert.deepEqual(live().map((timer) => timer.ms), [DEBOUNCE_MS])
  clock = 200
  watcher.onChange('cartridges/app_garden_base/cartridge/scripts/b.js')
  // The first wait was cancelled, a new full one started.
  assert.deepEqual(live().map((timer) => timer.ms), [DEBOUNCE_MS])
  // Changes keep coming: the wait shrinks so the batch is taken in MAX_WAIT_MS after its first change.
  clock = MAX_WAIT_MS - 100
  watcher.onChange('cartridges/app_garden_base/cartridge/scripts/c.js')
  assert.deepEqual(live().map((timer) => timer.ms), [100])
  clock = MAX_WAIT_MS + 50
  watcher.onChange('cartridges/app_garden_base/cartridge/scripts/d.js')
  assert.deepEqual(live().map((timer) => timer.ms), [0])
})

test('a timer asks every REF_CHECK_MS whether the ref moved: a worktree’s refs are not in the folder watched', async () => {
  const files = fixtureFiles()
  files.delete('sites')
  const commit = 'a'.repeat(40)
  const ref = new FakeRef({ 'origin/main': commit }, { [commit]: { 'sites/x/sites/Shop/site.xml': '<site site-id="Shop"><custom-cartridges>app_garden_base</custom-cartridges></site>' } })
  const { ready, fire } = await mount(hostFor('w-shop', { metadataRef: 'origin/main' }), { 'C:/work/shop': files }, { git: () => ref })
  assert.deepEqual((await ready()).index?.storefronts.map((s) => s.cartridges), [['app_garden_base']])
  const before = ref.calls.length
  fire(REF_CHECK_MS)
  await settle()
  assert.deepEqual(ref.calls.slice(before), ['commit origin/main'])
  const moved = 'b'.repeat(40)
  ref.commits['origin/main'] = moved
  ref.trees[moved] = { 'sites/x/sites/Shop/site.xml': '<site site-id="Shop"><custom-cartridges>app_garden_core:app_garden_base</custom-cartridges></site>' }
  fire(REF_CHECK_MS)
  await settle()
  assert.deepEqual((await ready()).index?.storefronts.map((s) => s.cartridges), [['app_garden_core', 'app_garden_base']])
})

// ---------------------------------------------------------------------------------------------
// The queries (phase 6.4)

const SCRIPT = 'cartridges/app_garden_base/cartridge/scripts/helpers/garden.js'
const MEMBERS = "var collections = require('*/cartridge/scripts/util/collections');\ncollections."

/** A docs page of b2c for an invented class, with a host the fake masker hides. */
function docsPage(id: string): unknown {
  const content = ['# Class ProductMgr', '', 'Reads the products of example-host.example.com.', '', '## Method Details', '', '### getProduct(String)', '', 'Returns the product of example-host.example.com.'].join('\n')
  return { entry: { id }, content }
}

function fakeDocs(answer: (id: string) => unknown = docsPage) {
  const calls: string[][] = []
  const b2c = {
    async run(args: readonly string[]) {
      calls.push([...args])
      const json = answer(args[2])
      if (json instanceof Error) throw json
      return { stdout: '', stderr: '', json }
    },
    async mask(text: string) {
      return text.replace(/example-host\.example\.com/g, '***')
    }
  }
  return { calls, describer: () => createDescriber(b2c as unknown as B2c) }
}

test('engine.complete and engine.hover answer on the editor’s text with the index of the workspace named, in positions of that text', async () => {
  const docs = fakeDocs()
  const { worker, ready } = await mount(hostFor('w-shop'), { 'C:/work/shop': fixtureFiles() }, { api: async () => committedDw(), describer: docs.describer })
  await ready()
  const complete = (input: Record<string, unknown>) => worker.request('engine.complete', input as never) as Promise<EngineCompletion>
  const hover = (input: Record<string, unknown>) => worker.request('engine.hover', input as never) as Promise<EngineHover>
  // A text the disk does not have yet: the editor's.
  const members = await complete({ workspaceId: 'w-shop', path: SCRIPT, text: MEMBERS, offset: MEMBERS.length })
  assert.deepEqual([members.index, members.error], ['ready', null])
  assert.deepEqual(members.completion.items.map((item) => item.label), ['first', 'map'])
  assert.deepEqual(members.completion.range, { start: MEMBERS.length, end: MEMBERS.length })
  // A completion item's id, then a place, hovered.
  const item = await hover({ workspaceId: 'w-shop', path: SCRIPT, text: MEMBERS, offset: MEMBERS.length, id: members.completion.items[0].id })
  assert.equal(item.hover?.kind, 'module-member')
  assert.equal(item.hover?.range, null)
  const text = MEMBERS + 'first(list);'
  const at = await hover({ workspaceId: 'w-shop', path: SCRIPT, text, offset: text.indexOf('first') + 2 })
  assert.deepEqual(at.hover?.range, { start: text.indexOf('first'), end: text.indexOf('first') + 5 })
  assert.deepEqual([at.hover?.description, at.hover?.descriptionError], [null, null])
  // Backslashes and `./` are read as the same path.
  const windows = await complete({ workspaceId: 'w-shop', path: `./${SCRIPT.replace(/\//g, '\\')}`, text: MEMBERS, offset: MEMBERS.length })
  assert.deepEqual(windows.completion.items.map((each) => each.label), ['first', 'map'])
  // Another workspace is not the one indexed: what needs no checkout still answers.
  const other = await complete({ workspaceId: 'w-fix', path: SCRIPT, text: MEMBERS, offset: MEMBERS.length })
  assert.deepEqual([other.index, other.completion.items], ['none', []])
  const tags = await complete({ workspaceId: 'w-fix', path: 'c/x.isml', text: '<isif', offset: 5 })
  assert.deepEqual(tags.completion.items.map((each) => each.label), ['isif'])
  assert.equal(docs.calls.length, 0)
})

test('engine.hover reads a dw description through b2c docs read, masked, once per page, and waits at most DESCRIBE_WAIT_MS', async () => {
  const docs = fakeDocs()
  const { worker, ready } = await mount(hostFor('w-shop'), { 'C:/work/shop': fixtureFiles() }, { api: async () => committedDw(), describer: docs.describer })
  await ready()
  const text = "var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(pid);"
  const query = { workspaceId: 'w-shop', path: SCRIPT, text, offset: text.indexOf('getProduct') + 1 }
  const member = (await worker.request('engine.hover', query)) as EngineHover
  assert.equal(member.hover?.kind, 'dw-member')
  assert.equal(member.hover?.description, 'Returns the product of ***.')
  assert.equal(member.hover?.descriptionError, null)
  const cls = (await worker.request('engine.hover', { ...query, offset: text.indexOf('ProductMgr.') + 1 })) as EngineHover
  assert.deepEqual([cls.hover?.kind, cls.hover?.description], ['dw-class', 'Reads the products of ***.'])
  // One page read for both: kept in memory, never stored.
  assert.deepEqual(docs.calls, [['docs', 'read', 'dw.catalog.ProductMgr', '--workspace', 'all']])
  // A failure is a code; the hover is there without its description.
  const failing = fakeDocs(() => Object.assign(new Error('no b2c'), { code: 'b2c_not_found' }))
  const second = await mount(hostFor('w-shop'), { 'C:/work/shop': fixtureFiles() }, { api: async () => committedDw(), describer: failing.describer })
  await second.ready()
  const failed = (await second.worker.request('engine.hover', query)) as EngineHover
  assert.deepEqual([failed.hover?.kind, failed.hover?.description, failed.hover?.descriptionError], ['dw-member', null, 'b2c_not_found'])
  // A page that does not come in time: answered without it after DESCRIBE_WAIT_MS.
  const slow: Describer = { describe: () => new Promise<string | null>(() => undefined) }
  const third = await mount(hostFor('w-shop'), { 'C:/work/shop': fixtureFiles() }, { api: async () => committedDw(), describer: () => slow })
  await third.ready()
  const pending = third.worker.request('engine.hover', query) as Promise<EngineHover>
  await settle()
  third.fire(DESCRIBE_WAIT_MS)
  const late = await pending
  assert.deepEqual([late.hover?.kind, late.hover?.description, late.hover?.descriptionError], ['dw-member', null, 'timeout'])
})

test('a query is bounded and checked: at most 200 items; a path that leaves the workspace or an offset outside the text answers nothing', async () => {
  const { worker, ready } = await mount(hostFor('w-shop'), { 'C:/work/shop': fixtureFiles() }, { api: async () => committedDw() })
  await ready()
  const complete = (input: Record<string, unknown>) => worker.request('engine.complete', input as never) as Promise<EngineCompletion>
  const many = "require('dw/')"
  const bounded = await complete({ workspaceId: 'w-shop', path: SCRIPT, text: many, offset: many.length - 2 })
  assert.equal(bounded.completion.items.length, MAX_COMPLETION_ITEMS)
  assert.equal(bounded.completion.truncated, true)
  const cases: [Record<string, unknown>, string][] = [
    [{ workspaceId: 'w-shop', path: '../outside.js', text: 'a.', offset: 2 }, 'file_invalid'],
    [{ workspaceId: 'w-shop', path: 'C:/work/shop/a.js', text: 'a.', offset: 2 }, 'file_invalid'],
    [{ workspaceId: 'w-shop', path: '', text: 'a.', offset: 2 }, 'file_invalid'],
    [{ path: SCRIPT, text: 'a.', offset: 2 }, 'file_invalid'],
    [{ workspaceId: 'w-shop', path: SCRIPT, text: 'a.', offset: 3 }, 'offset_invalid'],
    [{ workspaceId: 'w-shop', path: SCRIPT, text: 'a.', offset: -1 }, 'offset_invalid'],
    [{ workspaceId: 'w-shop', path: SCRIPT, text: 'a.', offset: 1.5 }, 'offset_invalid'],
    [{ workspaceId: 'w-shop', path: SCRIPT, text: 'x'.repeat(2_000_001), offset: 0 }, 'text_too_large']
  ]
  for (const [input, error] of cases) {
    const answer = await complete(input)
    assert.equal(answer.error, error, JSON.stringify(input).slice(0, 80))
    assert.deepEqual(answer.completion.items, [])
    const hovered = (await worker.request('engine.hover', input as never)) as EngineHover
    assert.deepEqual([hovered.error, hovered.hover], [error, null])
  }
  // A file the engine does not read: nothing, and no error.
  const other = await complete({ workspaceId: 'w-shop', path: 'README.md', text: 'a.b', offset: 2 })
  assert.deepEqual([other.error, other.completion.items], [null, []])
})
