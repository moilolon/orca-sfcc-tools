// The runner over a fake process (guard, flags, environment, arguments, output, errors), over
// real Node children (a flood of stdout, an echo of stdin), and on Windows over a real `.cmd`
// shim that echoes what it received and over the b2c shim installed on the machine.
import { assert, test } from 'orca/testing'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  argumentWithValue,
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
  unsafeShimArgument,
  type B2c,
  type B2cEvent,
  type Spawner
} from './b2c'
import { ALLOWED_FLAGS, type Role } from './instances'
import { assertNoSecrets, fakeSpawner, INVENTED_DW, makeWorkspace, plainSettings } from './test-support'

const POSIX = {
  platform: 'linux',
  env: { PATH: '/fake/bin', HOME: '/home/someone' },
  isFile: async (path: string) => path === '/fake/bin/b2c',
  isDirectory: async () => true,
  homedir: '/home/someone'
}

const EVERY_ROLE: Role[] = ['sandbox', 'development', 'staging', 'production']

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

/** The code and the position of the refused argument, as `code@position`. */
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  const failure = await failureOf(promise)
  return failure instanceof B2cError ? `${failure.code}@${failure.argument}` : failure
}

async function withWorkspace(check: (root: string) => Promise<void>, dw?: Record<string, string> | string): Promise<void> {
  const root = makeWorkspace(dw)
  try {
    await check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// The role guard

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
      for (const role of EVERY_ROLE) {
        assert.equal(await codeOf(b2c.run(args, { role })), 'role_refused', `${args.join(' ')} on ${role}`)
      }
    }
    assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'development' })), 'resolved')
    assert.equal(await codeOf(b2c.run(['code', 'list'], { role: 'sandbox' })), 'resolved')
    assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'sandbox' })), 'resolved')
    assert.equal(await codeOf(b2c.run(['code', 'list'])), 'role_required')
    assert.equal(calls.length, 3)
  }))

// ---------------------------------------------------------------------------------------------
// The three states of a role

test('a role is ready, incomplete or absent, and only a ready one is ever started', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    // Production has no hostname-prd; staging has a host and a client id but an empty secret.
    assert.deepEqual(await b2c.instances(), {
      config: 'ok',
      instances: { sandbox: 'ready', development: 'ready', staging: 'incomplete', production: 'absent' }
    })
    assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'production' })), 'role_not_configured')
    assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'staging' })), 'credentials_missing')
    assert.equal(await codeOf(b2c.start(['logs', 'tail'], { role: 'staging' })), 'credentials_missing')
    assert.equal(calls.length, 0)
  }))

test('a sandbox is ready with a user and password alone; another role with only those is incomplete', () =>
  withWorkspace(
    async (root) => {
      const { b2c, calls } = runner(root)
      assert.deepEqual((await b2c.instances()).instances, { sandbox: 'ready', development: 'incomplete', staging: 'absent', production: 'absent' })
      assert.equal(await codeOf(b2c.run(['code', 'list'], { role: 'sandbox' })), 'resolved')
      assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'development' })), 'credentials_missing')
      assert.equal(calls.length, 1)
    },
    { hostname: 'sandbox-02.example.com', username: 'user@example.com', password: 'invented-pass', 'hostname-dev': 'dev-02.example.com', 'username-dev': 'u', 'password-dev': 'p' }
  ))

test('no dw.json is missing, one that is not a JSON object is invalid: neither is four absent roles in silence', async () => {
  const absent = { sandbox: 'absent', development: 'absent', staging: 'absent', production: 'absent' }
  assert.deepEqual(await runner(null).b2c.instances(), { config: 'missing', instances: absent })
  for (const text of [`{ "hostname": "${INVENTED_DW.hostname}", broken`, '["hostname"]', '"text"', 'null', '']) {
    await withWorkspace(async (root) => {
      const { b2c, calls } = runner(root)
      assert.deepEqual(await b2c.instances(), { config: 'invalid', instances: absent }, text)
      const broken = await failureOf(b2c.run(['code', 'list'], { role: 'sandbox' }))
      assert.ok(broken instanceof B2cError)
      assert.equal(broken.code, 'config_invalid')
      // JSON.parse quotes the text in its message; the runner does not.
      assertNoSecrets(`${broken.message}\n${broken.stack}\n${JSON.stringify(broken)}`, 'a config error')
      // A command that needs no role does not need the file either.
      assert.equal(await codeOf(b2c.run(['docs', 'search', 'x'])), 'resolved')
      assert.equal(calls.length, 1)
    }, text)
  }
})

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
    assert.equal(await codeOf(b2c.run(['logs', 'get', '--auth-methods', 'implicit'], { role: 'sandbox' })), 'flag_not_allowed')
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

// ---------------------------------------------------------------------------------------------
// The flag allow list

/**
 * Every flag of b2c that names a host, a user, a credential, an instance, a configuration or
 * `.env` file, a project folder, a certificate or a sign-in method: the ones the review listed
 * and the rest of b2c's own connection and sign-in flags.
 */
const REDIRECTING_FLAGS = [
  '-s',
  '--server',
  '--webdav-server',
  '--hostname',
  '-u',
  '--username',
  '--user',
  '-p',
  '--password',
  '-i',
  '--instance',
  '--config',
  '--dotenv-file',
  '--project-directory',
  '--default-client',
  '--user-auth',
  '--auth-methods',
  '--auth-scope',
  '--client-id',
  '--client-secret',
  '--client-auth-method',
  '--short-code',
  '--tenant-id',
  '--account-manager-host',
  '--sandbox-api-host',
  '--api-backend',
  '--jwt-key',
  '--jwt-cert',
  '--jwt-passphrase',
  '--certificate',
  '--passphrase',
  '--selfsigned'
]

/** A command each role may run, so the flag is what gets refused. */
const ALLOWED_COMMANDS: [Role | undefined, string[]][] = [
  ['sandbox', ['code', 'deploy']],
  ['sandbox', ['code', 'activate', 'v1']],
  ['sandbox', ['code', 'delete', 'v1']],
  ['sandbox', ['debug']],
  ['sandbox', ['sandbox', 'list']],
  ['sandbox', ['logs', 'get']],
  ['development', ['logs', 'get']],
  ['staging', ['logs', 'get']],
  ['production', ['logs', 'get']],
  [undefined, ['docs', 'search', 'x']]
]

test('refuses every flag that redirects the target or the sign-in, in every form, on every role', () =>
  withWorkspace(
    async (root) => {
      const { b2c, calls } = runner(root)
      for (const flag of REDIRECTING_FLAGS) {
        assert.ok(!ALLOWED_FLAGS.has(flag), `${flag} is in the allow list`)
        // `-s x`, `-s=x`, the value glued on (`-sx`) and the flag grouped behind an allowed one (`-as`).
        const forms = [[flag, 'other.example.com'], [`${flag}=other.example.com`]]
        if (/^-[a-z]$/.test(flag)) forms.push([`${flag}other.example.com`], [`-a${flag.slice(1)}`, 'other.example.com'])
        for (const form of forms) {
          for (const [role, command] of ALLOWED_COMMANDS) {
            const args = [...command, ...form]
            const where = `${args.join(' ')} on ${role ?? 'no role'}`
            assert.equal(await refusalOf(b2c.run(args, { role })), `flag_not_allowed@${command.length}`, where)
            assert.equal(await refusalOf(b2c.start(args, { role })), `flag_not_allowed@${command.length}`, `${where} (start)`)
          }
        }
      }
      assert.equal(calls.length, 0, 'no process was started')
    },
    // Every role ready, so nothing but the flag can refuse the command.
    { ...INVENTED_DW, 'client-secret-stg': 'invented-stg-client-secret', 'hostname-prd': 'production-01.example.com' }
  ))

test('a flag outside the list is refused whatever it is; the ones in it pass in both forms', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    for (const args of [
      ['code', 'deploy', '--anything'],
      ['code', 'deploy', '--Server=x'],
      ['code', 'deploy', '-S', 'x'],
      ['code', 'deploy', '-ar'],
      ['code', 'deploy', '--'],
      ['code', 'deploy', '-'],
      ['code', 'deploy', '--log-level', 'debug'],
      ['code', 'deploy', '-D']
    ]) {
      assert.equal(await refusalOf(b2c.run(args, { role: 'sandbox' })), 'flag_not_allowed@2', args.join(' '))
    }
    assert.equal(calls.length, 0)
    const allowed = [
      ['code', 'deploy', '-v', 'v1', '-c', 'app_one', '--cartridge=app_two', '-x', 'app_three', '-a', '-r', '--delete', '--cartridge-path', 'cartridges'],
      ['code', 'activate', 'v1', '--reload'],
      ['code', 'delete', 'v1', '--force'],
      ['logs', 'get', '-f', 'error', '--level=ERROR', '-n', '50', '--since', '1h', '-g', 'text', '--no-normalize', '--no-color'],
      ['logs', 'tail', '--last', '5', '--interval=2'],
      ['sandbox', 'list', '--realm', 'abcd', '--show-deleted', '--columns', 'id', '--extended'],
      ['sandbox', 'start', 'x', '--poll-interval', '5', '--timeout', '60']
    ]
    for (const args of allowed) assert.equal(await codeOf(b2c.run(args, { role: 'sandbox' })), 'resolved', args.join(' '))
    assert.deepEqual(calls.map((call) => call.args), allowed.map((args) => [...args, '--json']))
  }))

test('refuses any argument that holds a value of dw.json, whichever role it belongs to', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    const refused: [Role, string[], number][] = [
      ['sandbox', ['logs', 'get', `--filter=${INVENTED_DW['client-id']}`], 2],
      ['sandbox', ['logs', 'get', '--search', `x${INVENTED_DW.password}x`], 3],
      ['sandbox', ['logs', 'get', INVENTED_DW.hostname], 2],
      // A value of another role, even of one with no host, is still a value of the file.
      ['development', ['logs', 'get', '--search', INVENTED_DW['client-secret']], 3],
      ['sandbox', ['code', 'activate', INVENTED_DW['client-secret-prd']], 2]
    ]
    for (const [role, args, position] of refused) {
      assert.equal(await refusalOf(b2c.run(args, { role })), `unsafe_argument@${position}`, `argument ${position} on ${role}`)
    }
    assert.equal(calls.length, 0)
  }))

test('a value shorter than four characters blocks an argument only when it is the whole of it', () => {
  const values = ['ab', 'x', 'admin']
  assert.equal(argumentWithValue(['code', 'activate', 'cab-fix', 'xyz', '--search=cab'], values), -1)
  assert.equal(argumentWithValue(['code', 'activate', 'ab'], values), 2)
  assert.equal(argumentWithValue(['logs', 'get', '--search=ab'], values), 2)
  assert.equal(argumentWithValue(['logs', 'get', '--search', 'x'], values), 3)
  // Four characters or more: anywhere in the argument.
  assert.equal(argumentWithValue(['code', 'activate', 'my-admin-fix'], values), 2)
  assert.equal(argumentWithValue(['code', 'activate', 'v1'], ['', 'ab']), -1)
})

// ---------------------------------------------------------------------------------------------
// Output and errors

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
    const { b2c, calls } = runner(root, fakeSpawner((call) => call.child.finish(...outputs[call.args[1]])))
    assert.deepEqual((await b2c.run(['code', 'list'], { role: 'sandbox' })).json, { versions: ['v1'] })
    // A one-shot command has no stdin to wait on.
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
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

test('errors carry their code, and b2c’s message with hosts and the values of every role masked', () =>
  withWorkspace(async (root) => {
    // b2c's message names what it was given (the child's own host, user and secret) and, here,
    // values of the other roles too: another role's client id, and one of a role with no host.
    const failing = fakeSpawner((call) => {
      const env = call.options.env
      const leaky = `cannot reach ${env.SFCC_SERVER} (also edge.cdn.example.com) as ${env.SFCC_USERNAME ?? env.SFCC_CLIENT_ID} with ${env.SFCC_CLIENT_SECRET}, not ${INVENTED_DW['client-id']} or ${INVENTED_DW['client-secret-prd']}`
      call.child.finish(1, '', `INFO: ${leaky}\n${JSON.stringify({ error: { message: leaky, code: 1 } })}\n`)
    })
    const { b2c, logs } = runner(root, failing)
    const errors: B2cError[] = []
    for (const run of [
      () => b2c.run(['code', 'list'], { role: 'sandbox' }),
      () => b2c.run(['logs', 'get'], { role: 'development' }),
      () => b2c.run(['docs', 'read', 'x']),
      () => b2c.run(['code', 'deploy'], { role: 'production' }),
      () => b2c.run(['logs', 'get'], { role: 'production' }),
      () => b2c.run(['logs', 'get'], { role: 'staging' })
    ]) {
      const failure = await failureOf(run())
      assert.ok(failure instanceof B2cError, String(failure))
      errors.push(failure)
    }
    assert.deepEqual(errors.map((error) => error.code), ['b2c_failed', 'b2c_failed', 'b2c_failed', 'role_refused', 'role_not_configured', 'credentials_missing'])
    // The role's own host is one of its values; any other host-shaped name is masked too.
    assert.equal(errors[0].detail, 'cannot reach *** (also <host>) as *** with ***, not *** or ***')
    assert.equal(errors[1].detail, 'cannot reach *** (also <host>) as *** with ***, not *** or ***')
    // A command with no role has no credentials, yet what it reports is masked all the same.
    assert.equal(errors[2].detail, 'cannot reach undefined (also <host>) as undefined with undefined, not *** or ***')
    for (const error of errors) {
      assertNoSecrets(error.message, 'an error message')
      assertNoSecrets(String(error.detail), 'an error detail')
      assertNoSecrets(String(error.stack), 'an error stack')
      assertNoSecrets(JSON.stringify(error), 'a serialized error')
      assert.ok(!error.message.includes(root), 'no path in the message')
    }
    assertNoSecrets(logs.join('\n'), 'the log')
  }))

test('redact masks hosts in every shape: three labels, two, and IP addresses; not file names, versions or times', () => {
  assert.equal(redact('a secret-value at x.y.example.com and 10.0.0.1:443', ['secret-value']), 'a *** at <host> and <host>:443')
  assert.equal(redact('cannot resolve shop.internal or Shop.Example', []), 'cannot resolve <host> or <host>')
  assert.equal(redact('connect to [2001:db8::1]:443, fe80::1, ::1 or 2001:db8:0:0:0:0:0:1', []), 'connect to [<host>]:443, <host>, <host> or <host>')
  const kept = 'no hosts here: file.isml, Cart.js and dw.json, version 2.11.0 at 12:34:56, e.g. this.'
  assert.equal(redact(kept, []), kept)
})

test('redact masks a short value only where it stands alone, never inside a word', () => {
  assert.equal(redact('Unauthorized: bad credentials for a', ['a']), 'Unauthorized: bad credentials for ***')
  assert.equal(redact('user ab, cab, ab-1 and (ab)', ['ab']), 'user ***, cab, ***-1 and (***)')
  // Four characters or more: wherever it is, and the longest value first.
  assert.equal(redact('token=abcd1234 and abcd', ['abcd', 'abcd1234']), 'token=*** and ***')
  assert.equal(redact('nothing to mask', ['', 'zz']), 'nothing to mask')
})

test('redact turns the home folder into ~, whatever its slashes or case', () => {
  assert.equal(redact('ENOENT: C:\\Users\\someone\\AppData\\cache.log', [], 'C:\\Users\\someone'), 'ENOENT: ~\\AppData\\cache.log')
  assert.equal(redact('ENOENT: c:/users/someone/AppData/cache.log', [], 'C:\\Users\\someone\\'), 'ENOENT: ~/AppData/cache.log')
  assert.equal(redact('open /home/someone/work', [], '/home/someone'), 'open ~/work')
  assert.equal(redact('open /var/x', [], '/'), 'open /var/x')
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

// ---------------------------------------------------------------------------------------------
// A spawn that fails

test('whatever spawn throws becomes a coded error that holds none of its text', () =>
  withWorkspace(async (root) => {
    // Node names the offending value in what it throws.
    const throwing: Spawner = () => {
      throw Object.assign(new TypeError(`The property 'options.env['SFCC_CLIENT_SECRET']' must be a string without null bytes. Received '${INVENTED_DW['client-secret']}'`), { code: 'ERR_INVALID_ARG_VALUE' })
    }
    const { b2c, logs } = runner(root, { spawn: throwing, calls: [] })
    for (const attempt of [() => b2c.run(['code', 'list'], { role: 'sandbox' }), () => b2c.start(['code', 'watch'], { role: 'sandbox' })]) {
      const failure = await failureOf(attempt())
      assert.ok(failure instanceof B2cError, String(failure))
      assert.equal(failure.code, 'b2c_failed')
      assert.equal(failure.detail, null)
      assert.equal(failure.cause, undefined)
      assertNoSecrets(`${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`, 'the error')
    }
    assert.deepEqual(logs, ['b2c code (sandbox): could not start (ERR_INVALID_ARG_VALUE)', 'b2c code (sandbox): could not start (ERR_INVALID_ARG_VALUE)'])
  }))

test('the real spawn refusing a NUL in the environment is a coded error too', async () => {
  // Node itself throws here, quoting the value: nothing of it may come out.
  const b2c = createB2c({
    settings: plainSettings({ b2cPath: process.execPath }),
    configRoot: async () => null,
    env: { ...process.env, INVENTED_VARIABLE: 'invented-leak\u0000value' },
    homedir: tmpdir()
  })
  const failure = await failureOf(b2c.version())
  assert.ok(failure instanceof B2cError, String(failure))
  assert.equal(failure.code, 'b2c_failed')
  assert.ok(!`${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`.includes('invented-leak'))
})

test('a dw.json value with a NUL or another control character makes its role unusable, and never reaches spawn', async () => {
  for (const bad of ['invented\u0000secret', 'invented\nsecret', 'invented\u001bsecret', 'invented\u007fsecret']) {
    await withWorkspace(
      async (root) => {
        const { b2c, calls } = runner(root)
        assert.deepEqual((await b2c.instances()).instances, { sandbox: 'incomplete', development: 'ready', staging: 'incomplete', production: 'absent' })
        assert.equal(await codeOf(b2c.run(['code', 'list'], { role: 'sandbox' })), 'value_invalid')
        assert.equal(await codeOf(b2c.start(['code', 'watch'], { role: 'sandbox' })), 'value_invalid')
        // The other roles of the same file still run.
        assert.equal(await codeOf(b2c.run(['logs', 'get'], { role: 'development' })), 'resolved')
        assert.equal(calls.length, 1)
        assert.equal(calls[0].options.env.SFCC_CLIENT_SECRET, INVENTED_DW['client-secret-dev'])
      },
      { ...INVENTED_DW, 'client-secret': bad }
    )
  }
})

test('a cwd that does not exist is cwd_not_found, not b2c_not_found, before any process starts', () =>
  withWorkspace(async (root) => {
    // The real check of the folder, with the fake process.
    const { b2c, calls } = runner(root, fakeSpawner(), { isDirectory: undefined })
    assert.equal(await codeOf(b2c.run(['code', 'list'], { role: 'sandbox', cwd: join(root, 'gone') })), 'cwd_not_found')
    assert.equal(await codeOf(b2c.start(['code', 'watch'], { role: 'sandbox', cwd: join(root, 'dw.json') })), 'cwd_not_found')
    assert.equal(calls.length, 0)
    assert.equal(await codeOf(b2c.run(['code', 'list'], { role: 'sandbox', cwd: root })), 'resolved')
  }))

test('an ENOENT from the process itself names the folder when that is what went away', () =>
  withWorkspace(async (root) => {
    let folderExists = true
    // As Node does it: the error, then the close of a process that never ran.
    const enoent = fakeSpawner((call) => {
      call.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      call.child.emit('close', -4058)
    })
    const { b2c } = runner(root, enoent, { isDirectory: async () => folderExists })
    assert.equal(await codeOf(b2c.run(['code', 'list'], { role: 'sandbox' })), 'b2c_not_found')
    // The folder is there when checked, gone when the process starts.
    const vanishing = runner(root, enoent, {
      isDirectory: async () => {
        const answer = folderExists
        folderExists = false
        return answer
      }
    })
    assert.equal(await codeOf(vanishing.b2c.run(['code', 'list'], { role: 'sandbox' })), 'cwd_not_found')
  }))

// ---------------------------------------------------------------------------------------------
// Long-lived commands

test('a long-lived command hands over stderr line by line and stops at once; --jsonl only when asked', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root, fakeSpawner(() => {}))
    const events: B2cEvent[] = []
    const running = await b2c.start(['code', 'watch'], { role: 'sandbox', jsonl: true, onEvent: (event) => events.push(event) })
    const child = calls[0].child
    child.stderr.emit('data', Buffer.from('{"level":"info","time":1,"command":"code:watch","msg":"watching"}\n » Warning: upd'))
    child.stderr.emit('data', Buffer.from('ate available\n{"level":"info","time":2,"msg":"up'))
    child.stderr.emit('data', Buffer.from('loaded"}\n'))
    running.stop()
    assert.ok(child.killed)
    // The pipes never closed, yet it is reported stopped.
    assert.deepEqual(await running.exited, { exitCode: null, stopped: true })
    assert.deepEqual(calls[0].args, ['code', 'watch', '--jsonl'])
    assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe'])
    assert.deepEqual(events, [
      { json: { level: 'info', time: 1, command: 'code:watch', msg: 'watching' } },
      { text: ' » Warning: update available' },
      { json: { level: 'info', time: 2, msg: 'uploaded' } }
    ])
    // A debug adapter speaks its own protocol on stdout: nothing is added unless asked.
    await b2c.start(['debug'], { role: 'sandbox' })
    assert.deepEqual(calls[1].args, ['debug'])
  }))

test('a long-lived command gets stdout in raw chunks and a stdin to write and close', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root, fakeSpawner(() => {}))
    const chunks: Uint8Array[] = []
    const running = await b2c.start(['debug'], { role: 'sandbox', onStdout: (chunk) => chunks.push(chunk) })
    const child = calls[0].child
    const frame = Buffer.from([0x43, 0x6f, 0x6e, 0x0d, 0x0a, 0xff, 0x00, 0x7b])
    child.stdout.emit('data', frame)
    child.stdout.emit('data', 'text')
    assert.deepEqual(chunks.map((chunk) => [...chunk]), [[...frame], [...Buffer.from('text')]])
    assert.equal(running.write('Content-Length: 2\r\n\r\n{}'), true)
    assert.equal(running.write(frame), true)
    assert.deepEqual(child.stdin.written, ['Content-Length: 2\r\n\r\n{}', frame])
    running.end()
    assert.ok(child.stdin.ended)
    assert.equal(running.write('late'), false, 'stdin is closed')
    child.finish(0)
    assert.deepEqual(await running.exited, { exitCode: 0, stopped: false })
    assert.equal(running.write('later'), false, 'the process ended')
  }))

test('a long-lived command that ends by itself reports its exit code, even if its pipes never close', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root, fakeSpawner(() => {}), { pipeGraceMs: 20 })
    const events: B2cEvent[] = []
    const running = await b2c.start(['debug'], { role: 'sandbox', onEvent: (event) => events.push(event) })
    calls[0].child.emit('exit', 3)
    // What is still in the pipe when the process ends is handed over before `exited` resolves.
    calls[0].child.stderr.emit('data', Buffer.from('last words'))
    assert.deepEqual(await running.exited, { exitCode: 3, stopped: false })
    assert.deepEqual(events, [{ text: 'last words' }])
    // A failure to start ends it too.
    const failing = await b2c.start(['debug'], { role: 'sandbox' })
    calls[1].child.emit('error', Object.assign(new Error('spawn failed'), { code: 'EACCES' }))
    assert.deepEqual(await failing.exited, { exitCode: null, stopped: false })
  }))

/** A runner whose every process is a real Node child running `script`, with the runner's own stdio. */
function nodeRunner(script: string): B2c {
  const spawn: Spawner = (_file, _args, options) => nodeSpawn(process.execPath, ['-e', script], options)
  return createB2c({ settings: plainSettings({ b2cPath: process.execPath }), configRoot: async () => null, spawn, homedir: tmpdir() })
}

const FLOOD_BYTES = 8 * 1024 * 1024
/** Writes a line on stderr, eight megabytes on stdout, then another line on stderr. */
const FLOOD = `
  process.stderr.write('{"msg":"begin"}\\n')
  const chunk = Buffer.alloc(65536, 97)
  let left = ${FLOOD_BYTES} / chunk.length
  function pump() {
    while (left-- > 0) if (!process.stdout.write(chunk)) return void process.stdout.once('drain', pump)
    process.stderr.write('{"msg":"end"}\\n')
  }
  pump()
`

test('a real process that writes megabytes on stdout ends, with or without a listener, and its stderr arrives', async () => {
  // Nobody reads stdout: an undrained pipe would fill and the process would never end.
  const events: B2cEvent[] = []
  const unread = await nodeRunner(FLOOD).start(['docs', 'read', 'x'], { onEvent: (event) => events.push(event) })
  assert.deepEqual(await unread.exited, { exitCode: 0, stopped: false })
  assert.deepEqual(events, [{ json: { msg: 'begin' } }, { json: { msg: 'end' } }])

  let received = 0
  let onlyTheByteWritten = true
  const read = await nodeRunner(FLOOD).start(['docs', 'read', 'x'], {
    onStdout: (chunk) => {
      received += chunk.length
      if (chunk[0] !== 97 || chunk[chunk.length - 1] !== 97) onlyTheByteWritten = false
    }
  })
  assert.deepEqual(await read.exited, { exitCode: 0, stopped: false })
  assert.equal(received, FLOOD_BYTES)
  assert.ok(onlyTheByteWritten)
})

test('a real process that echoes its stdin gets every byte written to it, and ends when stdin is closed', async () => {
  const echo = 'process.stdin.pipe(process.stdout)'
  const chunks: Uint8Array[] = []
  const running = await nodeRunner(echo).start(['docs', 'read', 'x'], { onStdout: (chunk) => chunks.push(chunk) })
  // A debug adapter message, then bytes that are not text.
  const header = 'Content-Length: 17\r\n\r\n{"seq":1,"ok":1}\n'
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x0d])
  assert.equal(running.write(header), true)
  assert.equal(running.write(binary), true)
  running.end()
  assert.deepEqual(await running.exited, { exitCode: 0, stopped: false })
  assert.deepEqual([...Buffer.concat(chunks)], [...Buffer.from(header), ...binary])
  assert.equal(running.write('late'), false)
})

// ---------------------------------------------------------------------------------------------
// Finding b2c and building its command line

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
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"')
  assert.equal(quoteWindowsArgument('dir\\'), '"dir\\\\"')
  assert.equal(parseVersion('@salesforce/b2c-cli/2.11.0 win32-x64 node-v25.8.1'), '2.11.0')
  assert.equal(parseVersion('nothing'), null)
})

/** What cmd.exe reads itself, and the control characters: no argument of a shim may hold one. */
const SHIM_REFUSED = ['"', '%', '^', '&', '|', '<', '>', '!', '\n', '\r', '\t', '\u0000', '\u001b', '\u007f']

function refusedBy(build: () => unknown): string {
  try {
    build()
  } catch (error) {
    return error instanceof B2cError ? `${error.code}@${error.argument}` : `not a B2cError: ${String(error)}`
  }
  return 'built'
}

test('refuses, by position, any argument of a .cmd or .bat that holds a cmd.exe or control character', () => {
  const windows = { platform: 'win32', env: {} }
  for (const ch of SHIM_REFUSED) {
    const args = ['docs', 'search', `a${ch}b`, 'two words']
    const shown = JSON.stringify(ch)
    assert.equal(unsafeShimArgument(args), 2, shown)
    assert.equal(refusedBy(() => commandFor('C:\\tools\\b2c.cmd', args, windows)), 'unsafe_argument@2', shown)
    assert.equal(refusedBy(() => commandFor('C:\\tools\\b2c.BAT', args, windows)), 'unsafe_argument@2', shown)
    // A program Node starts itself gets its arguments as they are; only a NUL cannot be passed.
    assert.equal(refusedBy(() => commandFor('C:\\tools\\b2c.exe', args, windows)), ch === '\u0000' ? 'unsafe_argument@2' : 'built', shown)
    assert.equal(refusedBy(() => commandFor('/usr/bin/b2c', args, { platform: 'linux', env: {} })), ch === '\u0000' ? 'unsafe_argument@2' : 'built', shown)
  }
  // The error says where, never what.
  try {
    commandFor('C:\\tools\\b2c.cmd', ['docs', `%SFCC_CLIENT_SECRET%`], windows)
    assert.fail('should throw')
  } catch (error) {
    assert.ok(error instanceof B2cError)
    assert.ok(!`${error.message}\n${error.stack}\n${JSON.stringify(error)}`.includes('SFCC_CLIENT_SECRET'))
  }
  assert.equal(unsafeShimArgument(['two words', 'C:\\a path\\x.isml', '(a);b,c=d*?`', '']), -1)
  // A quote or percent sign in the shim's own path cannot be passed either.
  assert.equal(refusedBy(() => commandFor('C:\\100%\\b2c.cmd', ['docs'], windows)), 'unsafe_argument@null')
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

// ---------------------------------------------------------------------------------------------
// Real shims, on Windows

/** Arguments a shim may be given that still need care: spaces, backslashes, cmd.exe's separators. */
const AWKWARD = [
  'two words',
  '',
  ' leading and trailing ',
  'trailing\\',
  'C:\\path with spaces\\file.isml',
  '(paren)',
  'semi;colon,comma',
  'eq=ual',
  '`tick`',
  '*?',
  "it's",
  'áéíóú ñ ü'
]

/** The inputs of the review, each of which ran a command, expanded a variable or lost a character. */
const REVIEWED = ['q"&echo INJECTED>marker.txt&"', '%SFCC_AUTH_METHODS%', 'ca^ret', 'x|y', 'x<y']

/** More of the same kind: every refused character, in an argument that tries to write a file. */
const HOSTILE = [...REVIEWED, '%SFCC_CLIENT_SECRET%', 'a&echo INJECTED>marker.txt', 'a>marker.txt', '!SFCC_CLIENT_SECRET!', 'say "hi"', 'tab\there', 'line\necho INJECTED>marker.txt']

/**
 * A `.cmd` shim in a folder with a space and a parenthesis (as under "Program Files (x86)") that
 * starts Node by its full path, read from a variable so the batch file stays ASCII. The script
 * leaves `started.txt` beside itself, so a test can tell the shim never ran.
 */
async function withShim(check: (b2c: B2c, dirs: { cwd: string; started: string }) => Promise<void>): Promise<void> {
  const dir = makeWorkspace({})
  const shimDir = join(dir, 'b2c (shim) dir')
  const cwd = join(dir, 'cwd')
  mkdirSync(shimDir)
  mkdirSync(cwd)
  writeFileSync(
    join(shimDir, 'echo-args.cjs'),
    "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'started.txt'), '')\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n"
  )
  writeFileSync(join(shimDir, 'b2c.cmd'), '@echo off\r\n"%ECHO_NODE%" "%~dp0echo-args.cjs" %*\r\n')
  const b2c = createB2c({
    settings: plainSettings({ b2cPath: join(shimDir, 'b2c.cmd') }),
    configRoot: async () => dir,
    env: { ...process.env, ECHO_NODE: process.execPath }
  })
  try {
    await check(b2c, { cwd, started: join(shimDir, 'started.txt') })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('on Windows, a .cmd shim gets arguments with spaces whole, and is never started for one it cannot be given', async () => {
  if (process.platform !== 'win32') return
  await withShim(async (b2c, { cwd, started }) => {
    for (const input of HOSTILE) {
      assert.equal(await refusalOf(b2c.run(['docs', 'search', input], { cwd, timeoutMs: 30_000 })), 'unsafe_argument@2', JSON.stringify(input))
      assert.equal(await refusalOf(b2c.start(['docs', 'search', 'ok', input], { cwd })), 'unsafe_argument@3', JSON.stringify(input))
    }
    assert.ok(!existsSync(started), 'the shim never ran')
    assert.deepEqual(readdirSync(cwd), [], 'nothing was written')

    const all = await b2c.run(['docs', 'search', ...AWKWARD], { cwd, timeoutMs: 30_000 })
    assert.deepEqual(all.json, ['docs', 'search', ...AWKWARD, '--json'])
    assert.ok(existsSync(started))
    for (const arg of AWKWARD) {
      const one = await b2c.run(['docs', arg], { cwd, timeoutMs: 30_000 })
      assert.deepEqual(one.json, ['docs', arg, '--json'], JSON.stringify(arg))
    }
    assert.deepEqual(readdirSync(cwd), [])
  })
})

/** The b2c on this Windows machine's PATH, or null. */
async function installedB2c(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  return resolveExecutable('b2c', { platform: 'win32', env: process.env, isFile: async (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false })
}

/** The same when it is a `.cmd` or `.bat` shim, as npm and version managers install it. */
async function installedShim(): Promise<string | null> {
  const found = await installedB2c()
  return found && /\.(cmd|bat)$/i.test(found) ? found : null
}

test('on Windows, starts the installed b2c for --version', async () => {
  if (!(await installedB2c())) return // b2c is not installed on this machine: the shim test above still covers the path.
  const b2c = createB2c({ settings: plainSettings(), configRoot: async () => null })
  assert.match(String(await b2c.version()), /^\d+\.\d+\.\d+/)
})

test('through the installed b2c shim, each input of the review is refused and writes no file', async () => {
  if (!(await installedShim())) return // Skipped where b2c is not installed as a shim.
  const cwd = mkdtempSync(join(tmpdir(), 'sfcc-tools-shim-'))
  try {
    // The real spawn: were an argument let through, the installed shim would run it.
    const b2c = createB2c({ settings: plainSettings(), configRoot: async () => null })
    for (const input of HOSTILE) {
      const failure = await failureOf(b2c.run(['docs', 'search', input], { cwd, timeoutMs: 60_000 }))
      assert.ok(failure instanceof B2cError, `${JSON.stringify(input)}: ${String(failure)}`)
      assert.equal(failure.code, 'unsafe_argument', JSON.stringify(input))
      assert.equal(failure.argument, 2, 'the position of the argument')
      assert.ok(!`${failure.message}\n${failure.detail}\n${JSON.stringify(failure)}`.includes('marker'), 'not its text')
    }
    assert.deepEqual(readdirSync(cwd), [], 'no file was created')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('through the installed b2c shim, an argument with a space arrives unchanged', async () => {
  if (!(await installedShim())) return // Skipped where b2c is not installed as a shim.
  const cwd = mkdtempSync(join(tmpdir(), 'sfcc-tools-shim-'))
  try {
    const b2c = createB2c({ settings: plainSettings(), configRoot: async () => null })
    // `docs search` reads the documentation b2c ships and echoes the query it was given.
    for (const query of ['two words', 'C:\\path with spaces\\file.isml', "(paren) semi;colon,comma it's a=b *?", 'áéíóú ñ ü']) {
      const answer = await b2c.run(['docs', 'search', query, '--limit', '1'], { cwd, timeoutMs: 60_000 })
      assert.equal((answer.json as { query?: unknown }).query, query)
    }
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
