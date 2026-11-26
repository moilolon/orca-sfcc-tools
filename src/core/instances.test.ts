import { assert, test } from 'orca/testing'
import { guard, isRole, ROLES, suffixFor, topicOf } from './instances'

const SUFFIXES = { development: '-dev', staging: '-stg', production: '-prd' }

test('four roles', () => {
  assert.deepEqual([...ROLES], ['sandbox', 'development', 'staging', 'production'])
  assert.ok(isRole('staging'))
  assert.ok(!isRole('prod'))
})

test('the sandbox uses the plain keys and every other role its own suffix', () => {
  assert.equal(suffixFor('sandbox', SUFFIXES), '')
  assert.equal(suffixFor('development', SUFFIXES), '-dev')
  assert.equal(suffixFor('staging', SUFFIXES), '-stg')
  assert.equal(suffixFor('production', SUFFIXES), '-prd')
})

test('a role whose suffix is empty or shared cannot be resolved', () => {
  assert.equal(suffixFor('development', { ...SUFFIXES, development: '' }), null, 'it would read the sandbox keys')
  assert.equal(suffixFor('staging', { ...SUFFIXES, staging: '-prd' }), null)
  assert.equal(suffixFor('production', { ...SUFFIXES, staging: '-prd' }), null)
  assert.equal(suffixFor('development', { ...SUFFIXES, staging: '-prd' }), '-dev')
})

test('the topic of a command, in both of oclif’s spellings', () => {
  assert.equal(topicOf(['code', 'deploy']), 'code')
  assert.equal(topicOf(['code:deploy']), 'code')
  assert.equal(topicOf(['--version']), '--version')
  assert.equal(topicOf([]), '')
})

test('the guard: an allow list per role', () => {
  assert.deepEqual(guard(['--version'], undefined), { ok: true, needsRole: false })
  assert.deepEqual(guard(['--version', 'x'], undefined), { ok: false, code: 'role_refused' })
  assert.deepEqual(guard(['docs', 'read', 'dw.catalog.ProductMgr'], undefined), { ok: true, needsRole: false })
  assert.deepEqual(guard(['logs', 'get'], undefined), { ok: false, code: 'role_required' })
  for (const topic of ['code', 'debug', 'sandbox', 'ods', 'logs']) {
    assert.deepEqual(guard([topic, 'x'], 'sandbox'), { ok: true, needsRole: true }, topic)
  }
  for (const role of ['development', 'staging', 'production'] as const) {
    assert.deepEqual(guard(['logs', 'get'], role), { ok: true, needsRole: true })
    for (const topic of ['code', 'debug', 'sandbox', 'ods', 'webdav', 'job', '']) {
      assert.deepEqual(guard([topic, 'x'], role), { ok: false, code: 'role_refused' }, `${topic} on ${role}`)
    }
  }
  assert.deepEqual(guard([], 'sandbox'), { ok: false, code: 'role_refused' })
})
