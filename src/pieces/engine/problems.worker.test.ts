// The engine's worker and the problems (phase 6.5), over a mock host and the invented checkout
// extended with `fixtures/problems/`: the pass after the build and its event, the view's list,
// filter, search and detail with names masked, the editor's query, opening a file at its line, the
// save hook that only schedules, and the notice: how many, never what, at most once a minute per
// file, after a save and after an edit the watcher sees.
import { assert, mockHost, mountWorker, test, type MockHost } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { translator } from '../../core/i18n'
import type { B2c } from '../../core/b2c'
import type { OpenFileRequest } from '../../core/open-file'
import type { PieceContext } from '../../core/piece'
import { createSettings } from '../../core/settings'
import { createStore } from '../../core/store'
import { createWorkspaces } from '../../core/workspaces'
import type { CheckoutFiles } from './checkout/files'
import { MemoryFiles } from './checkout/memory'
import { FakeRef } from './checkout/testing'
import { BASE, problemFiles } from './problems/testing'
import type { EngineProblems, ProblemsList, ProblemsOfFile } from './protocol'
import { committedDw } from './query/testing'
import { createEnginePiece, DEBOUNCE_MS, NOTICE_INTERVAL_MS, type EngineDeps } from './worker'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const SHOP = { id: 'w-shop', kind: 'worktree', name: 'Shop', path: 'C:/work/shop', branch: 'main', hostId: 'local' }
const FIX = { id: 'w-fix', kind: 'worktree', name: 'Fix', path: 'C:/work/fix', branch: 'fix', hostId: 'local' }
const CLEAN = `${BASE}/cartridge/scripts/checks/clean.js`
const ATTRIBUTES = `${BASE}/cartridge/scripts/checks/attributes.js`

function hostFor(focused: string | null): MockHost {
  return mockHost({
    capabilities: CAPABILITIES,
    results: {
      'workspace.list': { workspaces: [SHOP, FIX], truncated: false },
      'workspace.readContext': focused ? { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] } : null
    }
  })
}

type Timer = { run: () => void; ms: number; cleared: boolean }

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A runner that masks one invented name, as dw.json's values would be. */
const b2c = { mask: async (text: string) => text.replace(/GardenWishlist/g, '***') } as unknown as B2c

async function mount(host: MockHost, roots: Record<string, CheckoutFiles>, extra: Partial<EngineDeps> = {}) {
  const timers: Timer[] = []
  const watched: { onChange: (path: string) => void }[] = []
  let clock = 1_000_000
  const opened: OpenFileRequest[] = []
  const piece = createEnginePiece({
    files: (root) => roots[root] ?? new MemoryFiles(),
    watch: (_root, onChange) => {
      watched.push({ onChange })
      return { dispose: () => undefined }
    },
    git: () => new FakeRef({}, {}),
    // The invented folders are not on this disk: they are there for the worker.
    exists: async () => true,
    api: async () => committedDw(),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => void ((timer as Timer).cleared = true),
    now: () => clock,
    openFile: async (request) => {
      opened.push(request)
      return { opened: true }
    },
    ...extra
  })
  let disposable: { dispose(): void | Promise<void> } | void = undefined
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        const ctx: PieceContext = {
          orca,
          b2c,
          settings: createSettings(orca.settings),
          store: createStore(orca.storage, 'engine'),
          workspaces: createWorkspaces(orca.host, createStore(orca.storage, 'core')),
          t: translator(() => 'en'),
          log: (message) => orca.log(message)
        }
        disposable = await piece.activate(ctx)
      },
      deactivate: () => disposable?.dispose()
    },
    { host, hooks: ['editor.save.before'] }
  )
  const list = (input: Record<string, unknown> = {}) => worker.request('engine.problems.list', input) as Promise<ProblemsList>
  /** Asks until the first pass ended. */
  const analysed = async (): Promise<ProblemsList> => {
    for (let i = 0; i < 2000; i++) {
      const answer = await list()
      if (answer.state === 'ready' && !answer.busy) return answer
      if (answer.state === 'failed') throw new Error('the pass failed')
      await settle()
    }
    throw new Error('the pass never ended')
  }
  const fire = (ms: number) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
      timer.cleared = true
      timer.run()
    }
  }
  const notices = () => host.callsOf('notifications.show') as { title: string; body: string }[]
  return { worker, list, analysed, watched, fire, opened, notices, tick: (ms: number) => void (clock += ms), dispose: () => disposable?.dispose() }
}

test('after the build a pass finds the problems: counts posted, a page of files, the filter, the search, a file’s detail, names masked', async () => {
  const host = hostFor('w-shop')
  const { worker, list, analysed } = await mount(host, { 'C:/work/shop': problemFiles() })
  const first = await list()
  assert.ok(first.state === 'indexing' || first.state === 'analysing' || first.state === 'ready')
  const answer = await analysed()
  assert.deepEqual(answer.counts, { error: 13, warning: 18, info: 3 })
  assert.equal(answer.files, 15)
  assert.deepEqual(answer.matching, { problems: 34, files: 15, listable: 34 })
  // The first page: files in path order, at most five problems each, 25 problems in all.
  assert.equal(
    answer.page.reduce((sum, file) => sum + file.problems.length, 0),
    25
  )
  assert.equal(answer.page[0].path, `${BASE}/cartridge/controllers/Checks.js`)
  assert.ok(answer.page.every((file) => file.problems.length <= 5))
  // The view was told once the pass ended.
  const posts = worker.posts.filter((post) => post.event === 'engine.problems.changed')
  assert.ok(posts.length >= 1)
  assert.deepEqual((posts[posts.length - 1].payload as { counts: unknown }).counts, { error: 13, warning: 18, info: 3 })

  const errors = await list({ severity: 'error', limit: 100 })
  assert.equal(errors.matching.problems, 13)
  assert.ok(errors.page.every((file) => file.problems.every((each) => each.severity === 'error')))
  const searched = await list({ search: 'gardensize' })
  assert.deepEqual(
    searched.page.map((file) => [file.path, file.problems.map((each) => each.args.name)]),
    [[ATTRIBUTES, ['gardenSize']]]
  )
  // A name of dw.json never leaves the worker: the runner's mask is applied to every name.
  const detail = (await worker.request('engine.problems.file', { path: ATTRIBUTES })) as ProblemsOfFile
  assert.equal(detail.total, 5)
  assert.deepEqual(
    detail.problems.map((each) => each.args.type ?? null),
    ['Product', 'Product', null, null, '***']
  )
})

test('engine.problems.open opens the file at the problem’s line through Orca’s command line, bringing the person to it', async () => {
  const { worker, analysed, opened } = await mount(hostFor('w-shop'), { 'C:/work/shop': problemFiles() })
  await analysed()
  assert.deepEqual(await worker.request('engine.problems.open', { path: ATTRIBUTES, line: 16, column: 31 }), { opened: true })
  assert.deepEqual(opened, [{ root: 'C:/work/shop', path: ATTRIBUTES, line: 16, column: 31, focus: true }])
  // Only a file with problems of the workspace analysed.
  assert.deepEqual(await worker.request('engine.problems.open', { path: '../outside.js', line: 1 }), { opened: false, reason: 'not_found' })
  assert.equal(opened.length, 1)
})

test('engine.problems answers a text with the index of its workspace; a text of another workspace gets nothing from it', async () => {
  const { worker, analysed } = await mount(hostFor('w-shop'), { 'C:/work/shop': problemFiles() })
  await analysed()
  const text = "var ProductMgr = require('dw/catalog/ProductMgr');\nvar c = ProductMgr.getProduct('1').custom.gardenColor;\n"
  const answer = (await worker.request('engine.problems', { workspaceId: 'w-shop', path: CLEAN, text })) as EngineProblems
  assert.equal(answer.index, 'ready')
  assert.deepEqual(
    answer.problems.map((each) => [each.code, each.line, text.slice(each.start, each.end)]),
    [['unknown_attribute', 2, 'gardenColor']]
  )
  const other = (await worker.request('engine.problems', { workspaceId: 'w-fix', path: CLEAN, text })) as EngineProblems
  assert.deepEqual(other, { index: 'none', error: null, problems: [] })
  const bad = (await worker.request('engine.problems', { workspaceId: 'w-shop', path: '../x.js', text })) as EngineProblems
  assert.equal(bad.error, 'file_invalid')
})

test('the save hook returns at once, changing nothing; the analysis runs after it and tells how many new problems, never what', async () => {
  // The worker's pause is held shut during the save: what waits on it has not run.
  let gate = false
  const held: (() => void)[] = []
  const pause = () => (gate ? new Promise<void>((resolve) => held.push(resolve)) : new Promise<void>((resolve) => setImmediate(resolve)))
  const { worker, analysed, notices } = await mount(hostFor('w-shop'), { 'C:/work/shop': problemFiles() }, { pause })
  await analysed()
  const text = "var ProductMgr = require('dw/catalog/ProductMgr');\nvar a = ProductMgr.getProduct('1').custom.gardenColor;\nvar b = ProductMgr.getProduct('1').custom.gardenHue;\n"
  const event = { workspaceId: 'w-shop', path: `C:\\work\\shop\\${CLEAN.replace(/\//g, '\\')}`, languageId: 'javascript', text }
  gate = true
  const decision = await worker.hooks.fire('editor.save.before', event)
  // The hook answered before Orca's 2 s deadline: a hook that waited for the held analysis would
  // time out, which the test host counts as passing and only logs.
  assert.deepEqual(worker.logs.filter((line) => line.includes('editor.save.before')), [])
  // It goes on with the event as it came: nothing refused, nothing rewritten. The analysis is
  // only scheduled: it waits on the pause, and nothing of it has run when the hook returned.
  assert.equal(decision.kind, 'continue')
  assert.deepEqual(decision.kind === 'continue' ? decision.event : null, event)
  assert.equal(held.length, 1)
  assert.equal(notices().length, 0)
  assert.equal(((await worker.request('engine.problems.file', { path: CLEAN })) as ProblemsOfFile).total, 0)
  gate = false
  for (const release of held.splice(0)) release()
  await settle()
  assert.deepEqual(notices(), [{ title: 'New problems', body: '2 new problems in the file just saved' }])
  // The notice names no file and no problem.
  assert.ok(!JSON.stringify(notices()).includes('garden'))
  const detail = (await worker.request('engine.problems.file', { path: CLEAN })) as ProblemsOfFile
  assert.equal(detail.total, 2)
})

test('the notice comes at most once per file per minute; a save that adds nothing new tells nothing', async () => {
  const { worker, analysed, notices, tick } = await mount(hostFor('w-shop'), { 'C:/work/shop': problemFiles() })
  await analysed()
  const save = async (names: string[]) => {
    const text = `var P = require('dw/catalog/ProductMgr');\n${names.map((name) => `P.getProduct('1').custom.${name};`).join('\n')}\n`
    await worker.hooks.fire('editor.save.before', { workspaceId: 'w-shop', path: CLEAN, text })
    await settle()
  }
  await save(['gardenOne'])
  assert.equal(notices().length, 1)
  // Within the minute: a new problem in the same file is not told again.
  tick(NOTICE_INTERVAL_MS / 2)
  await save(['gardenOne', 'gardenTwo'])
  assert.equal(notices().length, 1)
  // Past it: told again; and the same problems saved again are not new.
  tick(NOTICE_INTERVAL_MS)
  await save(['gardenOne', 'gardenTwo', 'gardenThree'])
  assert.equal(notices().length, 2)
  assert.equal(notices()[1].body, '1 new problem in the file just saved')
  tick(NOTICE_INTERVAL_MS * 2)
  await save(['gardenThree', 'gardenOne', 'gardenTwo'])
  assert.equal(notices().length, 2)
  // A save of a file of another workspace, or outside every cartridge, is not analysed.
  await worker.hooks.fire('editor.save.before', { workspaceId: 'w-fix', path: CLEAN, text: 'P.getProduct().custom.x' })
  await worker.hooks.fire('editor.save.before', { workspaceId: null, path: 'D:/elsewhere/file.js', text: 'x' })
  await settle()
  assert.equal(notices().length, 2)
})

test('an edit the watcher sees, an agent’s, is analysed and told the same way, once the debounce took it in', async () => {
  const files = problemFiles()
  const { analysed, watched, fire, notices, list } = await mount(hostFor('w-shop'), { 'C:/work/shop': files })
  await analysed()
  files.set(CLEAN, "var P = require('dw/catalog/ProductMgr');\nP.getProduct('1').custom.gardenWeight;\n", 5)
  watched[0].onChange(CLEAN)
  fire(DEBOUNCE_MS)
  const after = await analysed()
  for (let i = 0; i < 50 && notices().length === 0; i++) await settle()
  assert.deepEqual(notices(), [{ title: 'New problems', body: '1 new problem in a file just changed' }])
  assert.equal(after.counts.warning, 19)
  // The file fixed: the problem goes, nothing is told.
  files.set(CLEAN, "'use strict';\n", 6)
  watched[0].onChange(CLEAN)
  fire(DEBOUNCE_MS)
  await settle()
  const fixed = await analysed()
  assert.equal(fixed.counts.warning, 18)
  assert.equal((await list()).counts.warning, 18)
  assert.equal(notices().length, 1)
})

test('the first pass tells nothing: every problem found then is old', async () => {
  const { analysed, notices } = await mount(hostFor('w-shop'), { 'C:/work/shop': problemFiles() })
  await analysed()
  await settle()
  assert.equal(notices().length, 0)
})

test('no workspace to analyse: the list says so and holds nothing', async () => {
  const { list } = await mount(hostFor(null), {})
  const answer = await list()
  assert.equal(answer.state, 'none')
  assert.equal(answer.workspaceId, null)
  assert.deepEqual(answer.page, [])
})
