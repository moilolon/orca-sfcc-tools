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

/** Commands that run with no environment and get no credentials. */
const ROLELESS = new Set(['docs', '--version'])
/** What the sandbox may run: upload, debugging, the sandbox itself (`ods` is its alias), logs. */
const SANDBOX_TOPICS = new Set(['code', 'debug', 'sandbox', 'ods', 'logs'])
/** What development, staging and production may run: reading logs, nothing else. */
const READ_ONLY_TOPICS = new Set(['logs'])

/** The command's topic: `code` for `code deploy` and for oclif's `code:deploy` form. */
export function topicOf(args: readonly string[]): string {
  const first = args[0] ?? ''
  return first.startsWith('-') ? first : first.split(':')[0]
}

export type GuardResult = { ok: true; needsRole: boolean } | { ok: false; code: 'role_refused' | 'role_required' }

/**
 * Whether `args` may run for `role`. An allow list: a topic not named here is refused, whatever
 * the role. `docs` and `--version` need no role and are run without credentials.
 */
export function guard(args: readonly string[], role: Role | undefined): GuardResult {
  const topic = topicOf(args)
  if (ROLELESS.has(topic)) {
    // `--version` alone; `docs` with anything after it.
    if (topic === '--version' && args.length !== 1) return { ok: false, code: 'role_refused' }
    return { ok: true, needsRole: false }
  }
  if (!role) return { ok: false, code: 'role_required' }
  const allowed = role === 'sandbox' ? SANDBOX_TOPICS : READ_ONLY_TOPICS
  return allowed.has(topic) ? { ok: true, needsRole: true } : { ok: false, code: 'role_refused' }
}
