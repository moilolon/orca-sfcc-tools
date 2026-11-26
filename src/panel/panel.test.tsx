// The panel over a stubbed worker: the setup view for each answer of core.status, in English and
// in Spanish; the bar of views, the remembered view and the status line; and what a piece's
// section can do without the panel knowing the piece.
//
// Nothing here says what the pieces of the plugin are today. The panel is tested over sections
// written in this file, and the plugin's own panel only against what `SECTIONS` and the piece
// ids say, so a phase that delivers a piece from its folder never has to edit this file.
import { atom, plugin, read, set, Text } from 'orca'
import { afterEach, assert, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { PIECE_IDS, type PanelSection } from '../core/piece'
import type { CoreStatus } from '../protocol'
import * as panelModule from './panel'
import { createPanel } from './panel'
import { CHECKS } from './checks'
import { mergeScenarios, READY_STATUS } from './scenarios'
import { SECTIONS } from './sections'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

const PIECES: CoreStatus['pieces'] = [...PIECE_IDS]
const FOUND: CoreStatus = {
  b2c: { found: true, version: '9.8.7' },
  config: 'ok',
  instances: { sandbox: 'ready', development: 'ready', staging: 'incomplete', production: 'absent' },
  pieces: PIECES
}
const ALL_READY: CoreStatus = { ...FOUND, instances: { sandbox: 'ready', development: 'ready', staging: 'ready', production: 'ready' } }
const MISSING: CoreStatus = {
  b2c: { found: false, version: null, reason: 'b2c_not_found' },
  config: 'missing',
  instances: { sandbox: 'absent', development: 'absent', staging: 'absent', production: 'absent' },
  pieces: PIECES
}

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']

function hostAnswering(status: CoreStatus | Error, settings: Record<string, string> = {}) {
  return mockHost({
    capabilities: CAPABILITIES,
    settings,
    requests: {
      'core.status': () => {
        if (status instanceof Error) throw status
        return status
      }
    }
  })
}

function requestsOf(target: TestPanel): number {
  return target.host.calls.filter((call) => call.method === 'plugin.request').length
}

/** A section that draws nothing, as a piece not yet delivered has it. */
function stub(id: PanelSection['id'], en: string, es: string): PanelSection {
  return { id, icon: 'code', title: (locale) => (locale.startsWith('es') ? es : en), delivered: false, hasView: true, render: () => null }
}

/** A delivered section with a view whose body is one text. */
function viewOf(id: PanelSection['id'], en: string, es: string, body: string | null = `${en} body`): PanelSection {
  return { id, icon: 'cloud', title: (locale) => (locale.startsWith('es') ? es : en), delivered: true, hasView: true, render: () => (body === null ? null : <Text>{body}</Text>) }
}

/** The panel over sections of this file: what core draws, whatever the pieces are. */
function panelOver(sections: readonly PanelSection[]) {
  const { setup, Panel } = createPanel(sections)
  return { default: Panel, setup }
}

/** No piece delivered: the setup view alone. */
const CORE = panelOver([stub('errors', 'Errors', 'Errores'), stub('debugger', 'Debugger', 'Depurador')])

/** Two views, a delivered piece with no view, and one not delivered. */
const VIEWS = panelOver([
  { ...stub('isml', 'ISML', 'ISML'), delivered: true, hasView: false },
  viewOf('sandbox', 'Sandbox and upload', 'Sandbox y subida'),
  viewOf('errors', 'Errors', 'Errores'),
  stub('debugger', 'Debugger', 'Depurador')
])

// ---------------------------------------------------------------------------------------------
// The setup view, alone while no piece is delivered

test('with no piece delivered, the setup view is the whole panel and there is no bar', async () => {
  panel = await mount(CORE, { host: hostAnswering(FOUND), locale: 'en' })
  assert.equal(panel.find({ type: 'Tabs' }), null)
  assert.equal(panel.find({ role: 'tab' }), null)
  assert.ok(panel.find({ type: 'Heading', text: 'Setup' }))
  assert.ok(panel.find({ role: 'button', label: 'Refresh' }))
  assert.ok(panel.find({ text: 'Found, version 9.8.7' }))
  assert.equal(panel.findAll({ text: 'Ready' }).length, 2)
  assert.equal(panel.findAll({ text: 'Incomplete' }).length, 1)
  assert.equal(panel.findAll({ text: 'Not configured' }).length, 1)
  // An incomplete and an absent environment are explained.
  assert.ok(panel.find({ text: /^Incomplete: dw\.json has the host/ }))
  assert.ok(panel.find({ text: /^Not configured: dw\.json has no host for it/ }))
  for (const name of ['Sandbox', 'Development', 'Staging', 'Production']) assert.ok(panel.find({ text: name }), name)
  // A piece not delivered is not shown at all, and the empty list of pieces is not drawn.
  for (const name of ['Errors', 'Debugger', 'Pieces', 'Coming']) assert.equal(panel.find({ text: name }), null, name)
  assert.equal(panel.find({ text: /No dw\.json/ }), null)
  assert.equal(panel.find({ text: /could not start/ }), null)
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
})

test('asks the worker in the panel’s language', async () => {
  const host = hostAnswering(FOUND)
  panel = await mount(CORE, { host, locale: 'es-ES' })
  assert.deepEqual(host.calls.filter((call) => call.method === 'plugin.request').map((call) => call.params), [{ name: 'core.status', input: { locale: 'es-ES' }, timeoutMs: 60_000 }])
})

test('says where the configuration file is read from, and never its path', async () => {
  panel = await mount(CORE, { host: hostAnswering(FOUND), locale: 'en' })
  assert.ok(panel.find({ text: 'Workspace dw.json' }))
  assert.ok(panel.find({ text: /^dw\.json at the root of the workspace that uploads/ }))
  assert.ok(panel.find({ text: /Hosts and credentials are never shown\.$/ }))
  assert.ok(panel.find({ text: 'Read' }))
  panel.unmount()
  const path = 'C:\\work\\shop\\config\\other-dw.json'
  panel = await mount(CORE, { host: hostAnswering(FOUND, { configFile: path }), locale: 'en' })
  assert.ok(panel.find({ text: 'File in Settings' }))
  assert.ok(panel.find({ text: /^The file named in Settings → SFCC Tools → Configuration file\./ }))
  assert.equal(panel.find({ text: /other-dw|work\\shop/ }), null)
  panel.unmount()
  panel = await mount(CORE, { host: hostAnswering(FOUND, { configFile: path }), locale: 'es' })
  assert.ok(panel.find({ text: 'Fichero de Ajustes' }))
  assert.ok(panel.find({ text: 'Leído' }))
})

test('says when b2c is missing, and why, pointing at the setting; and that there is no dw.json', async () => {
  panel = await mount(CORE, { host: hostAnswering(MISSING), locale: 'en' })
  // b2c and the file are both not found.
  assert.equal(panel.findAll({ text: 'Not found' }).length, 2)
  assert.match(panel.summary().join('\n'), /The b2c CLI is not available/)
  assert.ok(panel.find({ text: 'The b2c CLI was not found.' }))
  assert.ok(panel.find({ text: /b2c path/ }))
  assert.match(panel.summary().join('\n'), /No dw\.json/)
  assert.ok(panel.find({ text: /^No dw\.json was found for the workspace/ }))
  assert.equal(panel.findAll({ text: 'Not configured' }).length, 4)
  // Without a file, four absences need no explanation of their keys.
  assert.equal(panel.find({ text: /^Incomplete:/ }), null)
  assert.equal(panel.find({ text: /^Not configured:/ }), null)
})

test('says a dw.json that is not JSON cannot be read, instead of four silent absences', async () => {
  panel = await mount(CORE, { host: hostAnswering({ ...MISSING, b2c: FOUND.b2c, config: 'invalid' }), locale: 'en' })
  assert.match(panel.summary().join('\n'), /dw\.json cannot be read/)
  assert.ok(panel.find({ text: 'The file is not valid JSON, so no environment can be read from it.' }))
  assert.ok(panel.find({ text: 'Not valid JSON' }))
  assert.equal(panel.find({ text: /^No dw\.json was found/ }), null)
  panel.unmount()
  panel = await mount(CORE, { host: hostAnswering({ ...MISSING, config: 'invalid' }), locale: 'es' })
  assert.match(panel.summary().join('\n'), /No se puede leer dw\.json/)
  assert.ok(panel.find({ text: /^El fichero no es JSON válido/ }))
})

test('in Spanish', async () => {
  panel = await mount(CORE, { host: hostAnswering(MISSING), locale: 'es' })
  assert.ok(panel.find({ type: 'Heading', text: 'Configuración' }))
  assert.equal(panel.findAll({ text: 'No encontrado' }).length, 2)
  assert.ok(panel.find({ text: 'No se ha encontrado el CLI b2c.' }))
  assert.equal(panel.findAll({ text: 'Sin configurar' }).length, 4)
  assert.match(panel.summary().join('\n'), /No hay dw\.json/)
  assert.ok(panel.find({ text: 'Desarrollo' }))
  panel.unmount()
  panel = await mount(CORE, { host: hostAnswering(FOUND), locale: 'es' })
  assert.equal(panel.findAll({ text: 'Listo' }).length, 2)
  assert.equal(panel.findAll({ text: 'Incompleto' }).length, 1)
  assert.equal(panel.findAll({ text: 'Sin configurar' }).length, 1)
  assert.ok(panel.find({ text: /^Incompleto: dw\.json tiene el host/ }))
  assert.ok(panel.find({ text: /^Sin configurar: dw\.json no tiene host/ }))
  assert.ok(panel.find({ text: 'dw.json del workspace' }))
})

test('words a host error, a timeout included, and offers to try again', async () => {
  panel = await mount(CORE, { host: hostAnswering(hostError('timeout')), locale: 'en' })
  assert.match(panel.summary().join('\n'), /Something went wrong/)
  assert.ok(panel.find({ text: 'The plugin took too long to answer.' }))
  assert.ok(panel.find({ role: 'button', label: 'Refresh' }))
  await panel.press({ role: 'button', text: 'Try again' })
  assert.equal(requestsOf(panel), 2)
  panel.unmount()
  panel = await mount(CORE, { host: hostAnswering(hostError('timeout')), locale: 'es' })
  assert.ok(panel.find({ text: 'El plugin ha tardado demasiado en responder.' }))
  assert.ok(panel.find({ role: 'button', text: 'Reintentar' }))
})

test('words a failure that has no code as the panel’s own action_failed, in both languages', async () => {
  panel = await mount(CORE, { host: hostAnswering(new Error('no code here')), locale: 'en' })
  assert.ok(panel.find({ text: 'The action could not be completed.' }))
  assert.equal(panel.find({ text: /action_failed|no code here/ }), null)
  panel.unmount()
  panel = await mount(CORE, { host: hostAnswering(new Error('no code here')), locale: 'es' })
  assert.ok(panel.find({ text: 'No se ha podido completar la acción.' }))
})

// ---------------------------------------------------------------------------------------------
// The bar of views

function tabs(target: TestPanel): string[] {
  return target.findAll({ role: 'tab' }).map((tab) => tab.label ?? '')
}

test('the bar holds one view per delivered piece that has one, then the setup view', async () => {
  panel = await mount(VIEWS, { host: hostAnswering(FOUND), locale: 'en' })
  assert.deepEqual(tabs(panel), ['Sandbox and upload', 'Errors', 'Setup'])
  // The first view is open, with its body.
  assert.equal(panel.valueOf({ type: 'Tabs' }), 'sandbox')
  assert.ok(panel.find({ text: 'Sandbox and upload body' }))
  assert.equal(panel.find({ text: 'Errors body' }), null)
  // A piece with no view and one not delivered are not in the bar.
  assert.equal(panel.find({ text: /ISML|Debugger/ }), null)
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
  panel.unmount()
  panel = await mount(VIEWS, { host: hostAnswering(FOUND), locale: 'es' })
  assert.deepEqual(tabs(panel), ['Sandbox y subida', 'Errores', 'Configuración'])
})

test('the setup view lists the delivered pieces discreetly, those with no view included', async () => {
  panel = await mount(VIEWS, { host: hostAnswering(FOUND), locale: 'en' })
  await panel.select({ type: 'Tabs' }, 'setup')
  assert.ok(panel.find({ text: 'Pieces' }))
  for (const name of ['ISML', 'Sandbox and upload', 'Errors']) assert.ok(panel.find({ text: name }), name)
  assert.equal(panel.findAll({ text: 'Available' }).length, 3)
  assert.equal(panel.find({ text: 'Debugger' }), null)
  // The setup itself is there, and the status line too.
  assert.ok(panel.find({ text: 'Found, version 9.8.7' }))
  assert.ok(panel.find({ text: 'b2c 9.8.7' }))
})

test('the last view is remembered, and one that no longer exists falls back to the first', async () => {
  panel = await mount(VIEWS, { host: hostAnswering(FOUND), locale: 'en' })
  await panel.select({ type: 'Tabs' }, 'errors')
  assert.ok(panel.find({ text: 'Errors body' }))
  assert.equal(panel.persisted.plugin.view, 'errors')
  panel.unmount()
  panel = await mount(VIEWS, { host: hostAnswering(FOUND), locale: 'en', persisted: { plugin: { view: 'errors' } } })
  assert.equal(panel.valueOf({ type: 'Tabs' }), 'errors')
  assert.ok(panel.find({ text: 'Errors body' }))
  panel.unmount()
  panel = await mount(VIEWS, { host: hostAnswering(FOUND), locale: 'en', persisted: { plugin: { view: 'setup' } } })
  assert.equal(panel.valueOf({ type: 'Tabs' }), 'setup')
  panel.unmount()
  // A piece that is gone, or one with no view, is not a view to open.
  for (const view of ['debugger', 'isml']) {
    panel = await mount(VIEWS, { host: hostAnswering(FOUND), locale: 'en', persisted: { plugin: { view } } })
    assert.equal(panel.valueOf({ type: 'Tabs' }), 'sandbox', view)
    panel.unmount()
  }
  panel = undefined
})

test('a delivered piece with nothing to show draws an empty state with a line of guidance', async () => {
  panel = await mount(panelOver([viewOf('errors', 'Errors', 'Errores', null)]), { host: hostAnswering(FOUND), locale: 'en' })
  const empty = panel.find({ type: 'EmptyState' })
  assert.equal(empty?.label, 'Nothing to show yet')
  assert.equal(empty?.props.description, 'This piece has nothing to show at the moment.')
  panel.unmount()
  panel = await mount(panelOver([viewOf('errors', 'Errors', 'Errores', null)]), { host: hostAnswering(FOUND), locale: 'es' })
  assert.equal(panel.find({ type: 'EmptyState' })?.label, 'Nada que mostrar todavía')
})

// ---------------------------------------------------------------------------------------------
// The status line

/** The status line's attention button, the one with a warning icon, or null. */
function attentionButton(target: TestPanel) {
  return target.findAll({ role: 'button' }).find((button) => button.props.icon === 'warning') ?? null
}

function attentionOf(target: TestPanel): string | null {
  return attentionButton(target)?.text ?? null
}

test('the status line shows each environment by tone and the b2c version', async () => {
  panel = await mount(VIEWS, { host: hostAnswering(FOUND), locale: 'en' })
  const tones = Object.fromEntries(panel.findAll({ type: 'Badge' }).map((badge) => [badge.text, badge.props.tone]))
  assert.deepEqual(tones, { SBX: 'success', DEV: 'success', STG: 'warning', PRD: 'neutral' })
  assert.ok(panel.find({ text: 'b2c 9.8.7' }))
  assert.ok(panel.find({ role: 'button', label: 'Refresh' }))
  panel.unmount()
  panel = await mount(VIEWS, { host: hostAnswering(FOUND), locale: 'es' })
  assert.deepEqual(panel.findAll({ type: 'Badge' }).map((badge) => badge.text), ['SBX', 'DEV', 'STG', 'PRD'])
  assert.ok(panel.find({ role: 'button', label: 'Actualizar' }))
})

test('with everything ready the status line asks for nothing', async () => {
  panel = await mount(VIEWS, { host: hostAnswering(ALL_READY), locale: 'en' })
  assert.equal(attentionButton(panel), null)
  assert.equal(panel.findAll({ type: 'Badge' }).filter((badge) => badge.props.tone === 'success').length, 4)
})

test('the status line says what needs attention, by tone, and leads to the setup view', async () => {
  const cases: { status: CoreStatus | Error; en: string; es: string; tone: string }[] = [
    { status: hostError('timeout'), en: 'Setup unreadable', es: 'Configuración ilegible', tone: 'danger' },
    { status: { ...MISSING, b2c: FOUND.b2c, config: 'invalid' }, en: 'dw.json invalid', es: 'dw.json no válido', tone: 'danger' },
    { status: { ...ALL_READY, b2c: MISSING.b2c }, en: 'b2c not found', es: 'b2c no encontrado', tone: 'danger' },
    { status: { ...MISSING, b2c: FOUND.b2c }, en: 'No dw.json', es: 'No hay dw.json', tone: 'warning' },
    { status: FOUND, en: 'Incomplete environment', es: 'Entorno incompleto', tone: 'warning' }
  ]
  for (const { status, en, es, tone } of cases) {
    panel = await mount(VIEWS, { host: hostAnswering(status), locale: 'en' })
    const button = attentionButton(panel)
    assert.equal(button?.text, en)
    assert.equal(button?.props.tone, tone, en)
    await panel.press({ role: 'button', text: en })
    assert.equal(panel.valueOf({ type: 'Tabs' }), 'setup', en)
    // The setup view does not point at itself.
    assert.equal(attentionButton(panel), null, en)
    panel.unmount()
    panel = await mount(VIEWS, { host: hostAnswering(status), locale: 'es' })
    assert.equal(attentionOf(panel), es)
    panel.unmount()
  }
  panel = undefined
})

test('b2c missing shows in the status line as a badge in the failed tone', async () => {
  panel = await mount(VIEWS, { host: hostAnswering({ ...ALL_READY, b2c: MISSING.b2c }), locale: 'en' })
  assert.equal(panel.find({ type: 'Badge', text: 'b2c' })?.props.tone, 'danger')
  assert.equal(panel.find({ text: /^b2c \d/ }), null)
})

// ---------------------------------------------------------------------------------------------
// What a piece does from its own folder

/**
 * A section as a delivered piece would write it: its own state, its own event, its own body.
 * Its event and request are named `probe.*`, after no piece: a name that starts with the id of
 * a piece belongs to the piece that declares it, with its own payload type, and using it here
 * would break this file the day that piece is delivered (a test in src/core/piece.test.ts
 * keeps them out).
 */
function liveSection(log: string[]): PanelSection {
  const count = atom(0)
  return {
    id: 'sandbox',
    icon: 'cloud',
    title: (locale) => (locale.startsWith('es') ? 'Sandbox y subida' : 'Sandbox and upload'),
    delivered: true,
    hasView: true,
    setup(ctx) {
      log.push(`setup ${ctx.panel.id}`)
      ctx.subscriptions.push(plugin.on('probe.changed', () => set(count, read(count) + 1)))
      ctx.subscriptions.push({ dispose: () => log.push('subscription disposed') })
      return () => log.push('cleanup ran')
    },
    render: () => <Text>{`uploads: ${read(count)}`}</Text>
  }
}

test('a section listens to its own events through its setup, and is disposed with the panel', async () => {
  const log: string[] = []
  panel = await mount(panelOver([liveSection(log)]), { host: hostAnswering(FOUND), locale: 'en', panelId: 'sfcc' })
  assert.deepEqual(log, ['setup sfcc'])
  assert.ok(panel.find({ text: 'uploads: 0' }))
  await panel.post('probe.changed', {})
  await panel.post('probe.changed', {})
  assert.ok(panel.find({ text: 'uploads: 2' }))
  // The panel still hears its own event beside the section's.
  await panel.post('core.changed', { key: 'b2cPath' })
  assert.equal(requestsOf(panel), 2)
  assert.deepEqual(panel.errors, [])
  panel.unmount()
  panel = undefined
  assert.deepEqual(log.slice(1).sort(), ['cleanup ran', 'subscription disposed'])
})

test('a section whose setup throws shows as not started until the panel is reopened', async () => {
  const log: string[] = []
  let fails = true
  const failing: PanelSection = {
    id: 'errors',
    icon: 'warning',
    title: (locale) => (locale.startsWith('es') ? 'Errores' : 'Errors'),
    // It says it is delivered: the panel must not take its word once it has failed to start.
    delivered: true,
    hasView: true,
    setup() {
      if (fails) throw new Error('broken setup')
    },
    render: () => <Text>errors body</Text>
  }
  const module = panelOver([failing, liveSection(log)])
  panel = await mount(module, { host: hostAnswering(ALL_READY), locale: 'en' })
  const shown = async () => {
    assert.ok(panel, 'mounted')
    // Its view stays in the bar and says why it is empty; its body is not drawn.
    assert.deepEqual(tabs(panel), ['Errors', 'Sandbox and upload', 'Setup'])
    await panel.select({ type: 'Tabs' }, 'errors')
    assert.match(panel.summary().join('\n'), /Errors could not start/)
    assert.ok(panel.find({ text: /^Its part of this panel failed to start/ }))
    assert.equal(panel.find({ text: 'errors body' }), null)
    assert.equal(attentionOf(panel), 'A piece did not start')
    // The other section started and draws its body.
    await panel.select({ type: 'Tabs' }, 'sandbox')
    assert.ok(panel.find({ text: 'uploads: 0' }))
    // The setup view lists it as not started.
    await panel.select({ type: 'Tabs' }, 'setup')
    assert.equal(panel.findAll({ text: 'Not started' }).length, 1)
    assert.equal(panel.findAll({ text: 'Available' }).length, 1)
  }
  await shown()
  assert.deepEqual(log, ['setup panel'], 'the other section started')
  // Neither asking again nor a change of settings clears it.
  await panel.press({ role: 'button', label: 'Refresh' })
  await shown()
  await panel.post('core.changed', { key: 'b2cPath' })
  await shown()
  assert.equal(requestsOf(panel), 3)
  assert.equal(panel.find({ text: /Something went wrong/ }), null, 'it is not the error of a request')

  // In Spanish.
  panel.unmount()
  panel = await mount(module, { host: hostAnswering(ALL_READY), locale: 'es' })
  assert.match(panel.summary().join('\n'), /Errores no ha podido arrancar/)
  assert.equal(attentionOf(panel), 'Una pieza no ha arrancado')
  await panel.select({ type: 'Tabs' }, 'setup')
  assert.equal(panel.findAll({ text: 'No ha arrancado' }).length, 1)
  assert.equal(panel.findAll({ text: 'Disponible' }).length, 1)

  // Opening the panel again starts the section again: once it starts, the error is gone.
  panel.unmount()
  fails = false
  panel = await mount(module, { host: hostAnswering(ALL_READY), locale: 'en' })
  assert.equal(panel.find({ text: /could not start/ }), null)
  assert.ok(panel.find({ text: 'errors body' }))
  assert.equal(attentionButton(panel), null)
  await panel.select({ type: 'Tabs' }, 'setup')
  assert.equal(panel.find({ text: 'Not started' }), null)
  assert.equal(panel.findAll({ text: 'Available' }).length, 2)
})

test('a section whose setup throws with no view of its own is still shown as not started', async () => {
  const failing: PanelSection = { ...stub('isml', 'ISML', 'ISML'), hasView: false, setup: () => { throw new Error('broken') } }
  panel = await mount(panelOver([failing]), { host: hostAnswering(ALL_READY), locale: 'en' })
  // The setup view is the whole panel, and says so.
  assert.equal(panel.find({ type: 'Tabs' }), null)
  assert.match(panel.summary().join('\n'), /ISML could not start/)
  assert.equal(panel.findAll({ text: 'Not started' }).length, 1)
})

test('which views the bar holds comes from the sections, not from the panel', async () => {
  // A piece delivered with no view, or with a view but not delivered: neither gets a view.
  const module = panelOver([{ ...viewOf('sandbox', 'Sandbox and upload', 'Sandbox y subida'), hasView: false }, stub('errors', 'Errors', 'Errores')])
  panel = await mount(module, { host: hostAnswering(FOUND), locale: 'en' })
  assert.equal(panel.find({ type: 'Tabs' }), null)
  assert.ok(panel.find({ text: 'Sandbox and upload' }))
  assert.equal(panel.findAll({ text: 'Available' }).length, 1)
  assert.equal(panel.find({ text: 'Sandbox and upload body' }), null, 'a piece with no view is never drawn')
})

test('the plugin’s own panel has a view for every delivered piece with one, and no bar without any', async () => {
  // Whatever the pieces are today: delivered or not, with a view or not. Only what the registry
  // says is expected.
  assert.deepEqual(SECTIONS.map((section) => section.id), [...PIECE_IDS])
  const views = SECTIONS.filter((section) => section.delivered && section.hasView)
  for (const locale of ['en', 'es']) {
    panel = await mount(panelModule, { host: hostAnswering(FOUND), locale })
    const setup = locale === 'es' ? 'Configuración' : 'Setup'
    if (views.length === 0) {
      assert.equal(panel.find({ type: 'Tabs' }), null, locale)
      assert.ok(panel.find({ type: 'Heading', text: setup }), locale)
    } else {
      assert.deepEqual(tabs(panel), [...views.map((section) => section.title(locale)), setup], locale)
    }
    assert.deepEqual(panel.errors, [], locale)
    assert.deepEqual(panel.warnings, [], locale)
    panel.unmount()
  }
  panel = undefined
})

test('a piece adds check scenarios from its own folder: they are merged under its name, over a ready setup', () => {
  const core = { found: {}, missing: { settings: { b2cPath: 'x' } } }
  const answer = { state: 'watching' }
  const merged = mergeScenarios(core, [
    { id: 'sandbox', scenarios: { sandbox: {}, sandboxWatching: { requests: { 'probe.status': answer }, settings: { b2cPath: 'y' } } } },
    { id: 'errors', scenarios: { errorsNew: { requests: { 'core.status': MISSING } } } },
    { id: 'isml', scenarios: {} }
  ])
  assert.deepEqual(Object.keys(merged), ['found', 'missing', 'sandbox', 'sandboxWatching', 'errorsNew'])
  // Core's scenarios are untouched.
  assert.equal(merged.found, core.found)
  // A piece's scenario is drawn over a ready setup unless it stubs core.status itself.
  const status = merged.sandboxWatching.requests?.['core.status']
  assert.equal(typeof status === 'function' ? status({}) : status, READY_STATUS)
  assert.equal(merged.sandboxWatching.requests?.['probe.status'], answer)
  assert.deepEqual(merged.sandboxWatching.settings, { b2cPath: 'y' })
  assert.equal(merged.errorsNew.requests?.['core.status'], MISSING)

  // Named after another piece, after none, or twice: refused, naming the piece.
  assert.throws(() => mergeScenarios(core, [{ id: 'errors', scenarios: { sandboxBroken: {} } }]), /errors: the scenario "sandboxBroken" must be named errors or errors<Name>/)
  assert.throws(() => mergeScenarios(core, [{ id: 'errors', scenarios: { found: {} } }]), /errors: the scenario "found" must be named/)
  assert.throws(() => mergeScenarios(core, [{ id: 'errors', scenarios: { errorsx: {} } }]), /must be named/)
  assert.throws(() => mergeScenarios({ errorsNew: {} }, [{ id: 'errors', scenarios: { errorsNew: {} } }]), /errors: the scenario "errorsNew" already exists/)
})

test('the panel’s checks hold core’s scenarios first, then only scenarios named after a piece', () => {
  const names = Object.keys(CHECKS)
  const core = ['found', 'wrongPath', 'configured', 'missing', 'invalidConfig', 'customConfigFile', 'workerTimeout']
  assert.deepEqual(names.slice(0, core.length), core)
  // However many the pieces have added from their folders, each one is a piece's and is drawn
  // over a stubbed setup.
  for (const name of names.slice(core.length)) {
    assert.ok(PIECE_IDS.some((id) => name === id || (name.startsWith(id) && /^[A-Z0-9]/.test(name.slice(id.length)))), name)
    assert.ok(CHECKS[name].requests?.['core.status'], `${name} stubs core.status`)
  }
})
