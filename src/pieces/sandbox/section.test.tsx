// The sandbox view over stubbed requests: what each state draws; the workspaces of the project in
// use listed first, the owner first among them, the others folded; picking one by hand (its *Use*
// button, then the confirming one); a refused action as a compact notice with the one button that
// helps; a role that is not ready in one line; and the changes the worker posts.
import { messages as pieceMessages } from './i18n'
import { NOTICE_MAX_CHARS } from '../../panel/ui'
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

const button = (target: TestPanel, text: string) => target.find({ type: 'Button', text })

/** The names of the workspace rows drawn, in order, and whether each sits in the folded group. */
function names(target: TestPanel): string[] {
  const wanted = ['checkout-fix', 'storefront', 'search-filters', 'storefront on build-01', 'handbook', 'release-tools']
  return target.findAll({ type: 'Text' }).map((item) => item.text).filter((text) => wanted.includes(text))
}

test('nothing uploads: one line says so, then the project’s workspaces with their branches, the others folded', async () => {
  const { panel } = await show(IDLE)
  assert.deepEqual(panel.errors, [])
  assert.ok(panel.find({ text: 'Nothing uploads: pick a workspace' }))
  assert.ok(panel.find({ text: 'Started' }))
  // Local ones by name, then the one on another machine; branches under each name.
  assert.deepEqual(names(panel).slice(0, 4), ['checkout-fix', 'search-filters', 'storefront', 'storefront on build-01'])
  assert.ok(panel.find({ text: 'bugfix/checkout-total' }))
  assert.ok(panel.find({ text: 'other machine' }))
  // Each local workspace has its own *Use* button; the remote one has none; a row is not a link.
  assert.equal(panel.findAll({ type: 'Button', text: 'Use' }).length, 3)
  // Workspaces of other projects are folded away, counted, and listed when opened.
  const others = panel.find({ type: 'Collapsible', label: 'Other projects (2)' })
  assert.ok(others)
  assert.equal(panel.find({ type: 'Text', text: 'handbook' }), null)
  await panel.toggle(others)
  assert.ok(panel.find({ type: 'Text', text: 'handbook' }))
  assert.equal(panel.findAll({ type: 'Button', text: 'Use' }).length, 5)
  assert.equal(panel.find({ type: 'Link', text: 'storefront' }), null)
  assert.equal(button(panel, 'Deploy and upload'), null, 'nothing is uploaded on one press')
})

test('a workspace is picked by hand: its Use button, then the confirming one; Cancel steps back', async () => {
  const { panel, picks } = await show(IDLE)
  const uses = panel.findAll({ type: 'Button', text: 'Use' })
  assert.equal(uses[0].props.tooltip, 'Upload from checkout-fix')
  await panel.press(uses[0])
  assert.deepEqual(picks, [], 'the first press only asks')
  assert.ok(button(panel, 'Deploy and upload'))
  await panel.press({ role: 'button', label: 'Cancel' })
  assert.equal(button(panel, 'Deploy and upload'), null)
  await panel.press(panel.findAll({ type: 'Button', text: 'Use' })[0])
  await panel.press({ type: 'Button', text: 'Deploy and upload' })
  assert.deepEqual(picks, [{ workspaceId: 'w-checkout' }])
  assert.ok(panel.find({ text: 'deploying…' }), 'the answer is drawn')
  assert.equal(button(panel, 'Deploy and upload'), null)
})

test('the owner comes first, set apart: its name, code version and upload state, then its actions', async () => {
  const { panel } = await show(WATCHING)
  assert.equal(names(panel)[0], 'checkout-fix')
  const owner = panel.find({ type: 'Text', text: 'checkout-fix' })
  assert.equal(owner?.props.weight, 'semibold')
  assert.ok(panel.find({ type: 'Code', text: 'ws-checkout-fix' }))
  assert.ok(panel.find({ text: 'uploads' }))
  assert.ok(panel.find({ text: /^Last upload/ }))
  assert.ok(panel.find({ text: /7 files/ }))
  for (const name of ['Deploy all', 'Reload', 'Stop uploading']) assert.equal(button(panel, name)?.props.disabled, false, name)
  // The owner has no *Use* of its own; the other local workspaces of its project do.
  assert.equal(panel.findAll({ type: 'Button', text: 'Use' }).length, 2)
  assert.ok(button(panel, 'Stop'), 'a started sandbox can be stopped beside its state')
})

test('an upload in each state: what it shows and which actions it offers', async () => {
  let shown = await show(DEPLOYING)
  assert.ok(shown.panel.find({ text: 'deploying…' }))
  assert.equal(button(shown.panel, 'Deploy all')?.props.disabled, true)
  shown.panel.unmount()

  shown = await show(FAILED)
  assert.match(shown.panel.summary().join(' | '), /Upload stopped/)
  assert.ok(shown.panel.find({ text: 'b2c ended with an error.' }))
  // One way to fix it, in the notice: deploy again.
  assert.equal(shown.panel.findAll({ type: 'Button', text: 'Deploy all' }).length, 1)
  panel = shown.panel
})

test('an action refused by the worker is a compact notice: what, why, and Retry', async () => {
  let reloads = 0
  const { panel } = await show(WATCHING, {
    'sandbox.reload': () => {
      reloads++
      throw hostError('sandbox_busy')
    }
  })
  await panel.press({ type: 'Button', text: 'Reload' })
  assert.match(panel.summary().join(' | '), /Reload failed/)
  assert.ok(panel.find({ text: 'The sandbox is busy with another operation.' }))
  await panel.press({ type: 'Button', text: 'Retry' })
  assert.equal(reloads, 2)
})

test('a refusal whose fix is in the setup leads there; one that cannot change is only dismissed', async () => {
  let shown = await show(WATCHING, {
    'sandbox.reload': () => {
      throw hostError('sandbox_not_ready')
    }
  })
  await shown.panel.press({ type: 'Button', text: 'Reload' })
  await shown.panel.press({ type: 'Button', text: 'Open setup' })
  assert.equal(shown.panel.persisted.plugin.view, 'setup')
  shown.panel.unmount()
  shown = await show(WATCHING, {
    'sandbox.stop': () => {
      throw hostError('sandbox_already_stopped')
    }
  })
  await shown.panel.press({ type: 'Button', text: 'Stop' })
  assert.equal(button(shown.panel, 'Retry'), null)
  await shown.panel.press({ type: 'Button', text: 'Dismiss' })
  assert.ok(!/Stop failed/.test(shown.panel.summary().join(' | ')))
  panel = shown.panel
})

test('a sandbox role that is not ready says so in one line, and nothing can be started or picked', async () => {
  const { panel } = await show({ ...IDLE, role: 'incomplete', sandbox: { state: 'unknown', following: null, reason: 'sandbox_not_ready', checkedAt: null } })
  assert.ok(panel.find({ text: 'Sandbox not set up' }))
  assert.equal(panel.find({ type: 'Callout' }), null, 'the status line says it already: no callout')
  assert.equal(button(panel, 'Start'), null)
  assert.ok(panel.findAll({ type: 'Button', text: 'Use' }).every((use) => use.props.disabled === true))
  await panel.press({ type: 'Button', text: 'Open setup' })
  assert.equal(panel.persisted.plugin.view, 'setup')
})

test('what the worker posts is drawn', async () => {
  const { panel } = await show(IDLE)
  await panel.post('sandbox.changed', WATCHING)
  assert.ok(panel.find({ text: 'uploads' }))
  await panel.post('sandbox.changed', { ...WATCHING, sandbox: { ...WATCHING.sandbox, state: 'stopped' } })
  assert.ok(button(panel, 'Start'))
})

test('in Spanish', async () => {
  const { panel } = await show(WATCHING, {}, 'es')
  assert.ok(panel.find({ text: 'sube' }))
  for (const name of ['Desplegar todo', 'Recargar', 'Dejar de subir', 'Usar']) assert.ok(button(panel, name), name)
  assert.ok(panel.find({ type: 'Collapsible', label: 'Otros proyectos (2)' }))
})

test('a full deploy is never a one-press main action', async () => {
  for (const status of [WATCHING, FAILED, { ...FAILED, upload: { ...FAILED.upload, reason: 'deploy_needed' } }]) {
    const shown = await show(status)
    const deploys = shown.panel.findAll({ type: 'Button', text: 'Deploy all' })
    assert.ok(deploys.length > 0)
    assert.ok(deploys.every((deploy) => deploy.props.variant === 'outline'), status.upload.state)
    shown.panel.unmount()
  }
})

test('the owner’s row says what its upload is doing, a failure included', async () => {
  const notes = async (status: SandboxStatus) => {
    const shown = await show(status)
    const found = ['uploads', 'deploying…', 'uploading…', 'failed'].filter((note) => shown.panel.find({ text: note }))
    shown.panel.unmount()
    return found
  }
  assert.deepEqual(await notes(WATCHING), ['uploads'])
  assert.deepEqual(await notes(DEPLOYING), ['deploying…'])
  assert.deepEqual(await notes(UPLOADING), ['uploading…'])
  assert.deepEqual(await notes(FAILED), ['failed'])
})

test('the restart hint shows, in one line, only for a watcher restored without a deploy', async () => {
  const hint = 'Changes while stopped wait for a deploy'
  let shown = await show(WATCHING)
  assert.equal(shown.panel.find({ text: hint }), null, 'not after a fresh deploy')
  shown.panel.unmount()
  shown = await show({ ...WATCHING, upload: { ...WATCHING.upload, restored: true } })
  assert.ok(shown.panel.find({ text: hint }))
  panel = shown.panel
})

test('reload is offered only for a version whose last deploy ended, while it is watched', async () => {
  let shown = await show(WATCHING)
  assert.equal(button(shown.panel, 'Reload')?.props.disabled, false)
  shown.panel.unmount()
  for (const status of [FAILED, DEPLOYING, { ...WATCHING, upload: { ...WATCHING.upload, deployed: false } }]) {
    shown = await show(status)
    assert.equal(button(shown.panel, 'Reload'), null, status.upload.state)
    shown.panel.unmount()
  }
  shown = await show({ ...FAILED, upload: { ...FAILED.upload, reason: 'deploy_needed' } })
  assert.match(shown.panel.summary().join(' | '), /Deploy needed/)
  assert.ok(shown.panel.find({ text: 'The last full deploy did not finish.' }))
  panel = shown.panel
})

test('an owner Orca no longer lists is shown as not found, kept, and can be released', async () => {
  let released = 0
  const { panel } = await show(
    { ...FAILED, upload: { ...FAILED.upload, reason: 'workspace_not_found' }, workspaces: IDLE.workspaces.filter((w) => w.id !== 'w-checkout') },
    {
      'sandbox.release': () => {
        released++
        return IDLE
      }
    }
  )
  assert.match(panel.summary().join(' | '), /Not in Orca/)
  assert.ok(panel.find({ type: 'Text', text: 'checkout-fix' }), 'its name is kept from the upload')
  assert.equal(button(panel, 'Deploy all'), null)
  assert.equal(panel.findAll({ type: 'Button', text: 'Stop uploading' }).length, 1)
  await panel.press({ type: 'Button', text: 'Stop uploading' })
  assert.equal(released, 1)
})

test('a version left behind is deleted only after its button and then the confirming one', async () => {
  const forgets: unknown[] = []
  const { panel } = await show({ ...WATCHING, leftovers: [{ workspaceId: 'w-old', codeVersion: 'ws-old-promo', checkable: true }] }, {
    'sandbox.forget': (input: { workspaceId: string }) => {
      forgets.push(input)
      return WATCHING
    }
  })
  assert.equal(button(panel, 'Delete version'), null)
  await panel.press({ role: 'button', label: 'Delete version' })
  assert.deepEqual(forgets, [])
  await panel.press({ type: 'Button', text: 'Delete version' })
  assert.deepEqual(forgets, [{ workspaceId: 'w-old' }])
})

test('a version whose dw.json is gone is listed as not deletable, and only forgotten by its button and then the confirming one', async () => {
  const drops: unknown[] = []
  const { panel } = await show({ ...WATCHING, stuckDeletes: ['ws-old-checkout'] }, {
    'sandbox.dropDelete': (input: { codeVersion: string }) => {
      drops.push(input)
      return WATCHING
    }
  })
  assert.ok(panel.find({ text: 'Cannot delete' }))
  assert.ok(panel.find({ text: 'ws-old-checkout' }))
  assert.ok(panel.find({ text: 'config gone' }))
  assert.equal(button(panel, 'Forget version'), null, 'nothing on one press')
  await panel.press({ role: 'button', label: 'Forget version' })
  assert.deepEqual(drops, [])
  await panel.press({ type: 'Button', text: 'Forget version' })
  assert.deepEqual(drops, [{ codeVersion: 'ws-old-checkout' }])
  assert.equal(panel.find({ text: 'Cannot delete' }), null, 'the answer is drawn')
  assert.deepEqual(panel.errors, [])
})

test('a version left behind in a hidden project is shown, with no button', async () => {
  const { panel } = await show({ ...WATCHING, leftovers: [{ workspaceId: 'w-hidden', codeVersion: 'ws-archived-site', checkable: false }] })
  assert.ok(panel.find({ text: 'ws-archived-site' }))
  assert.ok(panel.find({ text: 'hidden project' }))
  assert.equal(panel.find({ role: 'button', label: 'Delete version' }), null)
})

test('every text the view draws fits two lines of a 300 px sidebar, in both languages', () => {
  // Notifications, status bar items and command replies are not drawn in the panel.
  const notDrawn = /^(reply|notify|notice|bar|cmd)|^statusTooltip$|^notReadyBody$/
  for (const language of ['en', 'es'] as const) {
    for (const [key, value] of Object.entries(pieceMessages[language])) {
      if (!notDrawn.test(key)) assert.ok(value.length <= NOTICE_MAX_CHARS, `${language} ${key}: ${value.length} characters`)
    }
  }
})
