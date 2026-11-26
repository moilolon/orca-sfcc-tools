// The panel over a stubbed worker: what it shows for each answer of core.status, in English and
// in Spanish.
import { afterEach, assert, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { CoreStatus } from '../protocol'
import * as panelModule from './panel'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

const PIECES: CoreStatus['pieces'] = ['isml', 'sandbox', 'errors', 'debugger', 'engine', 'editor']
const FOUND: CoreStatus = {
  b2c: { found: true, version: '9.8.7' },
  instances: { sandbox: true, development: true, staging: false, production: false },
  pieces: PIECES
}
const MISSING: CoreStatus = {
  b2c: { found: false, version: null, reason: 'b2c_not_found' },
  instances: { sandbox: false, development: false, staging: false, production: false },
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

test('shows b2c found, each environment and the pieces', async () => {
  const host = hostAnswering(FOUND)
  panel = await mount(panelModule, { host, locale: 'en' })
  assert.ok(panel.find({ text: 'Found, version 9.8.7' }))
  assert.equal(panel.findAll({ text: 'Configured' }).length, 2)
  assert.equal(panel.findAll({ text: 'Not configured' }).length, 2)
  for (const name of ['Sandbox', 'Development', 'Staging', 'Production', 'ISML', 'Errors', 'Debugger']) assert.ok(panel.find({ text: name }), name)
  assert.equal(panel.find({ text: /not available/ }), null)
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
})

test('asks the worker in the panel’s language', async () => {
  const host = hostAnswering(FOUND)
  panel = await mount(panelModule, { host, locale: 'es-ES' })
  assert.deepEqual(host.calls.find((call) => call.method === 'plugin.request')?.params, { name: 'core.status', input: { locale: 'es-ES' }, timeoutMs: 60_000 })
})

test('says when b2c is missing, and why, pointing at the setting', async () => {
  panel = await mount(panelModule, { host: hostAnswering(MISSING), locale: 'en' })
  assert.ok(panel.find({ text: 'Not found' }))
  assert.match(panel.summary().join('\n'), /The b2c CLI is not available/)
  assert.ok(panel.find({ text: 'The b2c CLI was not found.' }))
  assert.ok(panel.find({ text: /b2c path/ }))
})

test('in Spanish', async () => {
  panel = await mount(panelModule, { host: hostAnswering(MISSING), locale: 'es' })
  assert.ok(panel.find({ text: 'No encontrado' }))
  assert.ok(panel.find({ text: 'No se ha encontrado el CLI b2c.' }))
  assert.equal(panel.findAll({ text: 'Sin configurar' }).length, 4)
  assert.ok(panel.find({ text: 'Desarrollo' }))
})

test('words a worker error and offers to try again', async () => {
  const host = hostAnswering(hostError('timeout'))
  panel = await mount(panelModule, { host, locale: 'en' })
  assert.match(panel.summary().join('\n'), /Something went wrong/)
  assert.ok(panel.find({ text: 'Unexpected error (timeout).' }))
  assert.ok(panel.find({ role: 'button', label: 'Refresh' }))
})
