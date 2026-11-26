// The runner over a fake process (guard, flags, environment, arguments, output, errors), over
// real Node children (a flood of stdout, an echo of stdin), and on Windows over a real `.cmd`
// shim that echoes what it received and over the b2c shim installed on the machine.
import { assert, test } from 'orca/testing'
import { exec, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  argumentWithValue,
  B2cError,
  basicForms,
  childEnvironment,
  commandFor,
  createB2c,
  createMasker,
  errorMessageOf,
  escapeShimArgument,
  maskedEvent,
  MAX_JSON_DEPTH,
  parseVersion,
  quoteWindowsArgument,
  resolveExecutable,
  stripAnsi,
  unsafeShimArgument,
  type B2c,
  type B2cEvent,
  type Spawner
} from './b2c'
import { B2C_COMMANDS, B2C_VERSION } from './b2c-commands-fixture'
import type { FileSystem } from './dw-config'
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

/** What each role may run, as it was decided; `none` needs no role. Nothing else starts a process. */
const MAY_RUN: Record<string, string[]> = {
  sandbox: ['code list', 'code deploy', 'code watch', 'code activate', 'code delete', 'logs get', 'logs list', 'logs tail', 'sandbox list', 'sandbox start', 'sandbox stop', 'debug'],
  development: ['logs get', 'logs list', 'logs tail'],
  staging: ['logs get', 'logs list', 'logs tail'],
  production: ['logs get', 'logs list', 'logs tail'],
  none: ['docs read', 'docs search']
}
const ROLE_OR_NONE: (Role | undefined)[] = [...EVERY_ROLE, undefined]
/** A dw.json with every role ready, so nothing but the guard can refuse a command. */
const READY_DW = { ...INVENTED_DW, 'client-secret-stg': 'invented-stg-client-secret', 'hostname-prd': 'production-01.example.com' }

function mayRun(command: string, role: Role | undefined): boolean {
  return MAY_RUN.none.includes(command) || (role !== undefined && MAY_RUN[role].includes(command))
}

function isRefusal(code: string): boolean {
  return code === 'role_refused' || code === 'role_required'
}

test('each role starts the commands of its list, whole, and only those', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    for (const role of EVERY_ROLE) {
      for (const command of MAY_RUN.sandbox) {
        const expected = MAY_RUN[role].includes(command) ? 'resolved' : 'role_refused'
        assert.equal(await codeOf(b2c.run(command.split(' '), { role })), expected, `${command} on ${role}`)
        assert.equal(await codeOf(b2c.run([command.split(' ').join(':')], { role })), expected, `${command} with a colon on ${role}`)
      }
    }
    for (const command of MAY_RUN.none) assert.equal(await codeOf(b2c.run([...command.split(' '), 'x'])), 'resolved', command)
    // Twelve on the sandbox and three on each other role, twice each; the two that need no role.
    assert.equal(calls.length, (12 + 3 * 3) * 2 + 2)
    assert.deepEqual(calls[1].args, ['code:list', '--json'])
  }, READY_DW))

test('refuses the ods alias and every command that deletes, resets, creates or downloads, on every role', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    const named = [
      ['sandbox', 'delete', 'abcd-001'],
      ['sandbox', 'reset', 'abcd-001'],
      ['sandbox', 'create'],
      ['sandbox', 'restart', 'abcd-001'],
      ['sandbox', 'update', 'abcd-001'],
      ['code', 'download'],
      ['setup', 'inspect'],
      ['setup', 'instance', 'create', 'x'],
      ['auth', 'login'],
      ['auth', 'token'],
      ['webdav', 'rm', 'x'],
      ['webdav', 'put', 'x', 'y'],
      ['job', 'run', 'x'],
      ['job', 'import', 'x'],
      ['debug', 'cli'],
      ['ods', 'list'],
      ['ods', 'start', 'abcd-001'],
      ['ods', 'stop', 'abcd-001'],
      ['ods', 'delete', 'abcd-001']
    ]
    for (const args of named) {
      for (const role of ROLE_OR_NONE) {
        const where = `${args.join(' ')} on ${role ?? 'no role'}`
        assert.equal(await codeOf(b2c.run(args, { role })), 'role_refused', where)
        assert.equal(await codeOf(b2c.start(args, { role })), 'role_refused', `${where} (start)`)
        assert.equal(await codeOf(b2c.run([args.slice(0, 2).join(':'), ...args.slice(2), '--force'], { role })), 'role_refused', `${where} (colon)`)
      }
    }
    assert.equal(calls.length, 0, 'no process was started')
  }, READY_DW))

test(`walks every command of b2c ${B2C_VERSION}: none outside the list starts a process, on any role, in either spelling`, () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    let refused = 0
    for (const id of B2C_COMMANDS) {
      const words = id.split(':')
      for (const role of ROLE_OR_NONE) {
        if (mayRun(words.join(' '), role)) continue
        for (const args of [words, [id], [...words, 'x'], [id, '--force']]) {
          const where = `${args.join(' ')} on ${role ?? 'no role'}`
          const ran = await codeOf(b2c.run(args, { role }))
          assert.ok(isRefusal(ran), `run ${where}: ${ran}`)
          const started = await codeOf(b2c.start(args, { role }))
          assert.ok(isRefusal(started), `start ${where}: ${started}`)
          refused++
        }
      }
    }
    assert.equal(calls.length, 0, 'no process was started')
    // 411 commands, five ways of asking (four roles and none), four spellings; less the 31 allowed.
    assert.equal(refused, (B2C_COMMANDS.length * 5 - 31) * 4)
  }, READY_DW))

/** The names a help screen of b2c lists under TOPICS and COMMANDS, as it prints them. */
function listedIn(help: string): { topics: string[]; commands: string[] } {
  const listed = { topics: [] as string[], commands: [] as string[] }
  let section: 'topics' | 'commands' | null = null
  for (const line of help.split(/\r?\n/)) {
    if (/^\S/.test(line)) section = line.trim() === 'TOPICS' ? 'topics' : line.trim() === 'COMMANDS' ? 'commands' : null
    // A name starts two spaces in; a description that wraps is indented further.
    const name = section ? line.match(/^ {2}([a-z0-9_-]+(?: [a-z0-9_-]+)*)(?: {2,}.*)?$/)?.[1] : undefined
    if (section && name) listed[section].push(name)
  }
  return listed
}

test('reads the topics and commands off a help screen', () => {
  const help = ['Manage things', '', 'USAGE', '  $ b2c sandbox COMMAND', '', 'TOPICS', '  sandbox alias       Create an alias', '  sandbox realm       Get the configuration', '', 'COMMANDS', '  sandbox create    Create a sandbox', '  sandbox reset     Reset a sandbox to clean state (clears all data but', '                    preserves configuration)', '  sandbox list', '', 'SKILL', '  b2c docs skill b2c-sandbox'].join('\n')
  assert.deepEqual(listedIn(help), { topics: ['sandbox alias', 'sandbox realm'], commands: ['sandbox create', 'sandbox reset', 'sandbox list'] })
})

test('walks what b2c --help lists on this machine: each topic and command outside the list is refused on every role', async () => {
  if (!(await installedB2c())) return // Skipped where b2c is not installed; the committed list above is walked everywhere.
  const run = promisify(exec)
  // Names come from a help screen and hold only letters, digits, `-` and `_`.
  const helpOf = async (topic: string) => (await run(`b2c ${topic} --help`.replace('  ', ' '), { cwd: tmpdir(), timeout: 120_000, windowsHide: true })).stdout
  const top = await helpOf('')
  const version = top.match(/b2c-cli\/(\d+\.\d+\.\d+)/)?.[1]
  const first = listedIn(top)
  assert.ok(first.topics.includes('sandbox') && first.topics.includes('code') && first.commands.includes('debug'), 'the help screen was read')
  // The help of every topic, a few at a time.
  const names = new Set([...first.topics, ...first.commands])
  const pending = [...first.topics]
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let topic = pending.pop(); topic !== undefined; topic = pending.pop()) {
        const listed = listedIn(await helpOf(topic))
        for (const name of [...listed.topics, ...listed.commands]) names.add(name)
      }
    })
  )
  assert.ok(names.has('sandbox delete') && names.has('sandbox reset') && names.has('code download') && names.has('ods list'), 'the topics were read')

  const { b2c, calls } = runner(null)
  const known = new Set(B2C_COMMANDS.flatMap((id) => id.split(':').map((_, i, words) => words.slice(0, i + 1).join(' '))))
  let allowed = 0
  for (const name of names) {
    if (version === B2C_VERSION) assert.ok(known.has(name), `${name} is missing from the committed list of b2c ${B2C_VERSION}`)
    for (const role of ROLE_OR_NONE) {
      if (mayRun(name, role)) {
        allowed++
        continue
      }
      for (const args of [name.split(' '), [name.split(' ').join(':')], [...name.split(' '), 'x']]) {
        const code = await codeOf(b2c.run(args, { role }))
        assert.ok(isRefusal(code), `${args.join(' ')} on ${role ?? 'no role'}: ${code}`)
      }
    }
  }
  assert.equal(calls.length, 0, 'no process was started')
  // Every allowed command is one this b2c really has.
  if (version === B2C_VERSION) assert.equal(allowed, 31)
})

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
      ['code', 'deploy', '-D'],
      // `--wait` is left out on purpose, and its two options with it.
      ['sandbox', 'start', '--wait'],
      ['sandbox', 'start', '-w'],
      ['sandbox', 'start', '--poll-interval', '5'],
      ['sandbox', 'start', '--timeout=60'],
      // `--version` is a command of its own: no other command takes it.
      ['code', 'list', '--version'],
      ['docs', 'search', '--version']
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
      ['sandbox', 'start', 'abcd-001']
    ]
    for (const args of allowed) assert.equal(await codeOf(b2c.run(args, { role: 'sandbox' })), 'resolved', args.join(' '))
    assert.deepEqual(calls.map((call) => call.args), allowed.map((args) => [...args, '--json']))
    // The command `--version` still runs, alone and as it is.
    assert.equal(await codeOf(b2c.run(['--version'])), 'resolved')
    assert.deepEqual(calls[calls.length - 1].args, ['--version'])
    assert.equal(await codeOf(b2c.run(['--version', '--json'])), 'role_refused')
  }))

test('refuses any argument that holds a value of dw.json, whichever role it belongs to', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    const refused: [Role, string[], number][] = [
      ['sandbox', ['logs', 'get', `--filter=${INVENTED_DW['client-id']}`], 2],
      ['sandbox', ['logs', 'get', '--search', `x${INVENTED_DW.password}x`], 3],
      ['sandbox', ['code', 'activate', INVENTED_DW.hostname], 2],
      // A value of another role, even of one with no host, is still a value of the file.
      ['development', ['logs', 'get', '--search', INVENTED_DW['client-secret']], 3],
      ['sandbox', ['code', 'activate', INVENTED_DW['client-secret-prd']], 2]
    ]
    for (const [role, args, position] of refused) {
      assert.equal(await refusalOf(b2c.run(args, { role })), `unsafe_argument@${position}`, `argument ${position} on ${role}`)
    }
    assert.equal(calls.length, 0)
  }))

test('refuses an argument that holds any masked base64 form of a Basic pair of the file, whichever role it belongs to', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    const b64 = (pair: string) => Buffer.from(pair).toString('base64')
    const userPair = b64(`${INVENTED_DW.username}:${INVENTED_DW.password}`)
    const prdPair = b64(`${INVENTED_DW['client-id-prd']}:${INVENTED_DW['client-secret-prd']}`)
    const refused: [Role, string[], number][] = [
      ['sandbox', ['code', 'activate', userPair], 2],
      ['sandbox', ['logs', 'get', `--search=${userPair.replace(/=+$/, '')}`], 2],
      ['sandbox', ['logs', 'get', '--search', `Basic ${prdPair}`], 3],
      ['development', ['logs', 'get', '--search', b64(`${INVENTED_DW['client-id-dev']}:REDACTED`)], 3],
      ['development', ['logs', 'get', '--filter', Buffer.from(`${INVENTED_DW['client-id']}:${INVENTED_DW['client-secret']}`).toString('base64url')], 3]
    ]
    for (const [role, args, position] of refused) {
      assert.equal(await refusalOf(b2c.run(args, { role })), `unsafe_argument@${position}`, `argument ${position} on ${role}`)
    }
    assert.equal(calls.length, 0)
    // Another pair is no value of the file.
    assert.equal(await codeOf(b2c.run(['logs', 'get', '--search', b64('someone.else:other-password')], { role: 'sandbox' })), 'resolved')
  }))

test('a value of eight characters or more blocks an argument that contains it; a shorter one only as the whole of it', () => {
  const values = ['ab', 'x', 'admin', 'storeman', 'invented-long-secret']
  assert.equal(argumentWithValue(['code', 'activate', 'cab-fix', 'xyz', '--search=cab'], values), -1)
  assert.equal(argumentWithValue(['code', 'activate', 'ab'], values), 2)
  assert.equal(argumentWithValue(['logs', 'get', '--search=ab'], values), 2)
  assert.equal(argumentWithValue(['logs', 'get', '--search', 'x'], values), 3)
  // A user called `admin` does not refuse a code version called `admin-fix`.
  assert.equal(argumentWithValue(['code', 'activate', 'admin-fix'], values), -1)
  assert.equal(argumentWithValue(['code', 'activate', 'my-admin-fix', '--search=sysadmins'], values), -1)
  // The value itself is still refused, alone or as the whole value of a flag.
  assert.equal(argumentWithValue(['code', 'activate', 'admin'], values), 2)
  assert.equal(argumentWithValue(['logs', 'get', '--search=admin'], values), 2)
  // Eight characters: inside a longer argument too.
  assert.equal(argumentWithValue(['code', 'activate', 'storeman'], values), 2)
  assert.equal(argumentWithValue(['code', 'activate', 'the-storeman-fix'], values), 2)
  assert.equal(argumentWithValue(['logs', 'get', '--search=xstoremanx'], values), 2)
  assert.equal(argumentWithValue(['logs', 'get', '--search', 'x-invented-long-secret-x'], values), 3)
  assert.equal(argumentWithValue(['code', 'activate', 'storema'], values), -1)
  // In any letter case, as masking is for a host: the file says Sandbox-41.Example.com.
  const cased = ['Sandbox-41.Example.com', 'Admin']
  assert.equal(argumentWithValue(['code', 'activate', 'x-sandbox-41.example.com'], cased), 2)
  assert.equal(argumentWithValue(['logs', 'get', '--search=SANDBOX-41.EXAMPLE.COM'], cased), 2)
  assert.equal(argumentWithValue(['code', 'activate', 'admin'], cased), 2)
  assert.equal(argumentWithValue(['logs', 'get', '--SEARCH=ADMIN'], cased), 2)
  assert.equal(argumentWithValue(['code', 'activate', 'admin-fix'], cased), -1)
  assert.equal(argumentWithValue(['code', 'activate', 'v1'], ['', 'ab']), -1)
})

test('through the runner: a user called admin lets admin-fix through, and an eight-character value inside an argument is refused', () =>
  withWorkspace(
    async (root) => {
      const { b2c, calls } = runner(root)
      assert.equal(await codeOf(b2c.run(['code', 'activate', 'admin-fix'], { role: 'sandbox' })), 'resolved')
      assert.equal(await codeOf(b2c.run(['logs', 'get', '--search', 'sysadmins'], { role: 'development' })), 'resolved')
      assert.deepEqual(calls.map((call) => call.args), [['code', 'activate', 'admin-fix', '--json'], ['logs', 'get', '--search', 'sysadmins', '--json']])
      assert.equal(await refusalOf(b2c.run(['code', 'activate', 'admin'], { role: 'sandbox' })), 'unsafe_argument@2')
      assert.equal(await refusalOf(b2c.run(['code', 'activate', 'fix-secret88-b'], { role: 'sandbox' })), 'unsafe_argument@2')
      assert.equal(await refusalOf(b2c.run(['logs', 'get', '--search=xsecret88x'], { role: 'development' })), 'unsafe_argument@2')
      // The host in another letter case than the file's is the host all the same.
      assert.equal(await refusalOf(b2c.run(['code', 'activate', 'x-SANDBOX-04.example.com'], { role: 'sandbox' })), 'unsafe_argument@2')
      assert.equal(await refusalOf(b2c.run(['code', 'activate', 'ADMIN'], { role: 'sandbox' })), 'unsafe_argument@2')
      assert.equal(calls.length, 2)
    },
    { hostname: 'sandbox-04.example.com', username: 'admin', password: 'secret88', 'hostname-dev': 'dev-04.example.com', 'client-id-dev': 'invented-dev-client-id', 'client-secret-dev': 'invented-dev-client-secret' }
  ))

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
    // The code version named picks what the fake process answers.
    const { b2c, calls } = runner(root, fakeSpawner((call) => call.child.finish(...outputs[call.args[2]])))
    const answer = (version: string) => b2c.run(['code', 'activate', version], { role: 'sandbox' })
    assert.deepEqual((await answer('list')).json, { versions: ['v1'] })
    // A one-shot command has no stdin to wait on.
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
    const activated = await answer('activate')
    assert.equal(activated.json, undefined)
    assert.equal(activated.stdout, '')
    const shim = await failureOf(answer('shim'))
    assert.ok(shim instanceof B2cError)
    assert.equal(shim.code, 'b2c_failed')
    assert.equal(shim.exitCode, 126)
    assert.equal(shim.detail, 'Unauthorized')
    const one = await failureOf(answer('one'))
    assert.ok(one instanceof B2cError)
    assert.equal(one.detail, null)
    assert.equal((await answer('text')).json, undefined)
  }))

// ---------------------------------------------------------------------------------------------
// Output cut anywhere

/** An accented letter (two bytes) and an emoji (four), in JSON as b2c prints it and in plain text. */
const ACCENTED = '{"msg":"café señor 😀 ok"}'
const ACCENTED_BYTES = Buffer.from(`${ACCENTED}\n`, 'utf8')

/** `bytes` cut in two at `at`, or one byte at a time when `at` is 0. */
function cut(bytes: Buffer, at: number): Buffer[] {
  if (at === 0) return [...bytes].map((byte) => Buffer.from([byte]))
  return [bytes.subarray(0, at), bytes.subarray(at)]
}

test('run() puts together a character cut between two chunks, at every byte of an accent and an emoji', () =>
  withWorkspace(async (root) => {
    assert.ok(ACCENTED_BYTES.length > ACCENTED.length + 4, 'the text has characters of several bytes')
    // 0 is every boundary at once: one byte per chunk.
    for (let at = 0; at < ACCENTED_BYTES.length; at++) {
      const pieces = cut(ACCENTED_BYTES, at)
      const speaking = fakeSpawner((call) => {
        for (const piece of pieces) call.child.stdout.emit('data', piece)
        for (const piece of pieces) call.child.stderr.emit('data', piece)
        call.child.finish(0)
      })
      const result = await runner(root, speaking).b2c.run(['code', 'list'], { role: 'sandbox' })
      assert.equal(result.stdout, `${ACCENTED}\n`, `stdout cut at ${at}`)
      assert.equal(result.stderr, `${ACCENTED}\n`, `stderr cut at ${at}`)
      assert.deepEqual(result.json, { msg: 'café señor 😀 ok' }, `json cut at ${at}`)
      assert.ok(!`${result.stdout}${result.stderr}`.includes('�'), `no replacement character, cut at ${at}`)

      // The same in the message of a failure, which is read from stderr.
      const error = Buffer.from(`${JSON.stringify({ error: { message: 'no está 😀', code: 1 } })}\n`, 'utf8')
      const failing = fakeSpawner((call) => {
        for (const piece of cut(error, Math.min(at, error.length - 1))) call.child.stderr.emit('data', piece)
        call.child.finish(1)
      })
      const failure = await failureOf(runner(root, failing).b2c.run(['code', 'list'], { role: 'sandbox' }))
      assert.ok(failure instanceof B2cError)
      assert.equal(failure.detail, 'no está 😀', `detail cut at ${at}`)
    }
  }))

test('run() ends a stream that stops in the middle of a character with one replacement, and takes text chunks as they are', () =>
  withWorkspace(async (root) => {
    const euro = Buffer.from('€', 'utf8')
    const broken = fakeSpawner((call) => {
      call.child.stdout.emit('data', Buffer.from('price '))
      call.child.stdout.emit('data', euro.subarray(0, 2))
      call.child.stderr.emit('data', 'año ')
      call.child.stderr.emit('data', Buffer.from('😀', 'utf8'))
      call.child.finish(0)
    })
    const result = await runner(root, broken).b2c.run(['code', 'list'], { role: 'sandbox' })
    assert.equal(result.stdout, 'price �')
    assert.equal(result.stderr, 'año 😀')
  }))

test('start() puts together the characters of its stderr lines the same way', () =>
  withWorkspace(async (root) => {
    const lines = Buffer.from(`${ACCENTED}\n » aviso: señal 😀 perdida\n`, 'utf8')
    for (let at = 0; at < lines.length; at++) {
      const { b2c, calls } = runner(root, fakeSpawner(() => {}))
      const events: B2cEvent[] = []
      const running = await b2c.start(['logs', 'tail'], { role: 'sandbox', onEvent: (event) => events.push(event) })
      for (const piece of cut(lines, at)) calls[0].child.stderr.emit('data', piece)
      assert.deepEqual(events, [{ json: { msg: 'café señor 😀 ok' } }, { text: ' » aviso: señal 😀 perdida' }], `cut at ${at}`)
      calls[0].child.finish(0)
      assert.deepEqual(await running.exited, { exitCode: 0, stopped: false })
    }
    // A last line with no line break, cut inside its last character, still arrives whole.
    const { b2c, calls } = runner(root, fakeSpawner(() => {}))
    const events: B2cEvent[] = []
    const running = await b2c.start(['logs', 'tail'], { role: 'sandbox', onEvent: (event) => events.push(event) })
    const last = Buffer.from('adiós 😀', 'utf8')
    calls[0].child.stderr.emit('data', last.subarray(0, last.length - 2))
    assert.deepEqual(events, [])
    calls[0].child.stderr.emit('data', last.subarray(last.length - 2))
    calls[0].child.finish(0)
    await running.exited
    assert.deepEqual(events, [{ text: 'adiós 😀' }])
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

test('errors carry their code, and b2c’s message with the values of every role masked', () =>
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
    // Every value of the file is masked, whichever role it belongs to. A host the file does not
    // hold is not: masking goes by value, never by what a name looks like.
    assert.equal(errors[0].detail, 'cannot reach *** (also edge.cdn.example.com) as *** with ***, not *** or ***')
    assert.equal(errors[1].detail, 'cannot reach *** (also edge.cdn.example.com) as *** with ***, not *** or ***')
    // A command with no role has no credentials, yet what it reports is masked all the same.
    assert.equal(errors[2].detail, 'cannot reach undefined (also edge.cdn.example.com) as undefined with undefined, not *** or ***')
    for (const error of errors) {
      assertNoSecrets(error.message, 'an error message')
      assertNoSecrets(String(error.detail), 'an error detail')
      assertNoSecrets(String(error.stack), 'an error stack')
      assertNoSecrets(JSON.stringify(error), 'a serialized error')
      assert.ok(!error.message.includes(root), 'no path in the message')
    }
    assertNoSecrets(logs.join('\n'), 'the log')
  }))

// ---------------------------------------------------------------------------------------------
// Masking: by exact value, never by shape

/** Texts that hold no value of any file. Nothing may change them, whatever a file holds. */
const NOT_VALUES = [
  // The sentence of the review, word for word.
  'No documentation found for dw.catalog.ProductMgr; did you mean ProductMgr.getProduct or Site.current?',
  'static/default/js/jquery.min.js',
  'dw.order.calculate',
  'at com.example.shop.Cart.add(Cart.java:42)',
  'main.bundle.js.map and styles.min.css',
  'app.payment.processor.default, label.input.email, custom.checkout.payment',
  'dw.ocapi.shop.basket.afterPOST and dw.extensions.applepay.ApplePayHooks',
  'com.demandware.beehive.core.capi.pipeline.PipelineExecutionException',
  'Chrome/120.0.0.0 at 10.0.0.7:443, [2001:db8::1] and other-09.sandbox.example.com',
  'bm_admin_tools, admin-fix, Administrator, sysadmin, admin.tools and my.admin'
]

/** An invented file as the runner would have read it: two roles, a user called `admin`. */
const MASKED_FILE = {
  sandbox: { SFCC_SERVER: 'Sandbox-41.Example.com', SFCC_USERNAME: 'admin', SFCC_PASSWORD: 'p@ss word/1"x', SFCC_CLIENT_ID: 'invented-client-id-0041', SFCC_CLIENT_SECRET: 'invented-secret-0041' },
  development: { SFCC_SERVER: 'dev-box.example.com', SFCC_CLIENT_ID: 'first.last@example.com', SFCC_CLIENT_SECRET: 'abcd1234' }
}

function inventedMasker(home?: string) {
  const masker = createMasker(home)
  masker.remember(MASKED_FILE.sandbox)
  masker.remember(MASKED_FILE.development)
  return masker
}

test('masking leaves every name that is not a value of the file as it is: API names, files, packages, other hosts', () => {
  const masker = inventedMasker('C:\\Users\\someone')
  for (const text of NOT_VALUES) {
    assert.equal(masker.mask(text), text)
    assert.equal(createMasker().mask(text), text)
  }
  assert.equal(masker.mask(NOT_VALUES.join('\n')), NOT_VALUES.join('\n'))
  assert.equal(masker.mask(''), '')
  // Anything that is not a text comes back as it is, and nothing throws.
  assert.equal(masker.mask(undefined as unknown as string), undefined)
  assert.equal(masker.mask(42 as unknown as string), 42)
})

test('a host of the file is masked in any letter case, inside a URL, in an encoded URL and by its first label', () => {
  const { mask } = inventedMasker()
  assert.equal(mask('cannot reach Sandbox-41.Example.com'), 'cannot reach ***')
  assert.equal(mask('cannot reach sandbox-41.example.com or SANDBOX-41.EXAMPLE.COM.'), 'cannot reach *** or ***.')
  assert.equal(mask('GET https://sandbox-41.example.com:443/on/demandware.store/Sites-Site failed'), 'GET https://***:443/on/demandware.store/Sites-Site failed')
  assert.equal(mask('redirect=https%3A%2F%2Fsandbox-41.example.com%2Fon%2Fdemandware.store'), 'redirect=https%3A%2F%2F***%2Fon%2Fdemandware.store')
  assert.equal(mask('webdav.sandbox-41.example.com and x-sandbox-41.example.com-y'), 'webdav.*** and x-***-y')
  // The first label names the instance: six characters or more with a digit or a hyphen, any case.
  assert.equal(mask('instance sandbox-41 is stopped; SANDBOX-41 too'), 'instance *** is stopped; *** too')
  // One of fewer than eight is masked only where it stands alone.
  assert.equal(mask('dev-box is stopped, my-dev-box-2 is not'), '*** is stopped, my-dev-box-2 is not')
  // A label of fewer than six characters is an ordinary word.
  const short = createMasker()
  short.remember({ SFCC_SERVER: 'shop.internal' })
  assert.equal(short.mask('shop.internal, SHOP.INTERNAL, the shop and shop.other'), '***, ***, the shop and shop.other')
})

test('a value is masked in its percent-encoded and JSON-escaped forms too', () => {
  const { mask } = inventedMasker()
  assert.equal(mask('login as first.last@example.com'), 'login as ***')
  assert.equal(mask('POST /token?login=first.last%40example.com&grant=x'), 'POST /token?login=***&grant=x')
  // The hexadecimal digits come in either case.
  assert.equal(mask('pw=p%40ss%20word%2F1%22x; pw=p%40ss%20word%2f1%22x'), 'pw=***; pw=***')
  assert.equal(mask('sent {"password":"p@ss word/1\\"x","ok":true}'), 'sent {"password":"***","ok":true}')
  assert.equal(mask('raw p@ss word/1"x'), 'raw ***')
})

test('a first label with a digit or a hyphen names the instance and is masked alone; a plain word only within its host', () => {
  const masker = createMasker()
  masker.remember({ SFCC_SERVER: 'abcd-005.example.com' })
  masker.remember({ SFCC_SERVER: 'shop-eu01-test.example.com' })
  masker.remember({ SFCC_SERVER: 'box007.example.com' })
  masker.remember({ SFCC_SERVER: 'staging.example.com' })
  masker.remember({ SFCC_SERVER: 'production.example.com' })
  assert.equal(masker.mask('instance abcd-005 and ABCD-005, shop-eu01-test and box007 are stopped'), 'instance *** and ***, *** and *** are stopped')
  // A plain word is an ordinary word: it stays, and only the whole host goes.
  assert.equal(
    masker.mask('deploy to staging, then production: staging.example.com and Production.Example.com'),
    'deploy to staging, then production: *** and ***'
  )
  assert.equal(masker.mask('b2c logs (staging): exit 0'), 'b2c logs (staging): exit 0')
})

test('the log line of a role named staging keeps its label when its host begins with the word staging', () =>
  withWorkspace(
    async (root) => {
      const { b2c, logs } = runner(root)
      await b2c.run(['logs', 'get'], { role: 'staging' })
      assert.ok(logs.includes('b2c logs (staging): exit 0'), logs.join('\n'))
      assert.equal(await b2c.mask('staging.example.com is the staging instance'), '*** is the staging instance')
    },
    {
      hostname: 'sandbox-41.example.com',
      'client-id': 'invented-client-id-0041',
      'client-secret': 'invented-secret-0041',
      'hostname-stg': 'staging.example.com',
      'client-id-stg': 'invented-stg-client-id',
      'client-secret-stg': 'invented-stg-secret'
    }
  ))

/**
 * An invented user and password whose `user:password` in base64 holds a `+`, a `/` and padding,
 * so its four forms all differ.
 */
const BASIC = { user: 'invented.user', password: 'xinvented~pw??' }
const BASIC_FORMS = {
  standard: 'aW52ZW50ZWQudXNlcjp4aW52ZW50ZWR+cHc/Pw==',
  standardBare: 'aW52ZW50ZWQudXNlcjp4aW52ZW50ZWR+cHc/Pw',
  urlSafe: 'aW52ZW50ZWQudXNlcjp4aW52ZW50ZWR-cHc_Pw==',
  urlSafeBare: 'aW52ZW50ZWQudXNlcjp4aW52ZW50ZWR-cHc_Pw'
}

test('the base64 of user:password is masked in both alphabets, with and without padding, alone and in a Basic header', () => {
  // The fixture is what an Authorization header carries.
  assert.equal(Buffer.from(`${BASIC.user}:${BASIC.password}`).toString('base64'), BASIC_FORMS.standard)
  assert.equal(Buffer.from(`${BASIC.user}:${BASIC.password}`).toString('base64url'), BASIC_FORMS.urlSafeBare)
  const masker = createMasker()
  masker.remember({ SFCC_SERVER: 'sandbox-41.example.com', SFCC_USERNAME: BASIC.user, SFCC_PASSWORD: BASIC.password })
  for (const [form, value] of Object.entries(BASIC_FORMS)) {
    assert.equal(masker.mask(value), '***', form)
    assert.equal(masker.mask(`Authorization: Basic ${value}`), 'Authorization: Basic ***', form)
    assert.equal(masker.mask(`curl -H "authorization: basic ${value}" https://sandbox-41.example.com/x`), 'curl -H "authorization: basic ***" https://***/x', form)
    assert.equal(masker.mask(`{"headers":{"Authorization":"Basic ${value}"}}`), '{"headers":{"Authorization":"Basic ***"}}', form)
  }
  assert.equal(masker.mask(`Authorization: Basic ${encodeURIComponent(BASIC_FORMS.standard)}`), 'Authorization: Basic ***')
  // Another pair, and a user and a password that are not one role's pair, are not masked as one.
  const other = Buffer.from('someone.else:other-password').toString('base64')
  assert.equal(masker.mask(`Authorization: Basic ${other}`), `Authorization: Basic ${other}`)
  const apart = createMasker()
  apart.remember({ SFCC_USERNAME: BASIC.user })
  apart.remember({ SFCC_PASSWORD: BASIC.password })
  assert.equal(apart.mask(`Basic ${BASIC_FORMS.standard}`), `Basic ${BASIC_FORMS.standard}`)
})

test('a Basic header b2c prints on stderr arrives masked', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root, fakeSpawner(() => {}))
    const events: B2cEvent[] = []
    const running = await b2c.start(['code', 'watch'], { role: 'sandbox', onEvent: (event) => events.push(event) })
    const pair = Buffer.from(`${ADMIN_DW.username}:${ADMIN_DW.password}`).toString('base64')
    const json = JSON.stringify({ headers: { authorization: `Basic ${pair.replace(/=+$/, '')}` } })
    calls[0].child.stderr.emit('data', Buffer.from(`> Authorization: Basic ${pair}\n${json}\n`))
    assert.deepEqual(events, [{ text: '> Authorization: Basic ***' }, { json: { headers: { authorization: 'Basic ***' } } }])
    running.stop()
    await running.exited
  }, ADMIN_DW))

test('ANSI escape sequences are stripped before masking, so a short value right after ESC[1m is masked', () =>
  withWorkspace(async (root) => {
    assert.equal(stripAnsi('\u001b[1madmin\u001b[22m, \u001b[38;5;196mred\u001b[0m, \u001b]0;title\u0007x, \u001b]8;;https://x.example.com\u001b\\link\u001b]8;;\u001b\\, \u009b31mc1'), 'admin, red, x, link, c1')
    assert.equal(stripAnsi('no escape here [1m'), 'no escape here [1m')
    const { b2c, calls } = runner(root, fakeSpawner(() => {}))
    const events: B2cEvent[] = []
    const running = await b2c.start(['code', 'watch'], { role: 'sandbox', onEvent: (event) => events.push(event) })
    const json = JSON.stringify({ msg: '\u001b[1madmin\u001b[22m signed in', [`\u001b[33madmin`]: 1 })
    calls[0].child.stderr.emit('data', Buffer.from(`\u001b[1madmin\u001b[22m signed in to \u001b[32mSandbox-41\u001b[39m\n${json}\n`))
    assert.deepEqual(events, [{ text: '*** signed in to ***' }, { json: { msg: '*** signed in', '***': 1 } }])
    running.stop()
    await running.exited
    // b2c's error, when it is an ERROR: line in colour, as well.
    const failing = runner(root, fakeSpawner((call) => call.child.finish(1, '', 'ERROR: \u001b[1madmin\u001b[22m may not do that\n'))).b2c
    const failure = await failureOf(failing.run(['code', 'list'], { role: 'sandbox' }))
    assert.ok(failure instanceof B2cError)
    assert.equal(failure.detail, '*** may not do that')
  }, ADMIN_DW))

/** The four forms of `bytes` in base64: standard and URL-safe, each with and without padding. */
function fourForms(bytes: Buffer): string[] {
  const padded = bytes.toString('base64')
  const bare = padded.replace(/=+$/, '')
  const url = bytes.toString('base64url')
  return [padded, bare, url + padded.slice(bare.length), url]
}

/** An invented client id and a secret holding a space, a `+` and a `/`, so its form-encoding differs. */
const CLIENT = { id: 'invented-client-id-0041', secret: 'invented secret+/0041' }

test('the client-credentials pair is masked raw and form-encoded, in the four base64 forms, alone and in a Basic header', () => {
  const formEncoded = `${CLIENT.id}:invented+secret%2B%2F0041`
  assert.equal(new URLSearchParams([['', CLIENT.secret]]).toString(), '=invented+secret%2B%2F0041')
  const masker = createMasker()
  masker.remember({ SFCC_SERVER: 'staging-01.example.com', SFCC_CLIENT_ID: CLIENT.id, SFCC_CLIENT_SECRET: CLIENT.secret })
  for (const pair of [`${CLIENT.id}:${CLIENT.secret}`, formEncoded]) {
    for (const form of fourForms(Buffer.from(pair))) {
      assert.equal(masker.mask(form), '***', `${pair} as ${form}`)
      assert.equal(masker.mask(`Authorization: Basic ${form}`), 'Authorization: Basic ***', `${pair} as ${form}`)
    }
  }
})

test('the client-credentials pair of every role is masked through the runner', () =>
  withWorkspace(async (root) => {
    const { b2c } = runner(root)
    await b2c.instances()
    const pairs = [
      [INVENTED_DW['client-id'], INVENTED_DW['client-secret']],
      [INVENTED_DW['client-id-dev'], INVENTED_DW['client-secret-dev']],
      [INVENTED_DW['client-id-prd'], INVENTED_DW['client-secret-prd']]
    ]
    for (const [id, secret] of pairs) {
      for (const form of fourForms(Buffer.from(`${id}:${secret}`))) assert.equal(await b2c.mask(`Authorization: Basic ${form}`), 'Authorization: Basic ***', id)
    }
  }))

test('a pair whose characters all fit in Latin-1 is masked in its Latin-1 base64 too, as btoa encodes it', () => {
  const password = 'invented-pässwörd'
  const latin1 = btoa(`${BASIC.user}:${password}`)
  const utf8 = Buffer.from(`${BASIC.user}:${password}`).toString('base64')
  assert.notEqual(latin1, utf8)
  const masker = createMasker()
  masker.remember({ SFCC_USERNAME: BASIC.user, SFCC_PASSWORD: password })
  for (const form of [...fourForms(Buffer.from(latin1, 'base64')), ...fourForms(Buffer.from(utf8, 'base64'))]) {
    assert.equal(masker.mask(`Authorization: Basic ${form}`), 'Authorization: Basic ***', form)
  }
  // Bounded: four forms per pair in UTF-8, four more in Latin-1 only when it differs and fits.
  assert.ok(basicForms({ SFCC_USERNAME: BASIC.user, SFCC_PASSWORD: BASIC.password }).length <= 8)
  assert.ok(basicForms({ SFCC_USERNAME: BASIC.user, SFCC_PASSWORD: password }).length <= 12)
  const beyond = basicForms({ SFCC_USERNAME: BASIC.user, SFCC_PASSWORD: 'invented-€uro' })
  for (const form of beyond) {
    assert.ok([`${BASIC.user}:invented-€uro`, `${BASIC.user}:REDACTED`].includes(Buffer.from(form, 'base64').toString('utf8')), form)
  }
  const everything = { SFCC_USERNAME: 'invented.üser', SFCC_PASSWORD: 'pässwörd one', SFCC_CLIENT_ID: 'invented clïent', SFCC_CLIENT_SECRET: 'sécret +/' }
  assert.ok(basicForms(everything).length <= 48)
})

test('the base64 of user:REDACTED and client-id:REDACTED, as b2c redacts a Basic header, is masked', () => {
  const masker = createMasker()
  masker.remember({ SFCC_USERNAME: BASIC.user })
  masker.remember({ SFCC_CLIENT_ID: 'invented client id' })
  const redacted = [`${BASIC.user}:REDACTED`, 'invented client id:REDACTED', 'invented+client+id:REDACTED']
  for (const pair of redacted) {
    for (const form of fourForms(Buffer.from(pair))) {
      assert.equal(masker.mask(`{"authorization":"Basic ${form}"}`), '{"authorization":"Basic ***"}', `${pair} as ${form}`)
    }
  }
  const other = Buffer.from('someone.else:REDACTED').toString('base64')
  assert.equal(masker.mask(`Basic ${other}`), `Basic ${other}`)
})

test('a value shorter than eight characters is masked only where it stands alone, never inside a word', () => {
  const { mask } = inventedMasker()
  // A user called admin does not turn admin-fix into a masked text.
  for (const text of ['admin-fix', 'bm_admin_tools', 'Administrator', 'sysadmins', 'admin.tools', 'my.admin', 'x-admin', 'admin_1', 'Admin']) assert.equal(mask(text), text)
  assert.equal(mask('code version admin-fix uploaded by admin'), 'code version admin-fix uploaded by ***')
  assert.equal(mask('user admin, "admin", (admin), user=admin, /admin/ and admin@example.com by admin.'), 'user ***, "***", (***), user=***, /***/ and ***@example.com by ***.')
  // Eight characters or more: wherever it is, in its own case, and the longest value first.
  assert.equal(mask('xabcd1234x and token=invented-secret-0041!'), 'x***x and token=***!')
  assert.equal(mask('ABCD1234 is not abcd1234'), 'ABCD1234 is not ***')
  const nested = createMasker()
  nested.remember({ SFCC_CLIENT_ID: 'abcd1234', SFCC_CLIENT_SECRET: 'abcd1234-and-more' })
  assert.equal(nested.mask('abcd1234-and-more, then abcd1234'), '***, then ***')
})

test('the masker never forgets: what one file held is still masked after another is read', () => {
  const masker = createMasker()
  masker.remember({ SFCC_SERVER: 'first-box.example.com', SFCC_CLIENT_SECRET: 'invented-first-secret' })
  const text = 'first-box.example.com with invented-first-secret, then second-box.example.com'
  assert.equal(masker.mask(text), '*** with ***, then second-box.example.com')
  masker.remember({ SFCC_SERVER: 'second-box.example.com' })
  masker.remember({})
  assert.equal(masker.mask(text), '*** with ***, then ***')
  // A value that is a host for one role is one everywhere.
  masker.remember({ SFCC_USERNAME: 'Third-Box.example.com' })
  assert.equal(masker.mask('third-box.example.com'), 'third-box.example.com')
  masker.remember({ SFCC_SERVER: 'Third-Box.example.com' })
  assert.equal(masker.mask('third-box.example.com'), '***')
})

test('masking turns the home folder into ~, whatever its slashes or case', () => {
  assert.equal(createMasker('C:\\Users\\someone').mask('ENOENT: C:\\Users\\someone\\AppData\\cache.log'), 'ENOENT: ~\\AppData\\cache.log')
  assert.equal(createMasker('C:\\Users\\someone\\').mask('ENOENT: c:/users/someone/AppData/cache.log'), 'ENOENT: ~/AppData/cache.log')
  assert.equal(createMasker('/home/someone').mask('open /home/someone/work'), 'open ~/work')
  assert.equal(createMasker('/').mask('open /var/x'), 'open /var/x')
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
    // Aborts once the process has started: preparing it takes longer while other files run.
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 1))
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

/** An invented dw.json with a host written in capitals and a user called `admin`. */
const ADMIN_DW = {
  hostname: 'Sandbox-41.Example.com',
  username: 'admin',
  password: 'invented-password-41',
  'client-id': 'invented-client-id-0041',
  'client-secret': 'invented-secret-0041',
  'hostname-dev': 'dev-box.example.com',
  'client-id-dev': 'first.last@example.com',
  'client-secret-dev': 'invented-dev-secret-41'
}

function assertNothingOf(dw: Record<string, string>, text: string, where: string): void {
  for (const value of Object.values(dw)) {
    if (value.length >= 8) assert.ok(!text.toLowerCase().includes(value.toLowerCase()), `${where} holds a value of the file`)
  }
}

test('the stderr events of a long-lived command arrive masked: raw lines, and the strings and keys of a JSON line at every level', () =>
  withWorkspace(async (root) => {
    const { b2c, calls, logs } = runner(root, fakeSpawner(() => {}))
    const events: B2cEvent[] = []
    const chunks: Uint8Array[] = []
    const running = await b2c.start(['code', 'watch'], { role: 'sandbox', jsonl: true, onEvent: (event) => events.push(event), onStdout: (chunk) => chunks.push(chunk) })
    const child = calls[0].child
    const host = 'sandbox-41.example.com'
    // As b2c writes them: the host in the message, in other fields, as a key; of this role and of others.
    const line = {
      level: 50,
      time: 1,
      command: 'code:watch',
      msg: `HTTPS request to ${host} failed`,
      err: { message: `connect ECONNREFUSED 10.0.0.7:443 (${host.toUpperCase()})`, hosts: [host, 'dev-box.example.com', 'edge.cdn.example.com'], attempts: 3, ok: false, nothing: null },
      user: 'admin',
      hosts: { [host]: { state: 'started', by: ['first.last@example.com'] }, [host.toUpperCase()]: { state: 'stopped' } },
      'invented-client-id-0041': true
    }
    child.stderr.emit('data', Buffer.from(`${JSON.stringify(line)}\nERROR: HTTPS request to https://${host}/on failed for invented-dev-secret-41\n`))
    assert.deepEqual(events, [
      {
        json: {
          level: 50,
          time: 1,
          command: 'code:watch',
          msg: 'HTTPS request to *** failed',
          err: { message: 'connect ECONNREFUSED 10.0.0.7:443 (***)', hosts: ['***', '***', 'edge.cdn.example.com'], attempts: 3, ok: false, nothing: null },
          user: '***',
          // Two keys that mask alike are both kept.
          hosts: { '***': { state: 'started', by: ['***'] }, '*** 2': { state: 'stopped' } },
          '***': true
        }
      },
      { text: 'ERROR: HTTPS request to https://***/on failed for ***' }
    ])
    assertNothingOf(ADMIN_DW, JSON.stringify(events), 'an event')

    // What is not a value of the file is the data of the event: it arrives as b2c wrote it.
    events.length = 0
    const upload = { file: 'C:\\work\\cartridges\\app_storefront\\cartridge\\static\\default\\css\\styles.min.css', cartridge: 'bm_admin_tools', codeVersion: 'admin-fix', hook: 'dw.order.calculate' }
    child.stderr.emit('data', Buffer.from(`${JSON.stringify(upload)}\n${NOT_VALUES.join('\n')}\n`))
    assert.deepEqual(events, [{ json: upload }, ...NOT_VALUES.map((text) => ({ text }))])

    // A value cut between two chunks is masked all the same: the line is masked once it is whole.
    events.length = 0
    child.stderr.emit('data', Buffer.from('ERROR: cannot reach sandbox-41.exa'))
    assert.deepEqual(events, [])
    child.stderr.emit('data', Buffer.from('mple.com today\n{"msg":"token invented-sec'))
    child.stderr.emit('data', Buffer.from('ret-0041 refused","user":"adm'))
    child.stderr.emit('data', Buffer.from('in"}\n'))
    assert.deepEqual(events, [{ text: 'ERROR: cannot reach *** today' }, { json: { msg: 'token *** refused', user: '***' } }])

    // Stdout is the caller's to mask: it is handed over as it came.
    child.stdout.emit('data', Buffer.from(host))
    assert.equal(Buffer.concat(chunks).toString(), host)
    running.stop()
    await running.exited
    assertNothingOf(ADMIN_DW, logs.join('\n'), 'the log')
  }, ADMIN_DW))

/** A JSON text of `depth` arrays or objects, one inside the other, around `inner`. */
function nested(depth: number, kind: 'array' | 'object', inner: string): string {
  return kind === 'array' ? `${'['.repeat(depth)}${inner}${']'.repeat(depth)}` : `${'{"k":'.repeat(depth)}${inner}${'}'.repeat(depth)}`
}

test('past the bound, each string of the line is masked as the walk masks it: a short value after \\n, \\t or \\uXXXX', () => {
  const masker = createMasker()
  masker.remember({ SFCC_SERVER: 'zz-001.example.com', SFCC_USERNAME: 'admin', SFCC_PASSWORD: 'invented-password-41' })
  // As JSON writes it: a line break before the user, a tab before the label, ( and   before both.
  const inner = '"first line\\nadmin signed in\\tzz-001 is up, \\u0028admin\\u0029 and\\u0020zz-001\\r\\nadmin"'
  const key = '"\\tadmin"'
  const expected = JSON.stringify(masker.mask(JSON.parse(inner)))
  assert.equal(expected, '"first line\\n*** signed in\\t*** is up, (***) and ***\\r\\n***"')
  // `depth` levels in all; in the objects, the innermost has the key to mask.
  const levels = (depth: number, kind: 'array' | 'object', name: string, value: string) =>
    kind === 'array' ? nested(depth, kind, value) : nested(depth - 1, kind, `{${name}:${value}}`)
  for (const kind of ['array', 'object'] as const) {
    const event = maskedEvent(levels(MAX_JSON_DEPTH + 1, kind, key, inner), masker.mask)
    assert.deepEqual(event, { text: levels(MAX_JSON_DEPTH + 1, kind, '"\\t***"', expected) }, kind)
    // The walk, one level shallower, masks the same strings the same way.
    const walked = maskedEvent(levels(MAX_JSON_DEPTH, kind, key, inner), masker.mask)
    assert.ok('json' in walked, kind)
    assert.equal(JSON.stringify(walked.json), levels(MAX_JSON_DEPTH, kind, '"\\t***"', expected), kind)
  }
})

test('a JSON line nested past the bound arrives as its text, masked, and nothing throws', () => {
  const masker = createMasker()
  masker.remember({ SFCC_SERVER: 'sandbox-41.example.com', SFCC_CLIENT_SECRET: 'invented-secret-0041' })
  const inner = '"sandbox-41.example.com with invented-secret-0041"'
  for (const kind of ['array', 'object'] as const) {
    // Up to the bound the JSON is walked; one level more and the line is text.
    const walked = maskedEvent(nested(MAX_JSON_DEPTH, kind, inner), masker.mask)
    assert.ok('json' in walked, kind)
    assert.equal(JSON.stringify(walked.json), nested(MAX_JSON_DEPTH, kind, '"*** with ***"'), kind)
    for (const depth of [MAX_JSON_DEPTH + 1, 20_000, 200_000]) {
      assert.deepEqual(maskedEvent(nested(depth, kind, inner), masker.mask), { text: nested(depth, kind, '"*** with ***"') }, `${depth} ${kind}`)
    }
  }
})

test('a long-lived command handed lines nested 20,000 and 200,000 deep goes on handing over its later events', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root, fakeSpawner(() => {}))
    const events: B2cEvent[] = []
    const running = await b2c.start(['code', 'watch'], { role: 'sandbox', jsonl: true, onEvent: (event) => events.push(event) })
    const child = calls[0].child
    for (const depth of [20_000, 200_000]) {
      for (const kind of ['array', 'object'] as const) {
        events.length = 0
        child.stderr.emit('data', Buffer.from(`${nested(depth, kind, '"to Sandbox-41.Example.com"')}\n{"msg":"uploaded to sandbox-41.example.com"}\n`))
        assert.equal(events.length, 2, `${depth} ${kind}`)
        assert.deepEqual(events[0], { text: nested(depth, kind, '"to ***"') })
        assert.deepEqual(events[1], { json: { msg: 'uploaded to ***' } })
      }
    }
    child.finish(0)
    assert.deepEqual(await running.exited, { exitCode: 0, stopped: false })
  }, ADMIN_DW))

test('an error detail keeps what is not a value of the file, and masks a host of it in a URL', () =>
  withWorkspace(async (root) => {
    const message = `${NOT_VALUES.join(' | ')} | https://SANDBOX-41.example.com/on by admin for admin-fix`
    const { b2c } = runner(root, fakeSpawner((call) => call.child.finish(1, '', `${JSON.stringify({ error: { message } })}\n`)))
    const failure = await failureOf(b2c.run(['code', 'activate', 'admin-fix'], { role: 'sandbox' }))
    assert.ok(failure instanceof B2cError)
    assert.equal(failure.detail, `${NOT_VALUES.join(' | ')} | https://***/on by *** for admin-fix`)
  }, ADMIN_DW))

test('mask() hides every value the runner has read, whichever workspace is focused when it is asked', async () => {
  const first = makeWorkspace(ADMIN_DW)
  const second = makeWorkspace({ hostname: 'other-box.example.com', 'client-id': 'invented-other-client-id', 'client-secret': 'invented-other-secret' })
  try {
    let root: string | null = first
    let reads = 0
    const files: FileSystem = {
      async readText(path) {
        reads++
        return existsSync(path) ? readFileSync(path, 'utf8') : null
      }
    }
    const { b2c, calls } = runner(null, fakeSpawner(), { configRoot: async () => root, fs: files, homedir: 'C:\\Users\\someone' })
    // A result taken while the first workspace was the one read.
    await b2c.run(['code', 'list'], { role: 'sandbox' })
    const listed = 'Sandbox-41.Example.com (SANDBOX-41.EXAMPLE.COM, https://sandbox-41.example.com/x, https%3A%2F%2Fsandbox-41.example.com) by admin and first.last%40example.com, invented-client-id-0041, other.sandbox.example.com, 10.1.2.3 in C:\\Users\\someone\\work'
    const masked = '*** (***, https://***/x, https%3A%2F%2F***) by *** and ***, ***, other.sandbox.example.com, 10.1.2.3 in ~\\work'
    assert.equal(await b2c.mask(listed), masked)

    // The focus moves to a workspace with another file, then to none: the text is masked the same.
    root = second
    assert.equal(await b2c.mask(listed), masked)
    root = null
    assert.equal(await b2c.mask(listed), masked)
    assertNothingOf(ADMIN_DW, await b2c.mask(listed), 'masked text')

    // Once the second file has been read, its values are masked too, and the first one's still are.
    root = second
    assert.equal(await b2c.mask('other-box.example.com'), 'other-box.example.com', 'not read yet, and not b2c’s to have printed')
    await b2c.instances()
    root = first
    assert.equal(await b2c.mask('other-box.example.com with invented-other-secret; Sandbox-41.Example.com'), '*** with ***; ***')

    // Masking reads no file: fifty texts cost nothing.
    const before = reads
    for (let i = 0; i < 50; i++) await b2c.mask(listed)
    assert.equal(reads, before)
    for (const text of NOT_VALUES) assert.equal(await b2c.mask(text), text)
    assert.equal(await b2c.mask('code version admin-fix by admin'), 'code version admin-fix by ***')
    assert.equal(calls.length, 1, 'only the command ran')

    // A runner that has read nothing yet reads the file of the moment before it masks.
    const fresh = runner(first).b2c
    assert.equal(await fresh.mask('SANDBOX-41.example.com and invented-secret-0041'), '*** and ***')
    assert.equal(await runner(null).b2c.mask(listed), listed, 'with no file there is nothing to mask')
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test('isHost() is true for the whole host of the role in any letter case, false for anything else, and never throws', () =>
  withWorkspace(async (root) => {
    const { b2c, calls } = runner(root)
    const host = 'Sandbox-41.Example.com'
    for (const value of [host, host.toLowerCase(), host.toUpperCase(), ` ${host} `]) assert.equal(await b2c.isHost('sandbox', value), true, value)
    assert.equal(await b2c.isHost('development', 'DEV-BOX.example.com'), true)
    // A host that contains the role's host, or is contained in it, is another host.
    for (const value of [`x.${host}`, `x${host}`, `${host}.x`, `${host}:443`, `https://${host}`, `${host}/`, 'sandbox-41', 'example.com', '41.example.com', 'sandbox-41.example.co', '']) {
      assert.equal(await b2c.isHost('sandbox', value), false, value)
    }
    // Each role answers for its own host only; a role with no host has none.
    assert.equal(await b2c.isHost('sandbox', 'dev-box.example.com'), false)
    assert.equal(await b2c.isHost('development', host), false)
    assert.equal(await b2c.isHost('production', host), false)
    // Another value of the file is not the host.
    assert.equal(await b2c.isHost('sandbox', 'admin'), false)
    // What a list entry without a host would give: not a string, so not the host.
    for (const value of [undefined, null, 42, true, {}, [], [host], { toString: () => host }, Symbol('x')]) assert.equal(await b2c.isHost('sandbox', value), false, String(typeof value))
    assert.equal(await b2c.isHost('nowhere' as Role, host), false)
    assert.equal(await b2c.isHost(undefined as unknown as Role, host), false)
    assert.equal(await runner(null).b2c.isHost('sandbox', host), false)
    // Even when the settings cannot be read.
    const broken = createB2c({ settings: { read: () => Promise.reject(new Error('no settings')), suffixes: () => Promise.reject(new Error('no settings')), onDidChange: () => ({ dispose() {} }) }, configRoot: async () => root })
    assert.equal(await broken.isHost('sandbox', host), false)
    assert.equal(calls.length, 0, 'it starts no process')
  }, ADMIN_DW))

test('a piece finds its own sandbox in a list b2c returns, and shows the list with nothing of the file unmasked', () =>
  withWorkspace(async (root) => {
    // What `sandbox list --json` might answer: run() hands it over as b2c printed it.
    const answer = { data: [{ id: 'abcd-001', hostName: 'other-09.sandbox.example.com', state: 'stopped' }, { id: 'abcd-002', hostName: INVENTED_DW.hostname.toUpperCase(), state: 'started' }, { id: 'abcd-003', state: 'creating' }] }
    const { b2c } = runner(root, fakeSpawner((call) => call.child.finish(0, JSON.stringify(answer))))
    const result = await b2c.run(['sandbox', 'list'], { role: 'sandbox' })
    assert.deepEqual(result.json, answer, 'the result is the data, unmasked')
    const rows = (result.json as { data: { id: string; hostName?: string; state: string }[] }).data
    const own = []
    // The third row has no host yet: isHost answers false for it instead of throwing.
    for (const row of rows) if (await b2c.isHost('sandbox', row.hostName)) own.push(row.id)
    assert.deepEqual(own, ['abcd-002'])
    const shown = await b2c.mask(rows.map((row) => `${row.id} ${row.hostName ?? '-'} ${row.state}`).join('; '))
    // Another sandbox's host is not a value of the file: it is the data, and stays.
    assert.equal(shown, 'abcd-001 other-09.sandbox.example.com stopped; abcd-002 *** started; abcd-003 - creating')
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
  }))

test('a long-lived process that fails to start says why through exited, at once, and nothing more reaches onEvent', () =>
  withWorkspace(async (root) => {
    // Pipes that never close and a long wait for them: neither may delay the answer.
    let folderExists = true
    const { b2c, calls, logs } = runner(root, fakeSpawner(() => {}), { pipeGraceMs: 60_000, isDirectory: async () => folderExists })
    const failures: [string, boolean, string][] = [
      ['EACCES', true, 'b2c_failed'],
      ['ENOENT', true, 'b2c_not_found'],
      // The folder went away between the check and the start.
      ['ENOENT', false, 'cwd_not_found']
    ]
    for (const [code, folderStays, reason] of failures) {
      folderExists = true
      const events: B2cEvent[] = []
      const chunks: Uint8Array[] = []
      const running = await b2c.start(['code', 'watch'], { role: 'sandbox', jsonl: true, onEvent: (event) => events.push(event), onStdout: (chunk) => chunks.push(chunk) })
      const child = calls[calls.length - 1].child
      folderExists = folderStays
      const started = Date.now()
      child.emit('error', Object.assign(new Error(`spawn ${code} ${INVENTED_DW['client-secret']}`), { code }))
      // As Node does it: the process that never ran also exits and closes.
      child.emit('exit', -4058)
      child.emit('close', -4058)
      assert.deepEqual(await running.exited, { exitCode: null, stopped: false, reason }, code)
      assert.ok(Date.now() - started < 5_000, 'no wait for the pipes')
      // Nothing is left to wait for: no event came, none will, and stdin is closed.
      child.stderr.emit('data', Buffer.from('{"msg":"too late"}\n'))
      child.stdout.emit('data', Buffer.from('too late'))
      assert.deepEqual(events, [], code)
      assert.deepEqual(chunks, [], code)
      assert.equal(running.write('x'), false)
      assert.ok(!child.killed, 'there is nothing to kill')
      running.stop()
      assert.deepEqual(await running.exited, { exitCode: null, stopped: false, reason })
    }
    assert.deepEqual(
      logs.filter((line) => line.includes('failed')),
      ['b2c code (sandbox): failed (b2c_failed)', 'b2c code (sandbox): failed (b2c_not_found)', 'b2c code (sandbox): failed (cwd_not_found)']
    )
    assertNoSecrets(logs.join('\n'), 'the log')
  }))

test('a real program that does not exist fails a long-lived command with b2c_not_found', async () => {
  // The real spawn of a file that is not there: Node reports it after start() has returned.
  const spawn: Spawner = (_file, _args, options) => nodeSpawn(join(tmpdir(), 'sfcc-tools-no-such-program.exe'), [], options)
  const b2c = createB2c({ settings: plainSettings({ b2cPath: process.execPath }), configRoot: async () => null, spawn, homedir: tmpdir() })
  const events: B2cEvent[] = []
  const running = await b2c.start(['docs', 'read', 'x'], { onEvent: (event) => events.push(event) })
  assert.deepEqual(await running.exited, { exitCode: null, stopped: false, reason: 'b2c_not_found' })
  assert.deepEqual(events, [])
  assert.equal(running.write('x'), false)
  // A process that starts and ends has no reason, only its exit code.
  const ok = await nodeRunner('process.exit(3)').start(['docs', 'read', 'x'])
  assert.deepEqual(await ok.exited, { exitCode: 3, stopped: false })
})

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
      const one = await b2c.run(['docs', 'read', arg], { cwd, timeoutMs: 30_000 })
      assert.deepEqual(one.json, ['docs', 'read', arg, '--json'], JSON.stringify(arg))
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
