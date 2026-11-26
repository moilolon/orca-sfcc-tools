// The mapping of dw.json to b2c's variables and to the state of each role, on invented files in
// temporary folders.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasCredentials, loadConfig, locateConfig, mainCheckoutOf, mapRole } from './dw-config'
import { assertNoSecrets, INVENTED_DW, makeWorkspace } from './test-support'

const SUFFIXES = { development: '-dev', staging: '-stg', production: '-prd' }

test('maps the plain keys to the sandbox', () => {
  assert.deepEqual(mapRole(INVENTED_DW, 'sandbox', SUFFIXES), {
    state: 'ready',
    vars: {
      SFCC_SERVER: INVENTED_DW.hostname,
      SFCC_USERNAME: INVENTED_DW.username,
      SFCC_PASSWORD: INVENTED_DW.password,
      SFCC_CLIENT_ID: INVENTED_DW['client-id'],
      SFCC_CLIENT_SECRET: INVENTED_DW['client-secret'],
      SFCC_SHORTCODE: INVENTED_DW['short-code'],
      SFCC_TENANT_ID: INVENTED_DW['tenant-id']
    }
  })
})

test('maps the suffixed keys to their role, with no fallback to the plain ones', () => {
  // Development has no username, password, short code or tenant: they stay absent.
  assert.deepEqual(mapRole(INVENTED_DW, 'development', SUFFIXES), {
    state: 'ready',
    vars: {
      SFCC_SERVER: INVENTED_DW['hostname-dev'],
      SFCC_CLIENT_ID: INVENTED_DW['client-id-dev'],
      SFCC_CLIENT_SECRET: INVENTED_DW['client-secret-dev']
    }
  })
  // Staging's empty secret is absent, never the sandbox's: a host with no usable credentials.
  assert.deepEqual(mapRole(INVENTED_DW, 'staging', SUFFIXES), {
    state: 'incomplete',
    reason: 'credentials_missing',
    vars: { SFCC_SERVER: INVENTED_DW['hostname-stg'], SFCC_CLIENT_ID: INVENTED_DW['client-id-stg'] }
  })
})

test('a role is absent unless its hostname key exists and is not empty', () => {
  // Production has a client id and secret but no hostname-prd: absent, its values still known.
  assert.deepEqual(mapRole(INVENTED_DW, 'production', SUFFIXES), {
    state: 'absent',
    vars: { SFCC_CLIENT_ID: INVENTED_DW['client-id-prd'], SFCC_CLIENT_SECRET: INVENTED_DW['client-secret-prd'] }
  })
  assert.equal(mapRole({ ...INVENTED_DW, 'hostname-prd': '' }, 'production', SUFFIXES).state, 'absent')
  assert.equal(mapRole({ ...INVENTED_DW, 'hostname-prd': '   ' }, 'production', SUFFIXES).state, 'absent')
  assert.equal(mapRole({ ...INVENTED_DW, hostname: '' }, 'sandbox', SUFFIXES).state, 'absent')
  assert.equal(mapRole({ ...INVENTED_DW, 'hostname-prd': 'production-01.example.com' }, 'production', SUFFIXES).state, 'ready')
  assert.deepEqual(mapRole({ hostname: 42 }, 'sandbox', SUFFIXES), { state: 'absent', vars: {} }, 'only strings count')
  assert.deepEqual(mapRole(null, 'sandbox', SUFFIXES), { state: 'absent', vars: {} })
  assert.deepEqual(mapRole(['hostname'], 'sandbox', SUFFIXES), { state: 'absent', vars: {} })
})

test('a role with a host is ready only with credentials one of its sign-in methods can use', () => {
  const host = { hostname: 'sandbox-03.example.com', 'hostname-dev': 'dev-03.example.com' }
  const state = (dw: Record<string, string>, role: 'sandbox' | 'development') => {
    const { state: answer, reason } = mapRole({ ...host, ...dw }, role, SUFFIXES)
    return reason ? `${answer}: ${reason}` : answer
  }
  assert.equal(state({}, 'sandbox'), 'incomplete: credentials_missing')
  assert.equal(state({ 'client-id': 'id' }, 'sandbox'), 'incomplete: credentials_missing')
  assert.equal(state({ 'client-secret': 'secret' }, 'sandbox'), 'incomplete: credentials_missing')
  assert.equal(state({ username: 'user', password: '' }, 'sandbox'), 'incomplete: credentials_missing')
  assert.equal(state({ 'client-id': 'id', 'client-secret': 'secret' }, 'sandbox'), 'ready')
  // A user and password sign in on the sandbox only.
  assert.equal(state({ username: 'user', password: 'pass' }, 'sandbox'), 'ready')
  assert.equal(state({ 'username-dev': 'user', 'password-dev': 'pass' }, 'development'), 'incomplete: credentials_missing')
  assert.equal(state({ 'client-id-dev': 'id', 'client-secret-dev': 'secret' }, 'development'), 'ready')
  assert.ok(hasCredentials('sandbox', { SFCC_USERNAME: 'u', SFCC_PASSWORD: 'p' }))
  assert.ok(!hasCredentials('production', { SFCC_USERNAME: 'u', SFCC_PASSWORD: 'p' }))
})

test('a value with a control character makes its role unusable, whichever key holds it', () => {
  for (const key of ['hostname', 'username', 'password', 'client-id', 'client-secret', 'short-code', 'tenant-id']) {
    for (const bad of ['a\u0000b', 'a\nb', 'a\tb', 'a\u001fb', 'a\u007fb']) {
      const role = mapRole({ ...INVENTED_DW, [key]: bad }, 'sandbox', SUFFIXES)
      assert.equal(role.state, 'incomplete', `${key} ${JSON.stringify(bad)}`)
      assert.equal(role.reason, 'value_invalid', `${key} ${JSON.stringify(bad)}`)
    }
  }
  // Another role's keys do not matter.
  assert.equal(mapRole({ ...INVENTED_DW, 'client-secret-dev': 'a\u0000b' }, 'sandbox', SUFFIXES).state, 'ready')
})

test('follows the suffixes set in Settings, and refuses an empty or shared one', () => {
  const dw = { 'hostname.dev': 'dev-03.example.com', 'client-id.dev': 'id', 'client-secret.dev': 'secret', hostname: 'sbx.example.com' }
  assert.deepEqual(mapRole(dw, 'development', { ...SUFFIXES, development: '.dev' }), {
    state: 'ready',
    vars: { SFCC_SERVER: 'dev-03.example.com', SFCC_CLIENT_ID: 'id', SFCC_CLIENT_SECRET: 'secret' }
  })
  assert.deepEqual(mapRole(dw, 'development', { ...SUFFIXES, development: '' }), { state: 'absent', vars: {} })
  assert.deepEqual(mapRole(INVENTED_DW, 'development', { ...SUFFIXES, staging: '-dev' }), { state: 'absent', vars: {} })
})

test('reads dw.json at the workspace root, a configured file, or none', async () => {
  const root = makeWorkspace()
  try {
    const options = { root, configFile: '', suffixes: SUFFIXES }
    const loaded = await loadConfig(options)
    assert.equal(loaded.state, 'ok')
    assert.equal(loaded.roles.development.vars.SFCC_SERVER, INVENTED_DW['hostname-dev'])
    assert.deepEqual(
      Object.fromEntries(Object.entries(loaded.roles).map(([role, config]) => [role, config.state])),
      { sandbox: 'ready', development: 'ready', staging: 'incomplete', production: 'absent' }
    )
    assert.equal((await loadConfig({ ...options, root: null })).state, 'missing')

    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', 'other.json'), JSON.stringify({ hostname: 'other-01.example.com' }))
    assert.equal((await loadConfig({ ...options, configFile: 'config/other.json' })).roles.sandbox.vars.SFCC_SERVER, 'other-01.example.com')
    assert.equal((await loadConfig({ ...options, configFile: join(root, 'config', 'other.json') })).roles.sandbox.vars.SFCC_SERVER, 'other-01.example.com')
    const missing = await loadConfig({ ...options, configFile: 'missing.json' })
    assert.equal(missing.state, 'missing')
    assert.deepEqual(missing.roles.sandbox, { state: 'absent', vars: {} })

    // A byte order mark is accepted.
    writeFileSync(join(root, 'dw.json'), `﻿${JSON.stringify({ hostname: 'bom-01.example.com' })}`)
    assert.equal((await loadConfig(options)).roles.sandbox.vars.SFCC_SERVER, 'bom-01.example.com')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a worktree with no dw.json reads the one of the main checkout', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sfcc-tools-git-'))
  try {
    const main = join(base, 'main')
    const worktree = join(base, 'worktrees', 'feature')
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..\n')
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`)
    writeFileSync(join(main, 'dw.json'), JSON.stringify(INVENTED_DW))

    assert.equal(await mainCheckoutOf(worktree), main)
    assert.equal(await mainCheckoutOf(main), null, 'a main checkout has a .git folder, not a file')
    assert.equal((await locateConfig(worktree, ''))?.path, join(main, 'dw.json'))
    assert.equal((await loadConfig({ root: worktree, configFile: '', suffixes: SUFFIXES })).roles.sandbox.vars.SFCC_SERVER, INVENTED_DW.hostname)

    // The worktree's own file wins.
    writeFileSync(join(worktree, 'dw.json'), JSON.stringify({ hostname: 'worktree-01.example.com' }))
    assert.equal((await loadConfig({ root: worktree, configFile: '', suffixes: SUFFIXES })).roles.sandbox.vars.SFCC_SERVER, 'worktree-01.example.com')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a file that is not a JSON object is invalid, with every role absent and nothing of it quoted', async () => {
  for (const text of [`{"hostname": "${INVENTED_DW.hostname}", "password": "${INVENTED_DW.password}" oops`, `["${INVENTED_DW.hostname}"]`, `"${INVENTED_DW.password}"`, '']) {
    const root = makeWorkspace(text)
    try {
      const loaded = await loadConfig({ root, configFile: '', suffixes: SUFFIXES })
      assert.equal(loaded.state, 'invalid', text)
      for (const role of Object.values(loaded.roles)) assert.deepEqual(role, { state: 'absent', vars: {} })
      assertNoSecrets(JSON.stringify(loaded), 'the answer')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
