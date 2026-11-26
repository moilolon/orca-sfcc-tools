// The four environments the plugin talks to, and the guard that decides which b2c commands each
// one may run. Pure: no Node or Orca imports.

export const ROLES = ['sandbox', 'development', 'staging', 'production'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** The suffix each role appends to the keys of dw.json; the sandbox uses the plain keys. */
export type Suffixes = { readonly development: string; readonly staging: string; readonly production: string }

/**
 * The suffix of a role's keys, or null when the role cannot be resolved safely: a non-sandbox
 * role with an empty suffix would read the sandbox's keys, and two roles sharing a suffix would
 * read each other's. Either way the role is reported as not configured.
 */
export function suffixFor(role: Role, suffixes: Suffixes): string | null {
  if (role === 'sandbox') return ''
  const own = suffixes[role]
  if (!own) return null
  const others = (['development', 'staging', 'production'] as const).filter((other) => other !== role)
  return others.some((other) => suffixes[other] === own) ? null : own
}

/** Reading logs: all that development, staging and production may be asked. */
const READ_LOGS = ['logs get', 'logs list', 'logs tail'] as const

/**
 * Every command the plugin may run, whole, by who may run it: an allow list. A topic is not
 * enough: `sandbox` also deletes and resets a sandbox, `code` also downloads one. Whatever is not
 * here is refused for every role, the `ods` alias of `sandbox` included. `none` needs no role
 * and gets no credentials.
 */
export const ALLOWED_COMMANDS: Readonly<Record<Role | 'none', readonly string[]>> = {
  sandbox: ['code list', 'code deploy', 'code watch', 'code activate', 'code delete', ...READ_LOGS, 'sandbox list', 'sandbox start', 'sandbox stop', 'debug'],
  development: READ_LOGS,
  staging: READ_LOGS,
  production: READ_LOGS,
  none: ['docs read', 'docs search', '--version']
}

/**
 * The allowed commands that take a value of their own right after their name: a folder, a code
 * version, a sandbox id, a query. After any other one only a flag may follow: a plain word there
 * could only name a longer command (`debug cli`), which b2c would run instead.
 */
const TAKES_VALUE: ReadonlySet<string> = new Set(['code deploy', 'code watch', 'code activate', 'code delete', 'sandbox start', 'sandbox stop', 'docs read', 'docs search'])

const EVERY_COMMAND: readonly string[] = [...new Set(Object.values(ALLOWED_COMMANDS).flat())]

/** The command's topic: `code` for `code deploy` and for oclif's `code:deploy` form. */
export function topicOf(args: readonly string[]): string {
  const first = args[0] ?? ''
  return first.startsWith('-') ? first : first.split(':')[0]
}

/**
 * The allowed command `args` begin with, or null. Its words must be the first arguments, as
 * written in the list; oclif's colon spelling of them (`code:deploy`) counts as the same
 * command, nothing more of it does (`code:deploy:x`). `--version` stands alone.
 */
export function commandOf(args: readonly string[]): string | null {
  const [first = '', ...rest] = args
  if (first.startsWith('-')) return first === '--version' && rest.length === 0 ? first : null
  const head = first.split(':')
  for (const command of EVERY_COMMAND) {
    const words = command.split(' ')
    const tail = words.slice(head.length)
    if (head.length > words.length || head.some((word, i) => word !== words[i]) || tail.some((word, i) => word !== rest[i])) continue
    const next = rest[tail.length]
    if (next === undefined || next.startsWith('-') || TAKES_VALUE.has(command)) return command
  }
  return null
}

export type GuardResult = { ok: true; needsRole: boolean } | { ok: false; code: 'role_refused' | 'role_required' }

/**
 * Whether `args` may run for `role`: only a command of `ALLOWED_COMMANDS`, and only for a role
 * that lists it. `docs read`, `docs search` and `--version` need no role and are run without
 * credentials.
 */
export function guard(args: readonly string[], role: Role | undefined): GuardResult {
  const command = commandOf(args)
  if (command === null) return { ok: false, code: 'role_refused' }
  if (ALLOWED_COMMANDS.none.includes(command)) return { ok: true, needsRole: false }
  if (!role) return { ok: false, code: 'role_required' }
  return ALLOWED_COMMANDS[role].includes(command) ? { ok: true, needsRole: true } : { ok: false, code: 'role_refused' }
}

/** What dw.json holds for a role: a host and credentials b2c can use, a host alone, or nothing. */
export type RoleState = 'ready' | 'incomplete' | 'absent'
/** The dw.json file itself: read, not found, or not a JSON object. */
export type ConfigState = 'ok' | 'missing' | 'invalid'

/**
 * Every flag a command may carry: an allow list. None of them names a host, a user, a credential,
 * an instance, a configuration or `.env` file, a project folder, a certificate or a sign-in
 * method: those reach b2c through its environment (src/core/b2c.ts) and nowhere else. A short
 * flag stands for a different long one per command (`-c` is `--cartridge`, `--columns` or
 * `--category`), and none of its meanings is in that group. `--wait` is left out on purpose,
 * waiting on b2c being unreliable for a sandbox, and with it its `--poll-interval` and
 * `--timeout`. `--version` is not here either: it is a command, in `ALLOWED_COMMANDS`.
 */
export const ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  '--json',
  '--jsonl',
  '-v',
  '--code-version',
  '-c',
  '--cartridge',
  '-x',
  '--exclude-cartridge',
  '-a',
  '--activate',
  '-r',
  '--reload',
  '--delete',
  '--cartridge-ignore-dirs',
  '--cartridge-path',
  '-f',
  '--filter',
  '--force',
  '-n',
  '--count',
  '--since',
  '--level',
  '-g',
  '--search',
  '--no-normalize',
  '--no-color',
  '-l',
  '--last',
  '--limit',
  '--list',
  '--interval',
  '--sort',
  '-o',
  '--order',
  '--offset',
  '--columns',
  '--extended',
  '--category',
  '--raw',
  '--topics',
  '--workspace',
  '--realm',
  '--show-deleted'
])

/** The flag an argument names (`--level` for `--level=ERROR`), or null for a plain value. */
export function flagOf(arg: string): string | null {
  if (!arg.startsWith('-')) return null
  const equals = arg.indexOf('=')
  return equals === -1 ? arg : arg.slice(0, equals)
}

/**
 * The position of the first argument that starts with `-` and is not an allowed flag, or -1.
 * The whole name must match, so `-s x`, `-s=x`, `--server x` and `--server=x` are all refused,
 * and so are grouped short flags (`-ar`), a value glued to one (`-shost`) and a bare `--`.
 */
export function refusedFlag(args: readonly string[]): number {
  return args.findIndex((arg) => {
    const flag = flagOf(arg)
    return flag !== null && !ALLOWED_FLAGS.has(flag)
  })
}
