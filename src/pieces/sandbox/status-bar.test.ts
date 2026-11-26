// The status bar texts in every state, in English and Spanish, from the states the scenarios draw.
import { assert, test } from 'orca/testing'
import { translator } from '../../core/i18n'
import type { SandboxStatus } from './protocol'
import { DEPLOYING, FAILED, IDLE, UPLOADING, WATCHING } from './scenarios'
import { statusBarUpdates } from './status-bar'

const en = translator(() => 'en')
const es = translator(() => 'es')
const texts = (status: SandboxStatus, t = en) => statusBarUpdates(t, status).map((update) => (update.visible ? `${update.text} [${update.tone}]` : 'hidden'))

test('the sandbox item: its state, the code version while a workspace uploads, its tone by state', () => {
  assert.deepEqual(texts(IDLE), ['Sandbox started [success]', 'hidden'])
  assert.deepEqual(texts({ ...IDLE, sandbox: { ...IDLE.sandbox, state: 'stopped' } }), ['Sandbox stopped [neutral]', 'hidden'])
  assert.deepEqual(texts({ ...IDLE, sandbox: { ...IDLE.sandbox, state: 'busy' } }), ['Sandbox busy [accent]', 'hidden'])
  assert.deepEqual(texts({ ...IDLE, sandbox: { ...IDLE.sandbox, state: 'busy', following: 'start' } }), ['Sandbox starting [accent]', 'hidden'])
  assert.deepEqual(texts({ ...IDLE, sandbox: { ...IDLE.sandbox, state: 'busy', following: 'stop' } }), ['Sandbox stopping [accent]', 'hidden'])
  assert.deepEqual(texts({ ...IDLE, sandbox: { ...IDLE.sandbox, state: 'unknown' } }), ['Sandbox unknown [warning]', 'hidden'])
  assert.deepEqual(texts({ ...IDLE, role: 'incomplete' }), ['Sandbox not ready [warning]', 'hidden'])
  assert.deepEqual(texts({ ...IDLE, config: 'missing' }), ['Sandbox not ready [warning]', 'hidden'])
  assert.deepEqual(texts(WATCHING), ['Sandbox started · ws-checkout-fix [success]', 'hidden'])
})

test('the upload item shows only while deploying, uploading or failed', () => {
  assert.deepEqual(texts(DEPLOYING), ['Sandbox started · ws-checkout-fix [success]', 'Deploying ws-checkout-fix [accent]'])
  assert.deepEqual(texts(UPLOADING), ['Sandbox started · ws-checkout-fix [success]', 'Uploading to ws-checkout-fix [accent]'])
  assert.deepEqual(texts(FAILED), ['Sandbox started · ws-checkout-fix [success]', 'Upload failed [danger]'])
  assert.equal(statusBarUpdates(en, FAILED)[1].tooltip, 'b2c ended with an error.')
  assert.equal(statusBarUpdates(en, WATCHING)[0].tooltip, 'checkout-fix uploads to ws-checkout-fix. Press to refresh.')
})

test('in Spanish too', () => {
  assert.deepEqual(texts(IDLE, es), ['Sandbox arrancado [success]', 'hidden'])
  assert.deepEqual(texts(UPLOADING, es), ['Sandbox arrancado · ws-checkout-fix [success]', 'Subiendo a ws-checkout-fix [accent]'])
  assert.deepEqual(texts(FAILED, es), ['Sandbox arrancado · ws-checkout-fix [success]', 'Subida fallida [danger]'])
  assert.deepEqual(texts({ ...IDLE, role: 'absent' }, es), ['Sandbox no listo [warning]', 'hidden'])
})
