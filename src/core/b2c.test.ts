// The runner over a fake process (guard, environment, arguments, output, errors), and on Windows
// over a real `.cmd` shim that echoes what it received.
import { assert, test } from 'orca/testing'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  B2cError,
  childEnvironment,
  commandFor,
  createB2c,
  errorMessageOf,
  escapeShimArgument,
  parseVersion,
  quoteWindowsArgument,
  redact,
  resolveExecutable,
  type B2c,
  type B2cEvent
} from './b2c'
import type { Role } from './instances'
import { assertNoSecrets, fakeSpawner, INVENTED_DW, makeWorkspace, plainSettings } from './test-support'

const POSIX = { platform: 'linux', env: { PATH: '/fake/bin', HOME: '/home/someone' }, isFile: async (path: string) => path === '/fake/bin/b2c', homedir: '/home/someone' }

function runner(root: string | null, spawn = fakeSpawner(), extra: Partial<Parameters<typeof createB2c>[0]> = {}) {
  const logs: string[] = []
  const b2c = createB2c({ settings: plainSettings(), configRoot: async () => root, log: (line) => logs.push(line), spawn: spawn.spawn, killTree: (child) => child.kill(), ...POSIX, ...extra })
  return { b2c, calls: spawn.calls, logs }
}

async function failureOf(promise: Promise<unknown>): Promise<B2cError | string> {
  try {
    await promise
  } catch (error) {
    return error instanceof B2cError ? error : `not a B2cError: ${String(error)}`
  }
  return 'resolved'
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const failure = await failureOf(promise)
  return failure instanceof B2cError ? failure.code : failure
}

async function withWorkspace(check: (root: string) => Promise<void>, dw?: Record<string, string> | string): Promise<void> {
  const root = makeWorkspace(dw)
  try {
    await check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Every command that uploads, debugs or touches the sandbox, in both spellings oclif accepts. */
const SANDBOX_ONLY = [
  ['code', 'deploy'],
  ['code', 'watch'],
  ['code', 'activate', 'v1'],
  ['code', 'delete', 'v1'],
  ['code', 'list'],
  ['code:deploy'],
  ['code:activate', 'v1'],
  ['debug'],
  ['debug', 'start'],
  ['debug:start'],
  ['sandbox', 'list'],
  ['sandbox', 'start'],
  ['sandbox', 'stop'],
  ['sandbox:start'],
  ['ods', 'list'],
  ['ods', 'start'],
  ['ods:stop']
]

test('refuses every code, debug and sandbox command on development, staging and production', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    for (const role of ['development', 'staging', 'production'] as Role[]) {
      for (const args of SANDBOX_ONLY) {
        assert.equal(await codeOf(b2c.run(args, { role })), 'role_refused', `${args.join(' ')} on ${role}`)
        assert.equal(await codeOf(b2c.start(args, { role })), 'role_refused', `${args.join(' ')} on ${role} (start)`)
      }
    }
    assert.equal(calls.length, 0, 'no process was started')
  }))

test('the other roles read logs and nothing else; unknown topics are refused everywhere', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    for (const args of [['webdav', 'put', 'x'], ['job', 'run', 'x'], ['auth', 'token'], ['--json', 'code', 'deploy'], ['bm', 'roles']]) {
      for (const role of ['sandbox', 'development', 'staging', 'production'] as Role[]) {
        assert.equal(await codeOf(b2c.run(args, { role })), 'role_refused', `${args.join(' ')} on ${role}`)
      }
    }
    assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'development' })), 'resolved')
    assert.equal(await codeOf(b2c.run(['code', 'list'], { role: 'sandbox' })), 'resolved')
    assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'sandbox' })), 'resolved')
    assert.equal(await codeOf(b2c.run(['code', 'list'])), 'role_required')
    assert.equal(calls.length, 3)
  }))

test('never starts b2c for a role that is not configured or has no credentials', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    // Production has no hostname-prd; staging has a host and a client id but an empty secret.
    assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'production' })), 'role_not_configured')
    assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'staging' })), 'credentials_missing')
    assert.equal(await codeOf(b2c.start(['logs', 'tail'], { role: 'staging' })), 'credentials_missing')
    assert.equal(await b2c.configured('staging'), true, 'configured means a host; running needs credentials too')
    assert.equal(calls.length, 0)
  }))

test('a sandbox may sign in with a user and password alone; other roles may not', () =>
  withWorkspace(
    async (root) => {
      const { b2c, calls } = runner(root)
      assert.equal(await codeOf(b2c.run(['code', 'list'], { role: 'sandbox' })), 'resolved')
      assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'development' })), 'credentials_missing')
      assert.equal(calls.length, 1)
    },
    { hostname: 'sandbox-02.example.com', username: 'user@example.com', password: 'invented-pass', 'hostname-dev': 'dev-02.example.com', 'username-dev': 'u', 'password-dev': 'p' }
  ))

test('pins the sign-in methods: client credentials, plus basic on the sandbox; never a browser', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    await b2c.run(['code', 'list'], { role: 'sandbox' })
    await b2c.run(['logs', 'get'], { role: 'development' })
    await b2c.run(['docs', 'search', 'x'])
    assert.deepEqual(
      calls.map((call) => call.options.env.SFCC_AUTH_METHODS),
      ['client-credentials,basic', 'client-credentials', 'client-credentials']
    )
    assert.equal(await codeOf(b2c.run(['logs', 'get', '--auth-methods', 'implicit'], { role: 'sandbox' })), 'unsafe_argument')
  }))

test('docs and --version need no role and get no credentials', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root, fakeSpawner((call) => call.child.finish(0, '@salesforce/b2c-cli/9.8.7 linux-x64 node-v24.0.0\n')))
    assert.equal(await b2c.version(), '9.8.7')
    await b2c.run(['docs', 'search', 'ProductMgr'], { role: 'production' })
    assert.deepEqual(calls[0].args, ['--version'])
    assert.deepEqual(calls[1].args, ['docs', 'search', 'ProductMgr', '--json'])
    for (const call of calls) {
      const sfcc = Object.keys(call.options.env).filter((key) => key.startsWith('SFCC_')).sort()
      assert.deepEqual(sfcc, ['SFCC_AUTH_METHODS', 'SFCC_CONFIG', 'SFCC_DOTENV_FILE'])
    }
  }))

test('puts the role’s values in the environment only, with no config or .env file and inherited SFCC_* dropped', () =>
  withWorkspace(async (root) => {
    const env = { ...POSIX.env, SFCC_SERVER: 'inherited.example.com', sfcc_password: 'inherited', SFCC_CONFIG: '/somewhere/dw.json', SFCC_INSTANCE: 'other', KEEP_ME: '1' }
    const { b2c, calls, logs } = runner(root, fakeSpawner(), { env })
    await b2c.run(['code', 'list'], { role: 'sandbox', cwd: root })
    await b2c.run(['logs', 'get', '--level', 'ERROR'], { role: 'development' })

    const [sandbox, development] = calls
    assert.deepEqual(sandbox.args, ['code', 'list', '--json'])
    assert.equal(sandbox.options.cwd, root)
    assert.equal(sandbox.options.env.KEEP_ME, '1')
    assert.equal(sandbox.options.env.sfcc_password, undefined)
    assert.equal(sandbox.options.env.SFCC_INSTANCE, undefined)
    assert.equal(sandbox.options.env.SFCC_CONFIG, '')
    assert.equal(sandbox.options.env.SFCC_DOTENV_FILE, '')
    assert.equal(sandbox.options.env.SFCC_SERVER, INVENTED_DW.hostname)
    assert.equal(sandbox.options.env.SFCC_USERNAME, INVENTED_DW.username)
    assert.equal(sandbox.options.env.SFCC_PASSWORD, INVENTED_DW.password)
    assert.equal(sandbox.options.env.SFCC_CLIENT_ID, INVENTED_DW['client-id'])
    assert.equal(sandbox.options.env.SFCC_CLIENT_SECRET, INVENTED_DW['client-secret'])
    assert.equal(sandbox.options.env.SFCC_SHORTCODE, INVENTED_DW['short-code'])
    assert.equal(sandbox.options.env.SFCC_TENANT_ID, INVENTED_DW['tenant-id'])

    // Development has only its own keys: no username or password, nothing of the sandbox's.
    assert.equal(development.options.env.SFCC_SERVER, INVENTED_DW['hostname-dev'])
    assert.equal(development.options.env.SFCC_CLIENT_ID, INVENTED_DW['client-id-dev'])
    assert.equal(development.options.env.SFCC_CLIENT_SECRET, INVENTED_DW['client-secret-dev'])
    for (const key of ['SFCC_USERNAME', 'SFCC_PASSWORD', 'SFCC_SHORTCODE', 'SFCC_TENANT_ID']) assert.equal(development.options.env[key], undefined, key)

    for (const call of calls) assertNoSecrets(JSON.stringify(call.args), 'arguments')
    assertNoSecrets(logs.join('\n'), 'the log')
  }))

test('refuses connection flags and any argument that holds a value of dw.json', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    for (const args of [
      ['logs', 'get', '--server', 'other.example.com'],
      ['logs', 'get', '--server=other.example.com'],
      ['logs', 'get', '--client-secret', 'x'],
      ['logs', 'get', '--config', 'dw.json'],
      ['logs', 'get', '--instance', 'x'],
      ['code', 'list', '--password=x'],
      ['logs', 'get', `--filter=${INVENTED_DW['client-id']}`],
      ['logs', 'get', INVENTED_DW.hostname]
    ]) {
      assert.equal(await codeOf(b2c.run(args, { role: 'sandbox' })), 'unsafe_argument', args.join(' '))
    }
    assert.equal(calls.length, 0)
  }))

test('success is exit 0 alone: JSON parsed from stdout, an empty stdout is no value, stderr noise is ignored', () =>
  withWorkspace(async (root) => {
    const outputs: Record<string, [number, string, string]> = {
      list: [0, '{\n  "versions": [\n    "v1"\n  ]\n}\n', 'INFO: listing\n » Warning: update available\n'],
      activate: [0, '', 'INFO: activated\n'],
      // A version manager's shim turns every failure into 126.
      shim: [126, '', '{"error":{"message":"Unauthorized","code":1}}\n'],
      one: [1, '', ''],
      // Even exit 0 is success when stdout is not JSON; there is just no value.
      text: [0, 'done', '']
    }
    const { b2c } = runner(root, fakeSpawner((call) => call.child.finish(...outputs[call.args[1]])))
    assert.deepEqual((await b2c.run(['code', 'list'], { role: 'sandbox' })).json, { versions: ['v1'] })
    const activated = await b2c.run(['code', 'activate'], { role: 'sandbox' })
    assert.equal(activated.json, undefined)
    assert.equal(activated.stdout, '')
    const shim = await failureOf(b2c.run(['code', 'shim'], { role: 'sandbox' }))
    assert.ok(shim instanceof B2cError)
    assert.equal(shim.code, 'b2c_failed')
    assert.equal(shim.exitCode, 126)
    assert.equal(shim.detail, 'Unauthorized')
    const one = await failureOf(b2c.run(['code', 'one'], { role: 'sandbox' }))
    assert.ok(one instanceof B2cError)
    assert.equal(one.detail, null)
    assert.equal((await b2c.run(['code', 'text'], { role: 'sandbox' })).json, undefined)
  }))

test('reads b2c’s error from the last JSON line of stderr, else its last ERROR: line', () => {
  const json = [
    'INFO: connecting',
    '{"error":{"message":"first","code":1}}',
    'ERROR: something',
    '{"error":{"message":"Request failed","code":1,"cause":{"name":"NetworkError","message":"x"}}}',
    ' » Warning: update available'
  ].join('\n')
  assert.equal(errorMessageOf(json), 'Request failed')
  assert.equal(errorMessageOf('INFO: a\nERROR: Code version v9 not found\nERROR: Command failed\n'), 'Command failed')
  assert.equal(errorMessageOf('INFO: only info\n{"not":"an error"}'), null)
  assert.equal(errorMessageOf(''), null)
})

test('errors carry their code, and b2c’s message with hosts and credential values masked', () =>
  withWorkspace(async (root) => {
    // b2c's message names what it was given: the child's own host, user and secret.
    const failing = fakeSpawner((call) => {
      const env = call.options.env
      const leaky = `cannot reach ${env.SFCC_SERVER} (also edge.cdn.example.com) as ${env.SFCC_USERNAME ?? env.SFCC_CLIENT_ID} with ${env.SFCC_CLIENT_SECRET}`
      call.child.finish(1, '', `INFO: ${leaky}\n${JSON.stringify({ error: { message: leaky, code: 1 } })}\n`)
    })
    const { b2c, logs } = runner(root, failing)
    const errors: B2cError[] = []
    for (const run of [
      () => b2c.run(['code', 'list'], { role: 'sandbox' }),
      () => b2c.run(['logs', 'get'], { role: 'development' }),
      () => b2c.run(['code', 'deploy'], { role: 'production' }),
      () => b2c.run(['logs', 'get'], { role: 'production' }),
      () => b2c.run(['logs', 'get'], { role: 'staging' })
    ]) {
      const failure = await failureOf(run())
      assert.ok(failure instanceof B2cError, String(failure))
      errors.push(failure)
    }
    assert.deepEqual(errors.map((error) => error.code), ['b2c_failed', 'b2c_failed', 'role_refused', 'role_not_configured', 'credentials_missing'])
    // The role's own host is one of its values; any other host-shaped name is masked too.
    assert.equal(errors[0].detail, 'cannot reach *** (also <host>) as *** with ***')
    for (const error of errors) {
      assertNoSecrets(error.message, 'an error message')
      assertNoSecrets(String(error.detail), 'an error detail')
      assertNoSecrets(String(error.stack), 'an error stack')
      assertNoSecrets(JSON.stringify(error), 'a serialized error')
      assert.ok(!error.message.includes(root), 'no path in the message')
    }
    assertNoSecrets(logs.join('\n'), 'the log')

    // A dw.json that is not JSON: JSON.parse quotes the text, the runner does not.
    writeFileSync(join(root, 'dw.json'), `{ "hostname": "${INVENTED_DW.hostname}", broken`)
    const broken = await failureOf(b2c.run(['code', 'list'], { role: 'sandbox' }))
    assert.ok(broken instanceof B2cError)
    assert.equal(broken.code, 'config_invalid')
    assertNoSecrets(`${broken.message}\n${broken.stack}`, 'a config error')
    assert.equal(await b2c.configured('sandbox'), false)
  }))

test('redact masks every value and anything shaped like a host', () => {
  assert.equal(redact('a secret-value at x.y.example.com and 10.0.0.1', ['secret-value']), 'a *** at <host> and 10.0.0.1')
  assert.equal(redact('no hosts here: file.isml', []), 'no hosts here: file.isml')
})

test('times out and aborts at once, without waiting for the pipes to close', () =>
  withWorkspace(async (root) => {
    // A process whose pipes never close, even once killed.
    const stuck = fakeSpawner(() => {})
    const { b2c, calls } = runner(root, stuck)
    assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'sandbox', timeoutMs: 10 })), 'b2c_timeout')
    assert.ok(calls[0].child.killed)
    const controller = new AbortController()
    const pending = b2c.run(['logs', 'get'], { role: 'sandbox', signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    assert.equal(await codeOf(pending), 'aborted')
    assert.ok(calls[1].child.killed)
  }))

test('a long-lived command gets --jsonl, hands over stderr line by line and stops at once', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root, fakeSpawner(() => {}))
    const events: B2cEvent[] = []
    const running = await b2c.start(['code', 'watch'], { role: 'sandbox', onEvent: (event) => events.push(event) })
    const child = calls[0].child
    child.stderr.emit('data', Buffer.from('{"level":"info","time":1,"command":"code:watch","msg":"watching"}\n » Warning: upd'))
    child.stderr.emit('data', Buffer.from('ate available\n{"level":"info","time":2,"msg":"up'))
    child.stderr.emit('data', Buffer.from('loaded"}\n'))
    running.stop()
    assert.ok(child.killed)
    // The pipes never closed, yet it is reported stopped.
    assert.deepEqual(await running.exited, { exitCode: null, stopped: true })
    assert.deepEqual(calls[0].args, ['code', 'watch', '--jsonl'])
    assert.deepEqual(events, [
      { json: { level: 'info', time: 1, command: 'code:watch', msg: 'watching' } },
      { text: ' » Warning: update available' },
      { json: { level: 'info', time: 2, msg: 'uploaded' } }
    ])
  }))

test('a long-lived command that ends by itself reports its exit code', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root, fakeSpawner(() => {}))
    const running = await b2c.start(['debug'], { role: 'sandbox' })
    calls[0].child.emit('exit', 3)
    assert.deepEqual(await running.exited, { exitCode: 3, stopped: false })
    assert.deepEqual(calls[0].args, ['debug', '--jsonl'])
  }))

test('a wrong b2c path is b2c_not_found, before any process starts', async () => {
  const { b2c, calls } = runner(null, fakeSpawner(), { settings: plainSettings({ b2cPath: '/nowhere/b2c' }) })
  assert.equal(await codeOf(b2c.version()), 'b2c_not_found')
  assert.equal(calls.length, 0)
})

test('finds a Windows shim through PATHEXT, never the extensionless script beside it', async () => {
  const files = new Set(['C:\\tools\\b2c', 'C:\\tools\\b2c.cmd', 'D:\\other dir\\b2c.exe'])
  const isFile = async (path: string) => files.has(path)
  const env = { Path: 'C:\\empty;C:\\tools\\', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  assert.equal(await resolveExecutable('b2c', { platform: 'win32', env, isFile }), 'C:\\tools\\b2c.cmd')
  assert.equal(await resolveExecutable('D:\\other dir\\b2c', { platform: 'win32', env, isFile }), 'D:\\other dir\\b2c.exe')
  assert.equal(await resolveExecutable('C:\\tools\\b2c.cmd', { platform: 'win32', env, isFile }), 'C:\\tools\\b2c.cmd')
  assert.equal(await resolveExecutable('missing', { platform: 'win32', env, isFile }), null)
})

test('builds a cmd.exe line for a shim and leaves an .exe to Node', () => {
  const shim = commandFor('C:\\tools dir\\b2c.cmd', ['docs', 'a b'], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } })
  assert.equal(shim.file, 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(shim.verbatim, true)
  assert.deepEqual(shim.args.slice(0, 4), ['/d', '/s', '/v:off', '/c'])
  assert.equal(shim.args[4], `""C:\\tools dir\\b2c.cmd" ${escapeShimArgument('docs')} ${escapeShimArgument('a b')}"`)
  assert.deepEqual(commandFor('C:\\b2c.exe', ['a b'], { platform: 'win32', env: {} }), { file: 'C:\\b2c.exe', args: ['a b'], verbatim: false })
  assert.throws(() => commandFor('C:\\b2c.cmd', ['line\nbreak'], { platform: 'win32', env: {} }), /unsafe_argument/)
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"')
  assert.equal(quoteWindowsArgument('dir\\'), '"dir\\\\"')
  assert.equal(parseVersion('@salesforce/b2c-cli/2.11.0 win32-x64 node-v25.8.1'), '2.11.0')
  assert.equal(parseVersion('nothing'), null)
})

test('childEnvironment drops SFCC_* whatever its case', () => {
  const env = childEnvironment({ Sfcc_Server: 'x', SFCC_INSTANCE: 'y', PATH: 'p' }, { SFCC_SERVER: 'h.example.com' }, { platform: 'linux', homedir: '/home/someone', role: 'development' })
  assert.deepEqual(env, { PATH: 'p', SFCC_CONFIG: '', SFCC_DOTENV_FILE: '', SFCC_AUTH_METHODS: 'client-credentials', SFCC_SERVER: 'h.example.com' })
})

test('on Windows, fills the profile folders a trimmed worker environment lacks, and keeps the ones it has', () => {
  const profile = { platform: 'win32', homedir: 'C:\\Users\\someone' }
  const filled = childEnvironment({ Path: 'C:\\bin' }, {}, profile)
  assert.equal(filled.USERPROFILE, 'C:\\Users\\someone')
  assert.equal(filled.APPDATA, 'C:\\Users\\someone\\AppData\\Roaming')
  assert.equal(filled.LOCALAPPDATA, 'C:\\Users\\someone\\AppData\\Local')
  const kept = childEnvironment({ AppData: 'D:\\roaming', USERPROFILE: 'D:\\me' }, {}, profile)
  assert.equal(kept.AppData, 'D:\\roaming')
  assert.equal(kept.APPDATA, undefined, 'no second spelling of a variable the worker has')
  assert.equal(kept.USERPROFILE, 'D:\\me')
  assert.equal(kept.LOCALAPPDATA, 'C:\\Users\\someone\\AppData\\Local')
  // Elsewhere nothing is added.
  assert.equal(childEnvironment({ PATH: '/bin' }, {}, { platform: 'linux', homedir: '/home/someone' }).APPDATA, undefined)
})

test('runs in the home folder unless told where, never in the worker’s own folder', async () => {
  const { b2c, calls } = runner(null, fakeSpawner(), { homedir: 'C:\\Users\\someone', platform: 'win32', env: { Path: 'C:\\fake' }, isFile: async (path) => path === 'C:\\fake\\b2c.exe' })
  await b2c.run(['docs', 'search', 'x'])
  await b2c.run(['docs', 'search', 'x'], { cwd: 'C:\\work' })
  assert.equal(calls[0].options.cwd, 'C:\\Users\\someone')
  assert.equal(calls[1].options.cwd, 'C:\\work')
  assert.equal(calls[0].options.env.APPDATA, 'C:\\Users\\someone\\AppData\\Roaming')
})

/** Arguments that cmd.exe would read itself if they were not escaped. */
const AWKWARD = [
  'hello world',
  'say "hi"',
  '"',
  '""',
  '',
  ' leading and trailing ',
  'trailing\\',
  'a\\"b',
  'C:\\path with spaces\\file.isml',
  '100%',
  '%PATH%',
  '%%',
  'x & y',
  'a"&echo injected&"',
  'a|b',
  '<in>',
  '^caret^',
  '(paren)',
  '!bang!',
  'semi;colon,comma',
  'eq=ual',
  '`tick`',
  '*?',
  'tab\there',
  'áéíóú ñ ü'
]

/**
 * A `.cmd` shim in a folder with a space and a parenthesis (as under "Program Files (x86)") that
 * starts Node by its full path, read from a variable so the batch file stays ASCII. It must not
 * go through a version manager's own shim, which parses arguments again.
 */
async function withShim(check: (b2c: B2c) => Promise<void>): Promise<void> {
  const dir = makeWorkspace({})
  const shimDir = join(dir, 'b2c (shim) dir')
  mkdirSync(shimDir)
  writeFileSync(join(shimDir, 'echo-args.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  writeFileSync(join(shimDir, 'b2c.cmd'), '@echo off\r\n"%ECHO_NODE%" "%~dp0echo-args.cjs" %*\r\n')
  const b2c = createB2c({
    settings: plainSettings({ b2cPath: join(shimDir, 'b2c.cmd') }),
    configRoot: async () => dir,
    env: { ...process.env, ECHO_NODE: process.execPath }
  })
  try {
    await check(b2c)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('on Windows, passes arguments with spaces, quotes and cmd.exe characters through a .cmd shim unchanged', async () => {
  if (process.platform !== 'win32') return
  await withShim(async (b2c) => {
    const all = await b2c.run(['docs', 'search', ...AWKWARD], { timeoutMs: 30_000 })
    assert.deepEqual(all.json, ['docs', 'search', ...AWKWARD, '--json'])
    for (const arg of AWKWARD) {
      const one = await b2c.run(['docs', arg], { timeoutMs: 30_000 })
      assert.deepEqual(one.json, ['docs', arg, '--json'], JSON.stringify(arg))
    }
  })
})

test('on Windows, starts the installed b2c shim for --version', async () => {
  if (process.platform !== 'win32') return
  const b2c = createB2c({ settings: plainSettings(), configRoot: async () => null })
  const found = await resolveExecutable('b2c', { platform: 'win32', env: process.env, isFile: async (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false })
  if (!found) return // b2c is not installed on this machine: the shim test above still covers the path.
  assert.match(String(await b2c.version()), /^\d+\.\d+\.\d+/)
})
