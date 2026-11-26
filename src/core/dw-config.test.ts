// The mapping of dw.json to b2c's variables, on invented files in temporary folders.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, locateConfig, mainCheckoutOf, mapRole, resolveRole } from './dw-config'
import { assertNoSecrets, INVENTED_DW, makeWorkspace } from './test-support'

const SUFFIXES = { development: '-dev', staging: '-stg', production: '-prd' }

test('maps the plain keys to the sandbox', () => {
  assert.deepEqual(mapRole(INVENTED_DW, 'sandbox', SUFFIXES), {
    SFCC_SERVER: INVENTED_DW.hostname,
    SFCC_USERNAME: INVENTED_DW.username,
    SFCC_PASSWORD: INVENTED_DW.password,
    SFCC_CLIENT_ID: INVENTED_DW['client-id'],
    SFCC_CLIENT_SECRET: INVENTED_DW['client-secret'],
    SFCC_SHORTCODE: INVENTED_DW['short-code'],
    SFCC_TENANT_ID: INVENTED_DW['tenant-id']
  })
})

test('maps the suffixed keys to their role, with no fallback to the plain ones', () => {
  // Development has no username, password, short code or tenant: they stay absent.
  assert.deepEqual(mapRole(INVENTED_DW, 'development', SUFFIXES), {
    SFCC_SERVER: INVENTED_DW['hostname-dev'],
    SFCC_CLIENT_ID: INVENTED_DW['client-id-dev'],
    SFCC_CLIENT_SECRET: INVENTED_DW['client-secret-dev']
  })
  // Staging's empty secret is absent, never the sandbox's.
  assert.deepEqual(mapRole(INVENTED_DW, 'staging', SUFFIXES), {
    SFCC_SERVER: INVENTED_DW['hostname-stg'],
    SFCC_CLIENT_ID: INVENTED_DW['client-id-stg']
  })
})

test('a role is configured only when its hostname key exists and is not empty', () => {
  // Production has a client id and secret but no hostname-prd.
  assert.equal(mapRole(INVENTED_DW, 'production', SUFFIXES), null)
  assert.equal(mapRole({ ...INVENTED_DW, 'hostname-prd': '' }, 'production', SUFFIXES), null)
  assert.equal(mapRole({ ...INVENTED_DW, 'hostname-prd': '   ' }, 'production', SUFFIXES), null)
  assert.equal(mapRole({ ...INVENTED_DW, hostname: '' }, 'sandbox', SUFFIXES), null)
  assert.ok(mapRole({ 'hostname-prd': 'production-01.example.com' }, 'production', SUFFIXES))
  assert.equal(mapRole({ hostname: 42 }, 'sandbox', SUFFIXES), null, 'only strings count')
  assert.equal(mapRole(null, 'sandbox', SUFFIXES), null)
  assert.equal(mapRole(['hostname'], 'sandbox', SUFFIXES), null)
})

test('follows the suffixes set in Settings, and refuses an empty or shared one', () => {
  const dw = { 'hostname.dev': 'dev-03.example.com', 'client-id.dev': 'id', hostname: 'sbx.example.com' }
  assert.deepEqual(mapRole(dw, 'development', { ...SUFFIXES, development: '.dev' }), { SFCC_SERVER: 'dev-03.example.com', SFCC_CLIENT_ID: 'id' })
  assert.equal(mapRole(dw, 'development', { ...SUFFIXES, development: '' }), null)
  assert.equal(mapRole(INVENTED_DW, 'development', { ...SUFFIXES, staging: '-dev' }), null)
})

test('reads dw.json at the workspace root, a configured file, or none', async () => {
  const root = makeWorkspace()
  try {
    const options = { root, configFile: '', suffixes: SUFFIXES }
    assert.equal((await resolveRole('development', options))?.SFCC_SERVER, INVENTED_DW['hostname-dev'])
    assert.equal(await resolveRole('production', options), null)
    assert.equal(await resolveRole('sandbox', { ...options, root: null }), null)

    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', 'other.json'), JSON.stringify({ hostname: 'other-01.example.com' }))
    assert.equal((await resolveRole('sandbox', { ...options, configFile: 'config/other.json' }))?.SFCC_SERVER, 'other-01.example.com')
    assert.equal((await resolveRole('sandbox', { ...options, configFile: join(root, 'config', 'other.json') }))?.SFCC_SERVER, 'other-01.example.com')
    assert.equal(await resolveRole('sandbox', { ...options, configFile: 'missing.json' }), null)

    // A byte order mark is accepted.
    writeFileSync(join(root, 'dw.json'), `﻿${JSON.stringify({ hostname: 'bom-01.example.com' })}`)
    assert.equal((await resolveRole('sandbox', options))?.SFCC_SERVER, 'bom-01.example.com')
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
    assert.equal((await resolveRole('sandbox', { root: worktree, configFile: '', suffixes: SUFFIXES }))?.SFCC_SERVER, INVENTED_DW.hostname)

    // The worktree's own file wins.
    writeFileSync(join(worktree, 'dw.json'), JSON.stringify({ hostname: 'worktree-01.example.com' }))
    assert.equal((await resolveRole('sandbox', { root: worktree, configFile: '', suffixes: SUFFIXES }))?.SFCC_SERVER, 'worktree-01.example.com')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a file that is not JSON throws a ConfigError that quotes nothing of it', async () => {
  const root = makeWorkspace(`{"hostname": "${INVENTED_DW.hostname}", "password": "${INVENTED_DW.password}" oops`)
  try {
    await resolveRole('sandbox', { root, configFile: '', suffixes: SUFFIXES })
    assert.fail('should throw')
  } catch (error) {
    assert.ok(error instanceof ConfigError)
    assert.equal(error.message, 'config_invalid')
    assertNoSecrets(`${error.message}\n${error.stack}`, 'the error')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
