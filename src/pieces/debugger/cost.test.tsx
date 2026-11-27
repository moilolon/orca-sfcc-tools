// What drawing the debugger view costs with a long script open: its lines are computed once per
// change, a page at a time, a post that changes nothing draws nothing, and a breakpoint toggled
// draws the view once.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { DebuggerScripts, DebuggerSource, DebuggerState } from './protocol'
import { builds, section, WINDOW_LINES } from './section'
import { treeCost, VIEW_BUDGET } from '../../panel/panel'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const PATH = 'cartridges/app_example/cartridge/scripts/long.js'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

const STATE: DebuggerState = { status: 'attached', reason: null, message: null, sandbox: 'ready', workspace: 'ok', workspaceId: 'w-example', breakpoints: [{ path: PATH, lines: [{ line: 10, verified: true }] }], threads: [], threadId: null, frames: [] }
/** A 3,000-line invented script, each line of ordinary length. */
const SOURCE: DebuggerSource = { path: PATH, truncated: false, lines: Array.from({ length: 3000 }, (_, i) => `    var value${i} = helpers.compute(request, ${i}); // step ${i}`) }
/** 5,000 invented scripts in 20 cartridges. */
const SCRIPTS: DebuggerScripts = {
  cartridges: Array.from({ length: 20 }, (_, c) => ({ name: `app_${c}`, path: `cartridges/app_${c}`, files: Array.from({ length: 250 }, (_, f) => `cartridges/app_${c}/cartridge/scripts/folder${f % 10}/file${f}.js`) })),
  truncated: false
}

test('a 3,000-line script: a window of lines, one draw per change and none for an unchanged post', async () => {
  let state = STATE
  let draws = 0
  const started = performance.now()
  panel = await mount(
    {
      setup: section.setup,
      default: () => {
        draws++
        return section.render('en')
      }
    },
    {
      host: mockHost({
        capabilities: CAPABILITIES,
        requests: {
          'debugger.state': () => state,
          'debugger.scripts': () => SCRIPTS,
          'debugger.source': () => SOURCE,
          'debugger.breakpoint': (input: { line: number; on: boolean }) => {
            state = { ...state, breakpoints: [{ path: PATH, lines: input.on ? [...state.breakpoints[0].lines, { line: input.line, verified: null }] : [] }] }
            return state
          }
        }
      }),
      persisted: { plugin: { debuggerScript: PATH } }
    }
  )
  const firstMs = performance.now() - started
  assert.deepEqual(panel.errors, [])
  const table = { type: 'Table' } as const
  assert.equal(panel.rowsOf(table).length, WINDOW_LINES)
  const bytes = JSON.stringify(panel.tree()).length

  // A post that changes nothing draws nothing.
  let before = draws
  await panel.post('debugger.state', state)
  const unchanged = draws - before

  // A click on a line: one request, the view drawn once with the answer.
  before = draws
  const clickStarted = performance.now()
  await panel.selectRows(table, ['20'])
  const clickMs = performance.now() - clickStarted
  const clicked = draws - before
  assert.deepEqual(panel.valueOf(table), ['10', '20'])

  // A search over 5,000 scripts.
  await panel.press({ role: 'button', label: 'All scripts' })
  before = draws
  const searchStarted = performance.now()
  await panel.type({ type: 'Input', label: 'Find a script' }, 'file17')
  const searchMs = performance.now() - searchStarted
  const searched = draws - before

  console.log(
    `debugger cost: first draw with 3,000 lines ${firstMs.toFixed(1)} ms, ${Math.round(bytes / 1024)} KiB drawn; click on a line ${clickMs.toFixed(1)} ms, ${clicked} draw(s); unchanged post ${unchanged} draw(s); search of 5,000 scripts ${searchMs.toFixed(1)} ms, ${searched} draw(s)`
  )
  assert.equal(unchanged, 0)
  assert.ok(clicked <= 2, `${clicked} draws`)
  assert.ok(bytes < 400 * 1024, `${bytes} bytes`)
})

test('a 10,000-line script of the longest lines, paged from the first line to the last, stays under the view’s budget', async () => {
  const LONG: DebuggerSource = { path: PATH, truncated: false, lines: Array.from({ length: 10_000 }, (_, i) => `${String(i).padStart(6, '0')} ${'x'.repeat(233)}`) }
  panel = await mount(
    { setup: section.setup, default: () => section.render('en') },
    {
      host: mockHost({ capabilities: CAPABILITIES, requests: { 'debugger.state': () => STATE, 'debugger.scripts': () => SCRIPTS, 'debugger.source': () => LONG } }),
      persisted: { plugin: { debuggerScript: PATH } }
    }
  )
  const table = { type: 'Table' } as const
  let largest = 0
  let pages = 0
  for (;;) {
    // Measured the way Orca measures what it receives.
    const size = treeCost(panel.tree()).bytes
    largest = Math.max(largest, size)
    assert.ok(size < VIEW_BUDGET.bytes, `page ${pages}: ${size} bytes`)
    assert.ok(panel.rowsOf(table).length <= WINDOW_LINES)
    const next = panel.find({ role: 'button', label: 'Next lines' })
    if (!next || next.disabled) break
    await panel.press(next)
    pages++
  }
  assert.equal(panel.rowsOf(table).at(-1), '10000', 'it reached the last line')
  console.log(`debugger window: 10,000 lines of 240 characters in ${pages + 1} windows, the largest tree ${Math.round(largest / 1024)} KiB of a ${VIEW_BUDGET.bytes / 1024} KiB budget, by Orca's measure`)
})

test('a cartridge of 20,000 scripts in one folder, open: its tree is built once per change of the list, never on each draw, in linear time', async () => {
  // Orca's `derived` builds on every draw: the tree of one large cartridge open took a tenth of a
  // second at each change of the debugger's state (its folders were grouped in n² copies), which a
  // loaded machine turns into the seconds after which Orca suspends a panel.
  let state = STATE
  const BIG: DebuggerScripts = { cartridges: [{ name: 'app_big', path: 'cartridges/app_big', files: Array.from({ length: 20_000 }, (_, f) => `cartridges/app_big/cartridge/scripts/file${f}.js`) }], truncated: false }
  let draws = 0
  const started = performance.now()
  panel = await mount(
    {
      setup: section.setup,
      default: () => {
        draws++
        return section.render('en')
      }
    },
    {
      host: mockHost({ capabilities: CAPABILITIES, requests: { 'debugger.state': () => state, 'debugger.scripts': () => BIG } }),
      persisted: { plugin: { debuggerWorkspace: 'w-example', debuggerScriptsOpen: ['c:cartridges/app_big', 'd:cartridges/app_big/cartridge', 'd:cartridges/app_big/cartridge/scripts'] } }
    }
  )
  const firstMs = performance.now() - started
  assert.deepEqual(panel.errors, [])
  const tree = { type: 'Tree' } as const
  assert.ok(panel.find(tree))
  const built = builds.scripts

  // Ten posts that change the session, not the scripts: ten draws, the tree built no more.
  const before = draws
  const postsStarted = performance.now()
  for (let i = 0; i < 10; i++) {
    state = { ...state, status: i % 2 ? 'attached' : 'connecting' }
    await panel.post('debugger.state', state)
  }
  const perPostMs = (performance.now() - postsStarted) / 10
  assert.equal(draws - before, 10)
  assert.equal(builds.scripts, built)

  // A folder's next page builds it once more, in linear time.
  const pageStarted = performance.now()
  await panel.activateItem(tree, 'm:d:cartridges/app_big/cartridge/scripts')
  const pageMs = performance.now() - pageStarted
  assert.equal(builds.scripts, built + 1)

  console.log(`debugger tree of 20,000 scripts: first draw ${firstMs.toFixed(1)} ms; a post that leaves the scripts alone ${perPostMs.toFixed(1)} ms; a page more ${pageMs.toFixed(1)} ms`)
  // Generous bounds: before, each was 0.5 s or more on the same machine.
  assert.ok(perPostMs < 50, `${perPostMs} ms per post`)
  assert.ok(pageMs < 250, `${pageMs} ms for a page`)
})

test('an open script’s rows are built once per change of the script, its window or its marks, never on each draw', async () => {
  let state = STATE
  panel = await mount(
    { setup: section.setup, default: () => section.render('en') },
    {
      host: mockHost({
        capabilities: CAPABILITIES,
        requests: {
          'debugger.state': () => state,
          'debugger.scripts': () => SCRIPTS,
          'debugger.source': () => SOURCE,
          'debugger.breakpoint': (input: { line: number; on: boolean }) => {
            state = { ...state, breakpoints: [{ path: PATH, lines: [...state.breakpoints[0].lines, { line: input.line, verified: null }] }] }
            return state
          }
        }
      }),
      persisted: { plugin: { debuggerScript: PATH } }
    }
  )
  const table = { type: 'Table' } as const
  assert.equal(panel.rowsOf(table).length, WINDOW_LINES)
  const built = builds.rows
  for (let i = 0; i < 5; i++) {
    state = { ...state, status: i % 2 ? 'attached' : 'connecting' }
    await panel.post('debugger.state', state)
  }
  assert.equal(builds.rows, built)
  // A new breakpoint on the script changes its marks: built once more.
  await panel.selectRows(table, ['20'])
  assert.equal(builds.rows, built + 1)
})
