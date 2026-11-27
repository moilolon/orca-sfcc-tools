// What drawing the sandbox view costs with many workspaces: a long list is drawn a page at a time,
// a post that changes nothing draws nothing, and one that changes the state draws the view once.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { PAGE_SIZE } from '../../panel/ui'
import type { SandboxStatus } from './protocol'
import { WATCHING } from './scenarios'
import { section } from './section'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

/** 200 workspaces: 150 of the project in use, 50 of others; the owner among the first. */
function many(): SandboxStatus {
  const workspaces = Array.from({ length: 200 }, (_, i) => ({
    id: `w-${i}`,
    name: `workspace-${String(i).padStart(3, '0')}`,
    branch: `feature/change-${i}`,
    local: i % 10 !== 9,
    inProject: i < 150,
    codeVersion: null,
    owner: false
  }))
  return { ...WATCHING, upload: { ...WATCHING.upload, workspaceId: 'w-0', workspaceName: 'workspace-000' }, workspaces: workspaces.map((w) => (w.id === 'w-0' ? { ...w, owner: true } : w)) }
}

test('200 workspaces: a page drawn, few nodes, one draw per changed post and none for an unchanged one', async () => {
  const status = many()
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
    { host: mockHost({ capabilities: CAPABILITIES, requests: { 'sandbox.status': () => status } }) }
  )
  const firstMs = performance.now() - started
  assert.deepEqual(panel.errors, [])
  // A page of the project's workspaces is drawn, the rest behind *Show more*.
  assert.equal(panel.findAll({ type: 'Button', text: 'Use' }).length, PAGE_SIZE - panel.findAll({ type: 'Text', text: 'other machine' }).length)
  assert.ok(panel.find({ type: 'Button', text: `Show ${149 - PAGE_SIZE} more` }))
  const nodes = JSON.stringify(panel.tree()).split('"type"').length - 1

  // A post that changes nothing draws nothing.
  let before = draws
  await panel.post('sandbox.changed', many())
  const unchanged = draws - before

  // A post that changes the state draws once.
  before = draws
  const postStarted = performance.now()
  await panel.post('sandbox.changed', { ...many(), upload: { ...many().upload, files: 8 } })
  const postMs = performance.now() - postStarted
  const changed = draws - before

  console.log(`sandbox cost: first draw ${firstMs.toFixed(1)} ms, ${nodes} nodes; changed post ${postMs.toFixed(1)} ms, ${changed} draw(s); unchanged post ${unchanged} draw(s)`)
  assert.equal(unchanged, 0)
  assert.equal(changed, 1)
  assert.ok(nodes < 1500, `${nodes} nodes`)
})
