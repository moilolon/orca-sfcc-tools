// The sandbox view over stubbed requests: what each state draws, picking a workspace by hand
// (a row, then the button), a refused action worded, a role that is not ready, and the changes the
// worker posts.
import { afterEach, assert, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { SandboxStatus } from './protocol'
import { DEPLOYING, FAILED, IDLE, WATCHING } from './scenarios'
import { section } from './section'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']

let panel: TestPanel | undefined
afterEach(() => {
  panel?.unmount()
  panel = undefined
})

function view(locale = 'en') {
  return { setup: section.setup, default: () => section.render(locale) }
}

async function show(status: SandboxStatus, requests: Record<string, unknown> = {}, locale = 'en') {
  const picks: unknown[] = []
  panel = await mount(view(locale), {
    locale,
    host: mockHost({
      capabilities: CAPABILITIES,
      requests: {
        'sandbox.status': () => status,
        'sandbox.pick': (input: { workspaceId: string }) => {
          picks.push(input)
          return DEPLOYING
        },
        ...requests
      }
    })
  })
  return { panel, picks }
}

test('nothing uploads: the empty upload group, and the workspaces to pick from', async () => {
  const { panel } = await show(IDLE)
  assert.match(panel.summary().join(' | '), /Nothing uploads/)
  assert.ok(panel.find({ text: 'Started' }))
  assert.ok(panel.find({ type: 'Link', text: 'storefront' }))
  assert.ok(panel.find({ type: 'Link', text: 'checkout-fix' }))
  assert.equal(panel.find({ type: 'Link', text: 'storefront on build-01' }), null, 'a remote workspace cannot be picked')
  assert.ok(panel.find({ text: 'not available' }))
  assert.equal(panel.find({ type: 'Button', text: 'Upload from this one' }), null, 'nothing is uploaded on one press')
  assert.deepEqual(panel.errors, [])
})

test('a workspace is picked by hand: its row, then the button', async () => {
  const { panel, picks } = await show(IDLE)
  await panel.press({ type: 'Link', text: 'checkout-fix' })
  assert.deepEqual(picks, [], 'pressing the row only selects it')
  assert.ok(panel.find({ text: 'picked' }))
  await panel.press({ type: 'Button', text: 'Upload from this one' })
  assert.deepEqual(picks, [{ workspaceId: 'w-checkout' }])
  assert.ok(panel.find({ text: 'Deploying' }), 'the answer is drawn')
  assert.equal(panel.find({ type: 'Button', text: 'Upload from this one' }), null)
})

test('an upload in each state: what it shows and which actions it offers', async () => {
  let shown = await show(DEPLOYING)
  assert.ok(shown.panel.find({ text: 'Deploying' }))
  assert.equal(shown.panel.find({ type: 'Button', text: 'Deploy everything again' })?.props.disabled, true)
  shown.panel.unmount()

  shown = await show(WATCHING)
  assert.ok(shown.panel.find({ text: 'Watching' }))
  assert.ok(shown.panel.find({ text: 'ws-checkout-fix' }))
  assert.ok(shown.panel.find({ text: '7' }))
  assert.ok(shown.panel.find({ text: 'uploads' }))
  assert.equal(shown.panel.find({ type: 'Button', text: 'Deploy everything again' })?.props.disabled, false)
  assert.ok(shown.panel.find({ type: 'Button', text: 'Stop' }), 'a started sandbox can be stopped')
  shown.panel.unmount()

  shown = await show(FAILED)
  assert.match(shown.panel.summary().join(' | '), /The upload stopped/)
  assert.ok(shown.panel.find({ text: 'b2c ended with an error.' }))
  panel = shown.panel
})

test('an action refused by the worker is worded in the view', async () => {
  const { panel } = await show(WATCHING, {
    'sandbox.reload': () => {
      throw hostError('sandbox_busy')
    }
  })
  await panel.press({ type: 'Button', text: 'Reload version' })
  assert.ok(panel.find({ text: 'The sandbox is busy with another operation.' }))
})

test('a sandbox role that is not ready says so, and nothing can be started or picked', async () => {
  const { panel } = await show({ ...IDLE, role: 'incomplete', sandbox: { state: 'unknown', following: null, reason: 'sandbox_not_ready', checkedAt: null } })
  assert.match(panel.summary().join(' | '), /The sandbox is not ready/)
  assert.equal(panel.find({ type: 'Button', text: 'Start' }), null)
  await panel.press({ type: 'Link', text: 'storefront' })
  assert.equal(panel.find({ type: 'Button', text: 'Upload from this one' })?.props.disabled, true)
})

test('what the worker posts is drawn', async () => {
  const { panel } = await show(IDLE)
  await panel.post('sandbox.changed', WATCHING)
  assert.ok(panel.find({ text: 'Watching' }))
  await panel.post('sandbox.changed', { ...WATCHING, sandbox: { ...WATCHING.sandbox, state: 'stopped' } })
  assert.ok(panel.find({ type: 'Button', text: 'Start' }))
})

test('in Spanish', async () => {
  const { panel } = await show(WATCHING, {}, 'es')
  assert.ok(panel.find({ text: 'Vigilando' }))
  assert.ok(panel.find({ type: 'Button', text: 'Desplegar todo de nuevo' }))
})
