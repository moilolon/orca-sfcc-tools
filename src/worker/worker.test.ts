// The worker over a mock host, a fake b2c and an invented dw.json: core.status, and what reaches
// the panel, storage and the log.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { rmSync } from 'node:fs'
import { assertNoSecrets, fakeSpawner, INVENTED_DW, makeWorkspace, type SpawnCall } from '../core/test-support'
import { createActivate, deactivate } from './worker'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const MACHINE = {
  platform: 'linux',
  env: { PATH: '/fake/bin' },
  homedir: '/home/someone',
  isFile: async (path: string) => path === '/fake/bin/b2c',
  isDirectory: async () => true
}
const ABSENT = { sandbox: 'absent', development: 'absent', staging: 'absent', production: 'absent' }

function hostFor(root: string | null, settings: Record<string, string> = {}, hostId: string | null = 'local') {
  return mockHost({
    capabilities: CAPABILITIES,
    settings,
    results: {
      'workspace.list': {
        workspaces: root ? [{ id: 'w1', kind: 'folder', name: 'shop', path: root, branch: null, hostId }] : [],
        truncated: false
      },
      'workspace.readContext': root ? { workspaceId: 'w1', branch: '', displayName: 'shop', terminals: [] } : null
    }
  })
}

async function mount(root: string | null, script: (call: SpawnCall) => void, settings: Record<string, string> = {}, hostId: string | null = 'local') {
  const spawn = fakeSpawner(script)
  const worker = await mountWorker({ default: createActivate({ ...MACHINE, spawn: spawn.spawn, killTree: (child) => child.kill() }), deactivate }, { host: hostFor(root, settings, hostId) })
  return { worker, calls: spawn.calls }
}

const VERSION = '@salesforce/b2c-cli/9.8.7 linux-x64 node-v24.0.0\n'

test('core.status: b2c found, the state of dw.json and of each role, every piece', async () => {
  const root = makeWorkspace()
  try {
    const { worker, calls } = await mount(root, (call) => call.child.finish(0, VERSION))
    const status = await worker.request('core.status', { locale: 'es-ES' })
    assert.deepEqual(status, {
      b2c: { found: true, version: '9.8.7' },
      config: 'ok',
      // Staging has a host and a client id but no secret; production has no host.
      instances: { sandbox: 'ready', development: 'ready', staging: 'incomplete', production: 'absent' },
      pieces: ['isml', 'sandbox', 'errors', 'debugger', 'engine', 'editor']
    })
    // The status asks b2c for its version, once. A piece may have asked for something of its
    // own when it started: that is its business, and its own tests'.
    const version = calls.filter((call) => call.args[0] === '--version')
    assert.equal(version.length, 1, 'b2c --version ran once')
    assert.deepEqual(version[0].args, ['--version'])
    assert.equal(version[0].options.cwd, '/home/someone')
    // The panel's language is kept for notifications, under core's namespace.
    assert.equal(worker.host.data().storage['core.locale'], 'es-ES')
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('core.status never throws: a missing or failing b2c is not found, with a reason', async () => {
  const cases: [string, (call: SpawnCall) => void, Record<string, string>, string][] = [
    ['wrong path', () => {}, { b2cPath: '/nowhere/b2c' }, 'b2c_not_found'],
    ['cannot start', (call) => call.child.emit('error', Object.assign(new Error('spawn failed'), { code: 'EACCES' })), {}, 'b2c_failed'],
    ['exits with an error', (call) => call.child.finish(126, '', 'ERROR: broken\n'), {}, 'b2c_failed'],
    ['prints no version', (call) => call.child.finish(0, 'hello\n'), {}, 'no_version']
  ]
  for (const [name, script, settings, reason] of cases) {
    const { worker } = await mount(null, script, settings)
    const status = await worker.request('core.status', {})
    assert.deepEqual(status.b2c, { found: false, version: null, reason }, name)
    assert.equal(status.config, 'missing', name)
    assert.deepEqual(status.instances, ABSENT, name)
    await worker.deactivate()
  }
})

test('core.status says a dw.json that is not JSON is invalid, not that four roles are absent', async () => {
  const root = makeWorkspace(`{ "hostname": "${INVENTED_DW.hostname}", "password": "${INVENTED_DW.password}" broken`)
  try {
    const { worker } = await mount(root, (call) => call.child.finish(0, VERSION))
    const status = await worker.request('core.status', {})
    assert.equal(status.config, 'invalid')
    assert.deepEqual(status.instances, ABSENT)
    assertNoSecrets(JSON.stringify(status), 'the answer')
    assertNoSecrets(worker.logs.join('\n'), 'the log')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('values read from dw.json reach only the child’s environment: not the panel, storage, log or posts', async () => {
  const root = makeWorkspace()
  try {
    const leaky = (call: SpawnCall) => call.child.finish(0, VERSION, `INFO: ${JSON.stringify(call.options.env)}\n`)
    const { worker } = await mount(root, leaky)
    const answers = [await worker.request('core.status', { locale: 'en' }), await worker.request('core.status', {})]
    assertNoSecrets(JSON.stringify(answers), 'an answer to the panel')
    assertNoSecrets(JSON.stringify(worker.host.data()), 'storage or settings')
    assertNoSecrets(worker.logs.join('\n'), 'the log')
    assertNoSecrets(JSON.stringify(worker.posts), 'a post to the panel')
    assertNoSecrets(JSON.stringify(worker.host.calls), 'a host call')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the uploading workspace, not the focused one, decides which dw.json is read', async () => {
  const focused = makeWorkspace({ hostname: 'focused-01.example.com' })
  const uploading = makeWorkspace({ hostname: 'uploading-01.example.com', 'hostname-dev': 'dev-01.example.com' })
  try {
    const host = mockHost({
      capabilities: CAPABILITIES,
      storage: { 'core.uploading': 'w2' },
      results: {
        'workspace.list': {
          workspaces: [
            { id: 'w1', kind: 'folder', name: 'a', path: focused, branch: null, hostId: 'local' },
            { id: 'w2', kind: 'folder', name: 'b', path: uploading, branch: null, hostId: 'local' }
          ],
          truncated: false
        },
        'workspace.readContext': { workspaceId: 'w1', branch: '', displayName: 'a', terminals: [] }
      }
    })
    const spawn = fakeSpawner((call) => call.child.finish(0, VERSION))
    const worker = await mountWorker({ default: createActivate({ ...MACHINE, spawn: spawn.spawn }), deactivate }, { host })
    const status = await worker.request('core.status', {})
    // Only the uploading workspace's file has a development host; neither has credentials.
    assert.equal(status.instances.development, 'incomplete')
    await worker.deactivate()
  } finally {
    rmSync(focused, { recursive: true, force: true })
    rmSync(uploading, { recursive: true, force: true })
  }
})

test('a workspace on another host is never read as a folder of this machine', async () => {
  // The same path exists here and holds a dw.json, but the workspace lives elsewhere.
  const root = makeWorkspace()
  try {
    for (const hostId of ['ssh:build-01', 'runtime:remote']) {
      const { worker } = await mount(root, (call) => call.child.finish(0, VERSION), {}, hostId)
      const status = await worker.request('core.status', {})
      assert.equal(status.config, 'missing', hostId)
      assert.deepEqual(status.instances, ABSENT, hostId)
      await worker.deactivate()
    }
    for (const hostId of ['local', null]) {
      const { worker } = await mount(root, (call) => call.child.finish(0, VERSION), {}, hostId)
      assert.equal((await worker.request('core.status', {})).config, 'ok', String(hostId))
      await worker.deactivate()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
