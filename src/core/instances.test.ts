import { assert, test } from 'orca/testing'
import { B2C_COMMANDS, B2C_VERSION } from './b2c-commands-fixture'
import { ALLOWED_COMMANDS, ALLOWED_FLAGS, commandOf, flagOf, guard, isRole, refusedFlag, ROLES, suffixFor, topicOf } from './instances'

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

/** The allow list as it was decided, written out again here: the constant is checked against it. */
const DECIDED = {
  sandbox: ['code list', 'code deploy', 'code watch', 'code activate', 'code delete', 'logs get', 'logs list', 'logs tail', 'sandbox list', 'sandbox start', 'sandbox stop', 'debug'],
  development: ['logs get', 'logs list', 'logs tail'],
  staging: ['logs get', 'logs list', 'logs tail'],
  production: ['logs get', 'logs list', 'logs tail'],
  none: ['docs read', 'docs search', '--version']
}
/** The ones that take a value of their own: a folder, a code version, a sandbox id, a query. */
const WITH_VALUE = ['code deploy', 'code watch', 'code activate', 'code delete', 'sandbox start', 'sandbox stop', 'docs read', 'docs search']
const EVERY_ROLE = [...ROLES, undefined]

test('the allow list of commands is the one decided, for each role and for none', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(ALLOWED_COMMANDS).map(([who, commands]) => [who, [...commands].sort()])),
    Object.fromEntries(Object.entries(DECIDED).map(([who, commands]) => [who, [...commands].sort()]))
  )
  // Every command in it is a real command of b2c.
  for (const command of Object.values(DECIDED).flat()) {
    if (command !== '--version') assert.ok(B2C_COMMANDS.includes(command.split(' ').join(':')), command)
  }
})

test('the guard: a whole command, for a role that lists it', () => {
  assert.deepEqual(guard(['--version'], undefined), { ok: true, needsRole: false })
  assert.deepEqual(guard(['--version', 'x'], undefined), { ok: false, code: 'role_refused' })
  assert.deepEqual(guard(['--version', '--json'], undefined), { ok: false, code: 'role_refused' })
  assert.deepEqual(guard(['docs', 'read', 'dw.catalog.ProductMgr'], undefined), { ok: true, needsRole: false })
  // A command that needs no role gets none, whatever role is named.
  assert.deepEqual(guard(['docs', 'search', 'x'], 'production'), { ok: true, needsRole: false })
  assert.deepEqual(guard(['logs', 'get'], undefined), { ok: false, code: 'role_required' })
  assert.deepEqual(guard(['code', 'deploy'], undefined), { ok: false, code: 'role_required' })
  for (const command of DECIDED.sandbox) {
    const args = command.split(' ')
    assert.deepEqual(guard(args, 'sandbox'), { ok: true, needsRole: true }, command)
    assert.deepEqual(guard([...args, '--json'], 'sandbox'), { ok: true, needsRole: true }, command)
    assert.equal(commandOf(args), command)
    for (const role of ['development', 'staging', 'production'] as const) {
      const expected = DECIDED[role].includes(command) ? { ok: true, needsRole: true } : { ok: false, code: 'role_refused' }
      assert.deepEqual(guard(args, role), expected, `${command} on ${role}`)
    }
  }
  assert.deepEqual(guard([], 'sandbox'), { ok: false, code: 'role_refused' })
  assert.deepEqual(guard([''], 'sandbox'), { ok: false, code: 'role_refused' })
  assert.equal(commandOf([]), null)
})

test('a topic is not a command: the ones that delete, reset or create are refused on every role', () => {
  const refused = [
    ['sandbox', 'delete', 'abcd-001'],
    ['sandbox', 'reset', 'abcd-001'],
    ['sandbox', 'create'],
    ['sandbox', 'restart', 'abcd-001'],
    ['sandbox', 'update', 'abcd-001'],
    ['sandbox', 'get', 'abcd-001'],
    ['sandbox', 'alias', 'delete', 'abcd-001', 'x'],
    ['sandbox'],
    ['code', 'download'],
    ['code'],
    ['logs'],
    ['docs'],
    ['docs', 'download', 'out'],
    ['docs', 'skill'],
    ['debug', 'cli'],
    ['setup', 'inspect'],
    ['setup', 'instance', 'create', 'x'],
    ['setup'],
    ['auth', 'login'],
    ['auth', 'token'],
    ['webdav', 'rm', 'x'],
    ['webdav', 'put', 'x', 'y'],
    ['job', 'run', 'x'],
    ['job', 'import', 'x'],
    ['plugins', 'install', 'x'],
    ['help'],
    ['version'],
    ['--help'],
    ['--json', 'code', 'deploy'],
    // The `ods` alias of `sandbox`: none of it, not even what `sandbox` may do.
    ['ods', 'list'],
    ['ods', 'start', 'abcd-001'],
    ['ods', 'delete', 'abcd-001'],
    ['ods:stop', 'abcd-001']
  ]
  for (const args of refused) {
    for (const role of EVERY_ROLE) {
      assert.equal(guard(args, role).ok, false, `${args.join(' ')} on ${role ?? 'no role'}`)
      assert.equal(guard([args.join(':')], role).ok, false, `${args.join(':')} on ${role ?? 'no role'}`)
    }
    assert.equal(commandOf(args), null, args.join(' '))
  }
})

test('the colon spelling is the same command, and nothing more of it is', () => {
  assert.equal(commandOf(['code:deploy']), 'code deploy')
  assert.equal(commandOf(['code:deploy', 'cartridges', '-a']), 'code deploy')
  assert.equal(commandOf(['sandbox:start', 'abcd-001']), 'sandbox start')
  assert.equal(commandOf(['docs:read', 'x']), 'docs read')
  assert.deepEqual(guard(['logs:tail', '--last', '5'], 'production'), { ok: true, needsRole: true })
  assert.deepEqual(guard(['code:deploy'], 'production'), { ok: false, code: 'role_refused' })
  for (const args of [['code:deploy:x'], ['code:'], [':code', 'deploy'], ['code', 'deploy:x'], ['code:deploy:'], ['sandbox:delete'], ['debug:cli'], ['Code', 'Deploy'], ['code ', 'deploy'], ['code deploy']]) {
    assert.equal(commandOf(args), null, args.join(' '))
  }
})

test('after a command that takes no value only a flag may follow: a word there would name a longer command', () => {
  for (const command of Object.values(DECIDED).flat()) {
    const args = command.split(' ')
    const takesValue = WITH_VALUE.includes(command)
    assert.equal(commandOf([...args, 'cli']), takesValue ? command : null, `${command} cli`)
    assert.equal(commandOf([...args, 'cli', '--json']), takesValue ? command : null, `${command} cli --json`)
    if (command !== '--version') assert.equal(commandOf([...args, '--json', 'cli']), command, `${command} --json cli`)
  }
  // A flag between the words of a command does not make it that command.
  assert.equal(commandOf(['sandbox', '--json', 'list']), null)
  assert.equal(commandOf(['--json', 'sandbox', 'list']), null)
})

/** Every command of b2c and every topic above one, as the arguments that would run it. */
function everyCommand(): string[] {
  const all = new Set<string>()
  for (const id of B2C_COMMANDS) {
    const words = id.split(':')
    for (let length = 1; length <= words.length; length++) all.add(words.slice(0, length).join(' '))
  }
  return [...all]
}

test(`walks every topic and command of b2c ${B2C_VERSION}: each one outside the list is refused on every role`, () => {
  const commands = everyCommand()
  assert.ok(B2C_COMMANDS.length > 400 && commands.length > B2C_COMMANDS.length, 'the whole list, topics included')
  const passed: Record<string, string[]> = { sandbox: [], development: [], staging: [], production: [], none: [] }
  for (const command of commands) {
    const words = command.split(' ')
    // As separate words, in the colon spelling, and with the first two words joined by a colon.
    const spellings = [words, [words.join(':')], words.length > 2 ? [`${words[0]}:${words[1]}`, ...words.slice(2)] : words]
    for (const role of EVERY_ROLE) {
      const who = role ?? 'none'
      const allowed = DECIDED.none.includes(command) || (role !== undefined && DECIDED[role].includes(command))
      for (const spelling of spellings) {
        for (const rest of [[], ['--json'], ['x'], ['x', '--json'], ['--force', 'x']]) {
          const args = [...spelling, ...rest]
          const expected = allowed && (rest[0] !== 'x' || WITH_VALUE.includes(command))
          assert.equal(guard(args, role).ok, expected, `${args.join(' ')} on ${who}`)
        }
      }
      if (allowed && !passed[who].includes(command)) passed[who].push(command)
    }
  }
  // What got through is the list and nothing else (`--version` is not a command of the walk).
  assert.deepEqual(passed.sandbox.sort(), [...DECIDED.sandbox, 'docs read', 'docs search'].sort())
  for (const role of ['development', 'staging', 'production']) assert.deepEqual(passed[role].sort(), ['docs read', 'docs search', 'logs get', 'logs list', 'logs tail'])
  assert.deepEqual(passed.none.sort(), ['docs read', 'docs search'])
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
