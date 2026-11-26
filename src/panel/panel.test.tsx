// The panel over a stubbed worker: what it shows for each answer of core.status, in English and
// in Spanish, and what a piece's section can do without the panel knowing the piece.
import { atom, plugin, read, set, Text } from 'orca'
import { afterEach, assert, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { PanelSection } from '../core/piece'
import type { CoreStatus } from '../protocol'
import * as panelModule from './panel'
import { createPanel } from './panel'
import { CHECKS } from './checks'
import { mergeScenarios, READY_STATUS } from './scenarios'
import { SECTIONS } from './sections'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

const PIECES: CoreStatus['pieces'] = ['isml', 'sandbox', 'errors', 'debugger', 'engine', 'editor']
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

test('shows b2c found, the state of each environment and the pieces', async () => {
  const host = hostAnswering(FOUND)
  panel = await mount(panelModule, { host, locale: 'en' })
  assert.ok(panel.find({ text: 'Found, version 9.8.7' }))
  assert.equal(panel.findAll({ text: 'Ready' }).length, 2)
  assert.equal(panel.findAll({ text: 'Incomplete' }).length, 1)
  assert.equal(panel.findAll({ text: 'Not configured' }).length, 1)
  // An incomplete environment is explained: the host is there, the credentials are not.
  assert.ok(panel.find({ text: /^Incomplete: dw\.json has the host/ }))
  for (const name of ['Sandbox', 'Development', 'Staging', 'Production', 'ISML', 'Sandbox and upload', 'Errors', 'Debugger', 'Analysis', 'Editor']) assert.ok(panel.find({ text: name }), name)
  assert.equal(panel.find({ text: /not available/ }), null)
  assert.equal(panel.find({ text: /No dw\.json/ }), null)
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
})

test('asks the worker in the panel’s language', async () => {
  const host = hostAnswering(FOUND)
  panel = await mount(panelModule, { host, locale: 'es-ES' })
  assert.deepEqual(host.calls.find((call) => call.method === 'plugin.request')?.params, { name: 'core.status', input: { locale: 'es-ES' }, timeoutMs: 60_000 })
})

test('says when b2c is missing, and why, pointing at the setting; and that there is no dw.json', async () => {
  panel = await mount(panelModule, { host: hostAnswering(MISSING), locale: 'en' })
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
  panel = await mount(panelModule, { host: hostAnswering({ ...MISSING, b2c: FOUND.b2c, config: 'invalid' }), locale: 'en' })
  assert.match(panel.summary().join('\n'), /dw\.json cannot be read/)
  assert.ok(panel.find({ text: 'The file is not valid JSON, so no environment can be read from it.' }))
  assert.equal(panel.find({ text: /^No dw\.json was found/ }), null)
  panel.unmount()
  panel = await mount(panelModule, { host: hostAnswering({ ...MISSING, config: 'invalid' }), locale: 'es' })
  assert.match(panel.summary().join('\n'), /No se puede leer dw\.json/)
  assert.ok(panel.find({ text: /^El fichero no es JSON válido/ }))
})

test('in Spanish', async () => {
  panel = await mount(panelModule, { host: hostAnswering(MISSING), locale: 'es' })
  assert.ok(panel.find({ text: 'No encontrado' }))
  assert.ok(panel.find({ text: 'No se ha encontrado el CLI b2c.' }))
  assert.equal(panel.findAll({ text: 'Sin configurar' }).length, 4)
  assert.match(panel.summary().join('\n'), /No hay dw\.json/)
  assert.ok(panel.find({ text: 'Desarrollo' }))
  panel.unmount()
  panel = await mount(panelModule, { host: hostAnswering(FOUND), locale: 'es' })
  assert.equal(panel.findAll({ text: 'Listo' }).length, 2)
  assert.equal(panel.findAll({ text: 'Incompleto' }).length, 1)
  assert.equal(panel.findAll({ text: 'Sin configurar' }).length, 1)
  assert.ok(panel.find({ text: /^Incompleto: dw\.json tiene el host/ }))
  assert.equal(panel.findAll({ text: 'Próximamente' }).length, SECTIONS.length)
})

test('words a host error, a timeout included, and offers to try again', async () => {
  panel = await mount(panelModule, { host: hostAnswering(hostError('timeout')), locale: 'en' })
  assert.match(panel.summary().join('\n'), /Something went wrong/)
  assert.ok(panel.find({ text: 'The plugin took too long to answer.' }))
  assert.ok(panel.find({ role: 'button', label: 'Refresh' }))
  panel.unmount()
  panel = await mount(panelModule, { host: hostAnswering(hostError('timeout')), locale: 'es' })
  assert.ok(panel.find({ text: 'El plugin ha tardado demasiado en responder.' }))
})

test('words a failure that has no code as the panel’s own action_failed, in both languages', async () => {
  panel = await mount(panelModule, { host: hostAnswering(new Error('no code here')), locale: 'en' })
  assert.ok(panel.find({ text: 'The action could not be completed.' }))
  assert.equal(panel.find({ text: /action_failed|no code here/ }), null)
  panel.unmount()
  panel = await mount(panelModule, { host: hostAnswering(new Error('no code here')), locale: 'es' })
  assert.ok(panel.find({ text: 'No se ha podido completar la acción.' }))
})

// ---------------------------------------------------------------------------------------------
// What a piece does from its own folder

/** A section as a delivered piece would write it: its own state, its own event, its own body. */
function liveSection(log: string[]): PanelSection {
  const count = atom(0)
  return {
    id: 'sandbox',
    icon: 'cloud',
    title: (locale) => (locale.startsWith('es') ? 'Sandbox y subida' : 'Sandbox and upload'),
    delivered: true,
    setup(ctx) {
      log.push(`setup ${ctx.panel.id}`)
      ctx.subscriptions.push(plugin.on('sandbox.changed', () => set(count, read(count) + 1)))
      ctx.subscriptions.push({ dispose: () => log.push('subscription disposed') })
      return () => log.push('cleanup ran')
    },
    render: () => <Text>{`uploads: ${read(count)}`}</Text>
  }
}

test('a section listens to its own events through its setup, and is disposed with the panel', async () => {
  const log: string[] = []
  const { setup, Panel } = createPanel([liveSection(log)])
  panel = await mount({ default: Panel, setup }, { host: hostAnswering(FOUND), locale: 'en', panelId: 'sfcc' })
  assert.deepEqual(log, ['setup sfcc'])
  assert.ok(panel.find({ text: 'uploads: 0' }))
  await panel.post('sandbox.changed', {})
  await panel.post('sandbox.changed', {})
  assert.ok(panel.find({ text: 'uploads: 2' }))
  // The panel still hears its own event beside the section's.
  await panel.post('core.changed', { key: 'b2cPath' })
  assert.equal(panel.host.calls.filter((call) => call.method === 'plugin.request').length, 2)
  assert.deepEqual(panel.errors, [])
  panel.unmount()
  panel = undefined
  assert.deepEqual(log.slice(1).sort(), ['cleanup ran', 'subscription disposed'])
})

test('a section whose setup throws does not take the panel or the other sections with it', async () => {
  const log: string[] = []
  const broken: PanelSection = {
    id: 'errors',
    icon: 'warning',
    title: () => 'Errors',
    delivered: false,
    setup() {
      throw new Error('broken setup')
    },
    render: () => null
  }
  const { setup, Panel } = createPanel([broken, liveSection(log)])
  panel = await mount({ default: Panel, setup }, { host: hostAnswering(FOUND), locale: 'en' })
  assert.deepEqual(log, ['setup panel'])
  assert.ok(panel.find({ text: 'Found, version 9.8.7' }))
  assert.ok(panel.find({ text: 'uploads: 0' }))
})

test('whether a piece is listed as available comes from its section, not from the panel', async () => {
  const stub: PanelSection = { id: 'errors', icon: 'warning', title: () => 'Errors', delivered: false, render: () => null }
  const { setup, Panel } = createPanel([liveSection([]), stub])
  panel = await mount({ default: Panel, setup }, { host: hostAnswering(FOUND), locale: 'en' })
  assert.equal(panel.findAll({ text: 'Available' }).length, 1)
  assert.equal(panel.findAll({ text: 'Coming' }).length, 1)
  panel.unmount()
  panel = await mount({ default: Panel, setup }, { host: hostAnswering(FOUND), locale: 'es' })
  assert.equal(panel.findAll({ text: 'Disponible' }).length, 1)
  assert.equal(panel.findAll({ text: 'Próximamente' }).length, 1)
  panel.unmount()
  // Today every piece is a stub, so the plugin's own panel lists all six as coming.
  panel = await mount(panelModule, { host: hostAnswering(FOUND), locale: 'en' })
  assert.deepEqual(SECTIONS.map((section) => section.delivered), [false, false, false, false, false, false])
  assert.equal(panel.findAll({ text: 'Coming' }).length, 6)
  assert.equal(panel.find({ text: 'Available' }), null)
})

test('a piece adds check scenarios from its own folder: they are merged under its name, over a ready setup', () => {
  const core = { found: {}, missing: { settings: { b2cPath: 'x' } } }
  const answer = { state: 'watching' }
  const merged = mergeScenarios(core, [
    { id: 'sandbox', scenarios: { sandbox: {}, sandboxWatching: { requests: { 'sandbox.status': answer }, settings: { b2cPath: 'y' } } } },
    { id: 'errors', scenarios: { errorsNew: { requests: { 'core.status': MISSING } } } },
    { id: 'isml', scenarios: {} }
  ])
  assert.deepEqual(Object.keys(merged), ['found', 'missing', 'sandbox', 'sandboxWatching', 'errorsNew'])
  // Core's scenarios are untouched.
  assert.equal(merged.found, core.found)
  // A piece's scenario is drawn over a ready setup unless it stubs core.status itself.
  const status = merged.sandboxWatching.requests?.['core.status']
  assert.equal(typeof status === 'function' ? status({}) : status, READY_STATUS)
  assert.equal(merged.sandboxWatching.requests?.['sandbox.status'], answer)
  assert.deepEqual(merged.sandboxWatching.settings, { b2cPath: 'y' })
  assert.equal(merged.errorsNew.requests?.['core.status'], MISSING)

  // Named after another piece, after none, or twice: refused, naming the piece.
  assert.throws(() => mergeScenarios(core, [{ id: 'errors', scenarios: { sandboxBroken: {} } }]), /errors: the scenario "sandboxBroken" must be named errors or errors<Name>/)
  assert.throws(() => mergeScenarios(core, [{ id: 'errors', scenarios: { found: {} } }]), /errors: the scenario "found" must be named/)
  assert.throws(() => mergeScenarios(core, [{ id: 'errors', scenarios: { errorsx: {} } }]), /must be named/)
  assert.throws(() => mergeScenarios({ errorsNew: {} }, [{ id: 'errors', scenarios: { errorsNew: {} } }]), /errors: the scenario "errorsNew" already exists/)
})

test('the panel’s checks hold core’s scenarios, merged with every piece’s', () => {
  assert.deepEqual(Object.keys(CHECKS), ['found', 'wrongPath', 'configured', 'missing', 'invalidConfig'])
})
