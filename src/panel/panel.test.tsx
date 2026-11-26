// The panel over a stubbed worker: what it shows for each answer of core.status, in English and
// in Spanish, and what a piece's section can do without the panel knowing the piece.
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
const MISSING: CoreStatus = {
  b2c: { found: false, version: null, reason: 'b2c_not_found' },
  config: 'missing',
  instances: { sandbox: 'absent', development: 'absent', staging: 'absent', production: 'absent' },
  pieces: PIECES
}

function hostAnswering(status: CoreStatus | Error) {
  return mockHost({
    capabilities: ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show'],
    requests: {
      'core.status': () => {
        if (status instanceof Error) throw status
        return status
      }
    }
  })
}

/** A section that draws nothing, as a piece not yet delivered has it. */
function stub(id: PanelSection['id'], en: string, es: string): PanelSection {
  return { id, icon: 'code', title: (locale) => (locale.startsWith('es') ? es : en), delivered: false, render: () => null }
}

/** The panel over sections of this file: what core draws, whatever the pieces are. */
function panelOver(sections: readonly PanelSection[]) {
  const { setup, Panel } = createPanel(sections)
  return { default: Panel, setup }
}

const CORE = panelOver([stub('errors', 'Errors', 'Errores'), stub('debugger', 'Debugger', 'Depurador')])

test('shows b2c found, the state of each environment and the pieces', async () => {
  const host = hostAnswering(FOUND)
  panel = await mount(CORE, { host, locale: 'en' })
  assert.ok(panel.find({ text: 'Found, version 9.8.7' }))
  assert.equal(panel.findAll({ text: 'Ready' }).length, 2)
  assert.equal(panel.findAll({ text: 'Incomplete' }).length, 1)
  assert.equal(panel.findAll({ text: 'Not configured' }).length, 1)
  // An incomplete environment is explained: the host is there, the credentials are not.
  assert.ok(panel.find({ text: /^Incomplete: dw\.json has the host/ }))
  for (const name of ['Sandbox', 'Development', 'Staging', 'Production', 'Errors', 'Debugger']) assert.ok(panel.find({ text: name }), name)
  assert.equal(panel.findAll({ text: 'Coming' }).length, 2)
  assert.equal(panel.find({ text: /not available/ }), null)
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

test('says when b2c is missing, and why, pointing at the setting; and that there is no dw.json', async () => {
  panel = await mount(CORE, { host: hostAnswering(MISSING), locale: 'en' })
  assert.ok(panel.find({ text: 'Not found' }))
  assert.match(panel.summary().join('\n'), /The b2c CLI is not available/)
  assert.ok(panel.find({ text: 'The b2c CLI was not found.' }))
  assert.ok(panel.find({ text: /b2c path/ }))
  assert.match(panel.summary().join('\n'), /No dw\.json/)
  assert.ok(panel.find({ text: /^No dw\.json was found for the workspace/ }))
  assert.equal(panel.findAll({ text: 'Not configured' }).length, 4)
  assert.equal(panel.find({ text: /^Incomplete:/ }), null)
})

test('says a dw.json that is not JSON cannot be read, instead of four silent absences', async () => {
  panel = await mount(CORE, { host: hostAnswering({ ...MISSING, b2c: FOUND.b2c, config: 'invalid' }), locale: 'en' })
  assert.match(panel.summary().join('\n'), /dw\.json cannot be read/)
  assert.ok(panel.find({ text: 'The file is not valid JSON, so no environment can be read from it.' }))
  assert.equal(panel.find({ text: /^No dw\.json was found/ }), null)
  panel.unmount()
  panel = await mount(CORE, { host: hostAnswering({ ...MISSING, config: 'invalid' }), locale: 'es' })
  assert.match(panel.summary().join('\n'), /No se puede leer dw\.json/)
  assert.ok(panel.find({ text: /^El fichero no es JSON válido/ }))
})

test('in Spanish', async () => {
  panel = await mount(CORE, { host: hostAnswering(MISSING), locale: 'es' })
  assert.ok(panel.find({ text: 'No encontrado' }))
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
  for (const name of ['Errores', 'Depurador']) assert.ok(panel.find({ text: name }), name)
  assert.equal(panel.findAll({ text: 'Próximamente' }).length, 2)
})

test('words a host error, a timeout included, and offers to try again', async () => {
  panel = await mount(CORE, { host: hostAnswering(hostError('timeout')), locale: 'en' })
  assert.match(panel.summary().join('\n'), /Something went wrong/)
  assert.ok(panel.find({ text: 'The plugin took too long to answer.' }))
  assert.ok(panel.find({ role: 'button', label: 'Refresh' }))
  panel.unmount()
  panel = await mount(CORE, { host: hostAnswering(hostError('timeout')), locale: 'es' })
  assert.ok(panel.find({ text: 'El plugin ha tardado demasiado en responder.' }))
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
  assert.equal(panel.host.calls.filter((call) => call.method === 'plugin.request').length, 2)
  assert.deepEqual(panel.errors, [])
  panel.unmount()
  panel = undefined
  assert.deepEqual(log.slice(1).sort(), ['cleanup ran', 'subscription disposed'])
})

test('a section whose setup throws keeps its error until the panel is reopened, and is not listed as available', async () => {
  const log: string[] = []
  let fails = true
  const failing: PanelSection = {
    id: 'errors',
    icon: 'warning',
    title: (locale) => (locale.startsWith('es') ? 'Errores' : 'Errors'),
    // It says it is delivered: the panel must not take its word once it has failed to start.
    delivered: true,
    setup() {
      if (fails) throw new Error('broken setup')
    },
    render: () => <Text>errors body</Text>
  }
  const module = panelOver([failing, liveSection(log)])
  panel = await mount(module, { host: hostAnswering(FOUND), locale: 'en' })
  const shown = () => {
    assert.ok(panel, 'mounted')
    // The first answer of core.status has arrived, and the error is still there.
    assert.ok(panel.find({ text: 'Found, version 9.8.7' }))
    assert.match(panel.summary().join('\n'), /Errors could not start/)
    assert.ok(panel.find({ text: /^Its part of this panel failed to start/ }))
    assert.equal(panel.findAll({ text: 'Not started' }).length, 1)
    // Only the section that did start is available, and only it is drawn.
    assert.equal(panel.findAll({ text: 'Available' }).length, 1)
    assert.equal(panel.find({ text: 'errors body' }), null)
    assert.ok(panel.find({ text: 'uploads: 0' }))
  }
  shown()
  assert.deepEqual(log, ['setup panel'], 'the other section started')
  // Neither asking again nor a change of settings clears it.
  await panel.press({ role: 'button', label: 'Refresh' })
  shown()
  await panel.post('core.changed', { key: 'b2cPath' })
  shown()
  assert.equal(panel.host.calls.filter((call) => call.method === 'plugin.request').length, 3)
  assert.equal(panel.find({ text: /Something went wrong/ }), null, 'it is not the error of a request')

  // In Spanish.
  panel.unmount()
  panel = await mount(module, { host: hostAnswering(FOUND), locale: 'es' })
  assert.match(panel.summary().join('\n'), /Errores no ha podido arrancar/)
  assert.equal(panel.findAll({ text: 'No ha arrancado' }).length, 1)
  assert.equal(panel.findAll({ text: 'Disponible' }).length, 1)

  // Opening the panel again starts the section again: once it starts, the error is gone.
  panel.unmount()
  fails = false
  panel = await mount(module, { host: hostAnswering(FOUND), locale: 'en' })
  assert.equal(panel.find({ text: /could not start/ }), null)
  assert.equal(panel.find({ text: 'Not started' }), null)
  assert.equal(panel.findAll({ text: 'Available' }).length, 2)
  assert.ok(panel.find({ text: 'errors body' }))
})

test('whether a piece is listed as available comes from its section, not from the panel', async () => {
  const module = panelOver([liveSection([]), stub('errors', 'Errors', 'Errores')])
  panel = await mount(module, { host: hostAnswering(FOUND), locale: 'en' })
  assert.equal(panel.findAll({ text: 'Available' }).length, 1)
  assert.equal(panel.findAll({ text: 'Coming' }).length, 1)
  panel.unmount()
  panel = await mount(module, { host: hostAnswering(FOUND), locale: 'es' })
  assert.equal(panel.findAll({ text: 'Disponible' }).length, 1)
  assert.equal(panel.findAll({ text: 'Próximamente' }).length, 1)
})

test('the plugin’s own panel lists every piece of the registry under the name its section gives', async () => {
  // Whatever the pieces are today: delivered or not, drawing a body or not, asking their worker
  // half or not. Only what the registry says is expected.
  assert.deepEqual(SECTIONS.map((section) => section.id), [...PIECE_IDS])
  for (const locale of ['en', 'es']) {
    panel = await mount(panelModule, { host: hostAnswering(FOUND), locale })
    for (const section of SECTIONS) assert.ok(panel.findAll({ text: section.title(locale) }).length >= 1, `${section.id} in ${locale}`)
    const [available, coming] = locale === 'es' ? ['Disponible', 'Próximamente'] : ['Available', 'Coming']
    assert.ok(panel.findAll({ text: available }).length >= SECTIONS.filter((section) => section.delivered).length, available)
    assert.ok(panel.findAll({ text: coming }).length >= SECTIONS.filter((section) => !section.delivered).length, coming)
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
  const core = ['found', 'wrongPath', 'configured', 'missing', 'invalidConfig']
  assert.deepEqual(names.slice(0, core.length), core)
  // However many the pieces have added from their folders, each one is a piece's and is drawn
  // over a stubbed setup.
  for (const name of names.slice(core.length)) {
    assert.ok(PIECE_IDS.some((id) => name === id || (name.startsWith(id) && /^[A-Z0-9]/.test(name.slice(id.length)))), name)
    assert.ok(CHECKS[name].requests?.['core.status'], `${name} stubs core.status`)
  }
})
