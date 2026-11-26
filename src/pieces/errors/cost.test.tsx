// What drawing the errors view costs with many errors: each list is drawn a page at a time, an
// answer that changes nothing draws nothing, and the worker's event draws the view once.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { Role } from '../../core/instances'
import { PAGE_SIZE } from '../../panel/ui'
import type { ErrorRow, RoleErrors } from './protocol'
import { section } from './section'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const NOW = Date.now()

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

/** 500 invented errors: 300 new, 200 seen, each with a few frames. */
function rows(extra = 0): ErrorRow[] {
  return Array.from({ length: 500 }, (_, i) => ({
    signature: `s${i}`,
    firstSeen: NOW - 3_600_000,
    lastSeen: NOW - i * 1000,
    count: i + 1 + (i === 0 ? extra : 0),
    markedAt: i < 300 ? null : NOW - 1000,
    message: `TypeError: value ${i} is undefined in <code> for order #`,
    logger: 'custom.Cart',
    pipeline: 'Cart-Show',
    level: 'ERROR',
    frames: [{ file: `app_example/cartridge/scripts/s${i}.js`, function: 'run', line: 12, openable: true, path: `cartridges/app_example/cartridge/scripts/s${i}.js`, script: true }]
  }))
}

test('500 errors: a page of each list drawn, few nodes, one draw per change and none for an unchanged answer', async () => {
  let extra = 0
  const answer = (role: Role): RoleErrors => ({ role, state: 'ready', reading: false, lastRead: NOW, error: null, missedSince: null, intervalMinutes: 5, rows: rows(extra) })
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
    { host: mockHost({ capabilities: CAPABILITIES, requests: { 'errors.list': ({ role }: { role: Role }) => answer(role) } }) }
  )
  const firstMs = performance.now() - started
  assert.deepEqual(panel.errors, [])
  assert.equal(panel.findAll({ type: 'Link' }).length, PAGE_SIZE)
  assert.ok(panel.find({ type: 'Button', text: `Show ${300 - PAGE_SIZE} more` }))
  const nodes = JSON.stringify(panel.tree()).split('"type"').length - 1

  // The worker says something changed, but the answer is the same: nothing is drawn.
  let before = draws
  await panel.post('errors.changed', { role: 'sandbox', newCount: 300 })
  const unchanged = draws - before

  // A changed answer draws once.
  extra = 1
  before = draws
  const postStarted = performance.now()
  await panel.post('errors.changed', { role: 'sandbox', newCount: 300 })
  const postMs = performance.now() - postStarted
  const changed = draws - before

  console.log(`errors cost: first draw ${firstMs.toFixed(1)} ms, ${nodes} nodes; changed event ${postMs.toFixed(1)} ms, ${changed} draw(s); unchanged event ${unchanged} draw(s)`)
  assert.equal(unchanged, 0)
  assert.equal(changed, 1)
  assert.ok(nodes < 1500, `${nodes} nodes`)
})
