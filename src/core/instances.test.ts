import { assert, test } from 'orca/testing'
import { ALLOWED_FLAGS, flagOf, guard, isRole, refusedFlag, ROLES, suffixFor, topicOf } from './instances'

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

test('the flag an argument names, with or without its value', () => {
  assert.equal(flagOf('--level'), '--level')
  assert.equal(flagOf('--level=ERROR'), '--level')
  assert.equal(flagOf('-s=other.example.com'), '-s')
  assert.equal(flagOf('--search=a=b'), '--search')
  assert.equal(flagOf('-'), '-')
  assert.equal(flagOf('--'), '--')
  assert.equal(flagOf('v1'), null)
  assert.equal(flagOf('a=-b'), null)
  assert.equal(flagOf(''), null)
})

test('a flag is allowed only by its whole name: no other spelling, group or glued value passes', () => {
  assert.equal(refusedFlag(['code', 'deploy', '-a', '--reload', '-v', 'v1', '--cartridge=app_one']), -1)
  assert.equal(refusedFlag(['logs', 'get', '--level=ERROR', '-n', '5']), -1)
  assert.equal(refusedFlag([]), -1)
  for (const flag of ['-s', '-s=x', '-sx', '--server', '--server=x', '-ar', '-ra', '-A', '--Activate', '--activate-x', '--', '-', '--json2', '-vv1']) {
    assert.equal(refusedFlag(['code', 'deploy', '-a', flag, 'x']), 3, flag)
  }
})

test('the allow list holds nothing that names a host, a user, a credential, a file of settings or a sign-in', () => {
  const forbidden = /server|host|user|pass|client|secret|instance|config|dotenv|env|project|director|cert|jwt|auth|tenant|short-code|key|token|login|backend|selfsigned|debug|lang|log-level/
  for (const flag of ALLOWED_FLAGS) {
    assert.match(flag, /^(-[a-z]|--[a-z][a-z-]*)$/, flag)
    assert.ok(!forbidden.test(flag), flag)
  }
  // b2c's short flags for those: server, user, password, instance, debug, language.
  for (const short of ['-s', '-u', '-p', '-i', '-D', '-L', '-w']) assert.ok(!ALLOWED_FLAGS.has(short), short)
  assert.equal(ALLOWED_FLAGS.size, 46)
})
