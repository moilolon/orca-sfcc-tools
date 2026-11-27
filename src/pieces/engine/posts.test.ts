// What the engine sends the panel while it indexes and analyses a checkout of the real one's size:
// an invented checkout of about 10,000 files. A components panel answers Orca's ping on the same
// thread that handles every post, so the engine posts once per pass, never once per file, and
// the worker never holds its own thread long enough to delay the answers the panel waits for.
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { translator } from '../../core/i18n'
import type { B2c } from '../../core/b2c'
import type { PieceContext } from '../../core/piece'
import { createSettings } from '../../core/settings'
import { createStore } from '../../core/store'
import { createWorkspaces } from '../../core/workspaces'
import { FakeRef, generatedCheckout } from './checkout/testing'
import type { ProblemsList } from './protocol'
import { committedDw } from './query/testing'
import { createEnginePiece } from './worker'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const SHOP = { id: 'w-shop', kind: 'worktree', name: 'Shop', path: 'C:/work/shop', branch: 'main', hostId: 'local' }
const b2c = { mask: async (text: string) => text } as unknown as B2c

test('a full index and analysis of 10,000 files posts a handful of times, and no step holds the worker for long', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    results: {
      'workspace.list': { workspaces: [SHOP], truncated: false },
      'workspace.readContext': { workspaceId: 'w-shop', branch: 'main', displayName: 'Shop', terminals: [] }
    }
  })
  const checkout = generatedCheckout(10_000)
  const piece = createEnginePiece({
    files: () => checkout,
    watch: () => ({ dispose: () => undefined }),
    git: () => new FakeRef({}, {}),
    api: async () => committedDw(),
    setTimer: () => ({}),
    clearTimer: () => undefined
  })
  const kept: { dispose(): void | Promise<void> }[] = []
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
        const disposable = await piece.activate(ctx)
        if (disposable) kept.push(disposable)
      },
      deactivate: () => Promise.all(kept.map((each) => each.dispose()))
    },
    { host }
  )
  const delay = monitorEventLoopDelay({ resolution: 1 })
  delay.enable()
  const started = performance.now()
  let answer: ProblemsList | null = null
  let slowest = 0
  // Asked as the view does, while it works.
  for (let i = 0; i < 2000; i++) {
    const asked = performance.now()
    answer = (await worker.request('engine.problems.list', {})) as ProblemsList
    slowest = Math.max(slowest, performance.now() - asked)
    if (answer.state === 'ready' && !answer.busy) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const ms = performance.now() - started
  delay.disable()
  assert.equal(answer?.state, 'ready')
  const posts = worker.posts.filter((post) => post.event === 'engine.problems.changed')
  const longest = delay.max / 1e6
  console.log(`engine over 10,000 files: ready in ${ms.toFixed(0)} ms, ${posts.length} posts, slowest list ${slowest.toFixed(0)} ms, longest block of the worker ${longest.toFixed(0)} ms`)
  // One when indexing starts, one when the analysis ends; never one per file or per slice.
  assert.ok(posts.length >= 1 && posts.length <= 3, `${posts.length} posts`)
  assert.equal(worker.posts.length, posts.length)
  // Generous: the analysis works in slices of 25 ms.
  assert.ok(longest < 250, `${longest} ms`)
  await worker.deactivate()
})
