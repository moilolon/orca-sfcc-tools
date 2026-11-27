// The sandbox view over stubbed requests: what each state draws, picking a workspace by hand
// (a row, then the button), a refused action worded, a role that is not ready, and the changes the
// worker posts.
import { afterEach, assert, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { SandboxStatus } from './protocol'
import { DEPLOYING, FAILED, IDLE, UPLOADING, WATCHING } from './scenarios'
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

const button = (target: TestPanel, text: string) => target.find({ type: 'Button', text })

test('a full deploy is never the one-press main action, except to retry a failed one', async () => {
  let shown = await show(WATCHING)
  assert.equal(button(shown.panel, 'Deploy everything again')?.props.variant, 'outline')
  shown.panel.unmount()
  shown = await show(FAILED)
  assert.equal(button(shown.panel, 'Deploy everything again')?.props.variant, 'solid')
  panel = shown.panel
})

test('the owner’s row says what its upload is doing, a failure included', async () => {
  const notes = async (status: SandboxStatus) => {
    const shown = await show(status)
    const found = ['uploads', 'deploying', 'uploading…', 'failed'].filter((note) => shown.panel.find({ text: note }))
    shown.panel.unmount()
    return found
  }
  assert.deepEqual(await notes(WATCHING), ['uploads'])
  assert.deepEqual(await notes(DEPLOYING), ['deploying'])
  assert.deepEqual(await notes(UPLOADING), ['uploading…'])
  assert.deepEqual(await notes(FAILED), ['failed'])
})

test('the restart hint shows only for a watcher restored without a deploy', async () => {
  const hint = 'Changes made while the plugin was stopped are not uploaded until the next full deploy.'
  let shown = await show(WATCHING)
  assert.equal(shown.panel.find({ text: hint }), null, 'not after a fresh deploy')
  shown.panel.unmount()
  shown = await show({ ...WATCHING, upload: { ...WATCHING.upload, restored: true } })
  assert.ok(shown.panel.find({ text: hint }))
  panel = shown.panel
})

test('reload is offered only for a version whose last deploy ended, while it is watched', async () => {
  let shown = await show(WATCHING)
  assert.equal(button(shown.panel, 'Reload version')?.props.disabled, false)
  shown.panel.unmount()
  for (const status of [FAILED, DEPLOYING, { ...WATCHING, upload: { ...WATCHING.upload, deployed: false } }]) {
    shown = await show(status)
    assert.equal(button(shown.panel, 'Reload version')?.props.disabled, true, status.upload.state)
    shown.panel.unmount()
  }
  shown = await show({ ...FAILED, upload: { ...FAILED.upload, reason: 'deploy_needed' } })
  assert.match(shown.panel.summary().join(' | '), /Deploy needed/)
  assert.ok(shown.panel.find({ text: 'Deploy needed' }), 'the badge says it')
  panel = shown.panel
})

test('an owner Orca no longer lists is shown as not found, kept, and can be released', async () => {
  const { panel } = await show({ ...FAILED, upload: { ...FAILED.upload, reason: 'workspace_not_found' }, workspaces: IDLE.workspaces.filter((w) => w.id !== 'w-checkout') })
  assert.ok(panel.find({ text: 'Not found' }))
  assert.equal(button(panel, 'Deploy everything again')?.props.disabled, true)
  assert.equal(button(panel, 'Stop uploading')?.props.disabled, false)
})

test('a version left behind is deleted only after pressing it and then the button', async () => {
  const forgets: unknown[] = []
  const { panel } = await show({ ...WATCHING, leftovers: [{ workspaceId: 'w-old', codeVersion: 'ws-old-promo', checkable: true }] }, {
    'sandbox.forget': (input: { workspaceId: string }) => {
      forgets.push(input)
      return WATCHING
    }
  })
  assert.equal(button(panel, 'Delete this version'), null)
  await panel.press({ type: 'Link', text: 'ws-old-promo' })
  assert.deepEqual(forgets, [])
  await panel.press({ type: 'Button', text: 'Delete this version' })
  assert.deepEqual(forgets, [{ workspaceId: 'w-old' }])
})

test('a version whose dw.json is gone is listed as not deletable, and only forgotten by hand', async () => {
  const drops: unknown[] = []
  const { panel } = await show({ ...WATCHING, stuckDeletes: ['ws-old-checkout'] }, {
    'sandbox.dropDelete': (input: { codeVersion: string }) => {
      drops.push(input)
      return WATCHING
    }
  })
  assert.ok(panel.find({ text: 'Cannot delete' }))
  assert.ok(panel.find({ text: 'config gone' }))
  assert.equal(button(panel, 'Forget this version'), null, 'nothing on one press')
  await panel.press({ type: 'Link', text: 'ws-old-checkout' })
  assert.deepEqual(drops, [])
  await panel.press({ type: 'Button', text: 'Forget this version' })
  assert.deepEqual(drops, [{ codeVersion: 'ws-old-checkout' }])
  assert.equal(panel.find({ text: 'Cannot delete' }), null, 'the answer is drawn')
  assert.deepEqual(panel.errors, [])
})

test('a version left behind in a hidden project is shown, cannot be pressed, and the view says why', async () => {
  const { panel } = await show({ ...WATCHING, leftovers: [{ workspaceId: 'w-hidden', codeVersion: 'ws-archived-site', checkable: false }] })
  assert.ok(panel.find({ text: 'ws-archived-site' }))
  assert.equal(panel.find({ type: 'Link', text: 'ws-archived-site' }), null)
  assert.ok(panel.find({ text: 'hidden project' }))
  assert.ok(panel.find({ text: /hidden from Orca’s sidebar/ }))
  assert.equal(button(panel, 'Delete this version'), null)
})
