// The only module that starts a process: the official b2c CLI. It applies the role guard and the
// flag allow list, puts the role's host and credentials (from src/core/dw-config.ts) in the
// environment of the child and never in its arguments, and tells b2c to load no configuration
// file of its own.
//
// On Windows `b2c` is usually a `.cmd` shim, which Node only starts through cmd.exe. The command
// line is then built here: each argument quoted for the program's own parser and its cmd.exe
// characters escaped twice (once for `cmd /c`, once for the shim's `%*`). That is enough for a
// plain shim, but a version manager's shim starts a second one and parses the line a third time,
// so an argument that holds a character cmd.exe reads itself (`" % ^ & | < > !`, a line break or
// any other control character) is refused before anything starts. Spaces and the rest arrive
// whole.
//
// What b2c prints: with `--json` a one-shot command writes one JSON document on stdout and exits
// 0; log lines and update notices go to stderr. Any other exit code is a failure (a version
// manager's shim turns every failure into 126), stdout is then empty and the error, when there
// is one, is the last JSON line of stderr or else its last `ERROR:` line. A long-lived command
// with `--jsonl` writes one JSON event per line on stderr; `debug` speaks the debug adapter
// protocol, framed in bytes, on stdin and stdout.
import { spawn as nodeSpawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, posix } from 'node:path'
import { DW_KEYS, loadConfig, type B2cEnvironment, type FileSystem, type LoadedConfig } from './dw-config'
import { commandOf, guard, isRole, refusedFlag, ROLES, topicOf, type ConfigState, type Role, type RoleState } from './instances'
import type { Logger } from './piece'
import type { Settings } from './settings'

export type B2cErrorCode =
  | 'b2c_not_found'
  | 'b2c_failed'
  | 'b2c_timeout'
  | 'aborted'
  | 'role_refused'
  | 'role_required'
  | 'role_not_configured'
  | 'credentials_missing'
  | 'value_invalid'
  | 'flag_not_allowed'
  | 'unsafe_argument'
  | 'cwd_not_found'
  | 'config_invalid'

/**
 * Its message is its code and nothing else. `detail` is b2c's own error text when it gave one,
 * with every value read from a dw.json masked. `argument` is the position
 * (from 0) of the argument a `flag_not_allowed` or `unsafe_argument` refused, never its text.
 */
export class B2cError extends Error {
  readonly code: B2cErrorCode
  readonly exitCode: number | null
  readonly detail: string | null
  readonly argument: number | null
  constructor(code: B2cErrorCode, extra: { exitCode?: number | null; detail?: string | null; argument?: number | null } = {}) {
    super(code)
    this.name = 'B2cError'
    this.code = code
    this.exitCode = extra.exitCode ?? null
    this.detail = extra.detail ?? null
    this.argument = extra.argument ?? null
  }
}

type Chunk = string | Uint8Array
type Readable = { on(event: 'data', listener: (chunk: Chunk) => void): unknown } | null
type Writable = {
  write(data: string | Uint8Array): unknown
  end(): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
} | null

/** The part of a Node ChildProcess the runner uses; tests pass a fake. */
export type ChildLike = {
  readonly pid?: number
  readonly stdin?: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  on(event: 'error', listener: (error: Error & { code?: string }) => void): unknown
  on(event: 'exit' | 'close', listener: (code: number | null) => void): unknown
  kill(): boolean
}

export type SpawnOptions = {
  cwd?: string
  env: Record<string, string>
  windowsVerbatimArguments: boolean
  windowsHide: true
  /** A one-shot command has no stdin; a long-lived one gets a pipe its caller can write to. */
  stdio: ['ignore' | 'pipe', 'pipe', 'pipe']
}

export type Spawner = (file: string, args: readonly string[], options: SpawnOptions) => ChildLike

export type RunOptions = {
  /** The environment whose credentials b2c gets. `docs` and `--version` need none. */
  role?: Role
  /**
   * Where b2c runs. Default: the user's home folder, never the worker's own (Orca starts the
   * worker in its install folder).
   */
  cwd?: string
  signal?: AbortSignal
  /** Default two minutes. */
  timeoutMs?: number
}

/**
 * `json` is the parsed stdout; undefined when b2c printed nothing (`code activate`, `delete`).
 * All three are as b2c printed them, hosts included: a piece needs the data. Whatever of it a
 * piece shows, logs or sends to a panel goes through `mask` first.
 */
export type RunResult = { stdout: string; stderr: string; json: unknown }

/**
 * One line of a long-lived command's stderr: its JSON event, or the raw text. Both arrive
 * masked, once the line is whole: the text, without its ANSI escape sequences, and every string
 * of the JSON, keys included (b2c names the host in its messages). A JSON line nested deeper
 * than `MAX_JSON_DEPTH` arrives as its text, each of its strings masked as the JSON's would be.
 * Only the values of dw.json are masked: a file name, a code version or a cartridge name in an
 * event is as b2c wrote it.
 */
export type B2cEvent = { json: unknown } | { text: string }

export type StartOptions = Omit<RunOptions, 'timeoutMs'> & {
  /** Adds `--jsonl`, so b2c writes its log as one JSON event per line of stderr. */
  jsonl?: boolean
  /** Each line of stderr, already masked: its JSON when the line parses, its text otherwise. */
  onEvent?: (event: B2cEvent) => void
  /**
   * Stdout as it arrives, in raw chunks: a debug adapter frames its messages in bytes. Never
   * masked: what a piece shows of it goes through `mask` first.
   */
  onStdout?: (chunk: Uint8Array) => void
}

/** Why a process could not be started, in the codes `run()` throws for the same failures. */
export type StartFailure = Extract<B2cErrorCode, 'b2c_not_found' | 'cwd_not_found' | 'b2c_failed'>

/**
 * How a long-lived command ended: by itself with `exitCode`, by `stop()`, or, with `reason`,
 * because the process could not be started at all (there is then no exit code and no output).
 */
export type Exit = { exitCode: number | null; stopped: boolean; reason?: StartFailure }

export type Running = {
  /**
   * Resolves when the process ended and its output was handed over, or at once when `stop()` is
   * called or the process fails to start. A process whose pipes stay open after it ended (a
   * grandchild holds them) is not waited for longer than a moment. Nothing reaches `onEvent` or
   * `onStdout` once it has resolved.
   */
  readonly exited: Promise<Exit>
  /** Writes to the child's stdin. False once the process ended or its stdin was closed. */
  write(data: string | Uint8Array): boolean
  /** Closes the child's stdin. */
  end(): void
  stop(): void
}

/** What dw.json configures: the file's own state and each role's. */
export type InstancesState = { config: ConfigState; instances: Record<Role, RoleState> }

export type B2c = {
  /** A one-shot command; `--json` is added. Throws a B2cError unless b2c exits 0. */
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>
  /**
   * A long-lived command (`code watch`, `logs tail`, `debug`). Both of its output streams are
   * always read, whether or not the caller listens, so the process never blocks on a full pipe.
   */
  start(args: readonly string[], options?: StartOptions): Promise<Running>
  /** b2c's version, `null` when it answers something unexpected. */
  version(): Promise<string | null>
  /** The state of dw.json and of each role. The only thing the rest of the plugin learns of it. */
  instances(): Promise<InstancesState>
  /**
   * `text` as it may be shown: every value the runner has read from a dw.json since the worker
   * started is masked, for every role and whichever workspace is focused now, and the home
   * folder, after its ANSI escape sequences are stripped. By exact value, never by shape: other
   * names stay whole. For what a piece takes from a `run()` result or from stdout (b2c is started
   * with `NO_COLOR=1`, so it should print no colour); error details and stderr events are masked
   * already.
   */
  mask(text: string): Promise<string>
  /**
   * Whether `value` is the host of `role`: the whole of it, in any letter case. False for
   * anything that is not a text, and it never throws. It lets a piece find its own instance in
   * a list b2c returns without ever holding the host.
   */
  isHost(role: Role, value: unknown): Promise<boolean>
}

export type B2cDeps = {
  settings: Settings
  /** The workspace whose dw.json is read. */
  configRoot: () => Promise<string | null>
  log?: Logger
  spawn?: Spawner
  platform?: string
  /** The environment the child inherits (minus every `SFCC_*` variable). */
  env?: Record<string, string | undefined>
  isFile?: (path: string) => Promise<boolean>
  isDirectory?: (path: string) => Promise<boolean>
  killTree?: (child: ChildLike) => void
  fs?: FileSystem
  /** The user's home folder: the default `cwd`, and the base of the profile variables. */
  homedir?: string
  /** How long a process that ended is given to close its pipes. Default one second. */
  pipeGraceMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_PIPE_GRACE_MS = 1_000
/** More output than this from one command is cut. */
const MAX_OUTPUT_CHARS = 32 * 1024 * 1024

/**
 * How each role may sign in, in order. Never a browser sign-in or a saved session: with no
 * usable credentials b2c fails instead of opening a browser.
 */
export function authMethodsFor(role: Role | undefined): string {
  return role === 'sandbox' ? 'client-credentials,basic' : 'client-credentials'
}

// ---------------------------------------------------------------------------------------------
// Finding the executable and building the command line

function valueOf(env: Record<string, string | undefined>, wanted: string): string | undefined {
  const key = Object.keys(env).find((name) => name.toUpperCase() === wanted)
  return key ? env[key] : undefined
}

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The file `name` starts: a path as given, or the first match on PATH. On Windows only names
 * with an extension of PATHEXT can run, so `b2c` finds `b2c.cmd` (never the extensionless shell
 * script some installers put beside it).
 */
export async function resolveExecutable(
  name: string,
  { platform, env, isFile }: { platform: string; env: Record<string, string | undefined>; isFile: (path: string) => Promise<boolean> }
): Promise<string | null> {
  const windows = platform === 'win32'
  const joinPath = windows ? (dir: string, file: string) => `${dir.replace(/[\\/]+$/, '')}\\${file}` : posix.join
  const hasDir = /[\\/]/.test(name)
  let extensions = ['']
  if (windows) {
    const pathext = (valueOf(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase())
    if (!pathext.includes(extname(name).toLowerCase())) extensions = pathext
  }
  const dirs = hasDir ? [''] : (valueOf(env, 'PATH') || '').split(windows ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = hasDir ? name + ext : joinPath(dir, name + ext)
      if (await isFile(candidate)) return candidate
    }
  }
  return null
}

/** Quotes one argument for the parser every Windows program uses (CommandLineToArgvW). */
export function quoteWindowsArgument(arg: string): string {
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
    } else {
      out += '\\'.repeat(backslashes) + ch
      backslashes = 0
    }
  }
  return out + '\\'.repeat(backslashes * 2) + '"'
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** An argument for a `.cmd` shim: quoted, then its cmd.exe characters escaped twice. */
export function escapeShimArgument(arg: string): string {
  return quoteWindowsArgument(arg).replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

/**
 * What no argument of a `.cmd` or `.bat` may hold: the characters cmd.exe reads itself, and
 * every control character (a line break ends the command; a tab is one too). The escaping above
 * covers two parses of the line; a shim that starts another shim parses it once more, where a
 * quote closes the quoting, `%NAME%` expands (to a credential, if it names one of the child's
 * variables) and `&` starts another command.
 */
const SHIM_UNSAFE = /["%^&|<>!\u0000-\u001f\u007f]/

/** The position of the first argument a `.cmd` or `.bat` cannot be given safely, or -1. */
export function unsafeShimArgument(args: readonly string[]): number {
  return args.findIndex((arg) => SHIM_UNSAFE.test(arg))
}

/**
 * What to spawn for `file` with `args`: the file itself, or cmd.exe around a shim. Throws
 * `unsafe_argument`, with the position of the argument, before anything is started.
 */
export function commandFor(
  file: string,
  args: readonly string[],
  { platform, env }: { platform: string; env: Record<string, string | undefined> }
): { file: string; args: string[]; verbatim: boolean } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    // A quote or percent sign in the shim's own path would be read by cmd.exe itself.
    if (/["%]/.test(file)) throw new B2cError('unsafe_argument')
    const unsafe = unsafeShimArgument(args)
    if (unsafe !== -1) throw new B2cError('unsafe_argument', { argument: unsafe })
    const line = [`"${file}"`, ...args.map(escapeShimArgument)].join(' ')
    const shell = valueOf(env, 'COMSPEC') || 'cmd.exe'
    return { file: shell, args: ['/d', '/s', '/v:off', '/c', `"${line}"`], verbatim: true }
  }
  const nul = args.findIndex((arg) => arg.includes('\0'))
  if (nul !== -1) throw new B2cError('unsafe_argument', { argument: nul })
  return { file, args: [...args], verbatim: false }
}

// ---------------------------------------------------------------------------------------------
// Environment, arguments and output

/**
 * The variables the child does not inherit: the two that turn colour on whatever the output is,
 * and `NO_COLOR` itself in any letter case, which the child gets as `NO_COLOR=1`.
 */
const COLOUR_VARIABLES = /^(?:FORCE_COLOR|CLICOLOR_FORCE|NO_COLOR)$/i

/**
 * The child's environment: everything the worker has except any `SFCC_*` variable (so no
 * inherited `SFCC_INSTANCE` or credential) and `FORCE_COLOR` or `CLICOLOR_FORCE`, with
 * `NO_COLOR=1` so b2c prints no colour, then no configuration or `.env` file of b2c's own,
 * the role's sign-in methods and its variables.
 *
 * Orca starts the worker with a trimmed environment. On Windows a missing `APPDATA`,
 * `LOCALAPPDATA` or `USERPROFILE` is filled from the home folder, since b2c keeps its cache and
 * configuration under them.
 */
export function childEnvironment(
  base: Record<string, string | undefined>,
  vars: B2cEnvironment,
  { platform, homedir: home, role }: { platform: string; homedir: string; role?: Role }
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !/^SFCC_/i.test(key) && !COLOUR_VARIABLES.test(key)) env[key] = value
  }
  // b2c prints no colour: what it writes on stdout reaches a piece raw, and a colour code right
  // before a short value would keep it from being masked.
  env.NO_COLOR = '1'
  if (platform === 'win32' && home) {
    const root = home.replace(/[\\/]+$/, '')
    const defaults: Record<string, string> = {
      USERPROFILE: root,
      APPDATA: `${root}\\AppData\\Roaming`,
      LOCALAPPDATA: `${root}\\AppData\\Local`
    }
    for (const [name, value] of Object.entries(defaults)) {
      if (!valueOf(env, name)) env[name] = value
    }
  }
  env.SFCC_CONFIG = ''
  env.SFCC_DOTENV_FILE = ''
  env.SFCC_AUTH_METHODS = authMethodsFor(role)
  for (const variable of Object.values(DW_KEYS)) {
    const value = vars[variable]
    if (value !== undefined) env[variable] = value
  }
  return env
}

/**
 * From this length a value of dw.json is looked for anywhere inside an argument or a text. A
 * shorter one is an ordinary word as often as not (a user called `admin`, a code version called
 * `admin-fix`), so it counts only where it stands alone.
 */
const LONG_VALUE = 8

/**
 * From this length the first label of a host can name the instance, and is masked on its own
 * when it also holds a digit or a hyphen (`abcd-005`, `shop-eu01-test`). A plain word
 * (`staging`, `production`) is an ordinary word: it is masked only as part of the whole host.
 */
const INSTANCE_LABEL = 6

/** Whether the first label of a host names an instance rather than being an ordinary word. */
function namesInstance(label: string): boolean {
  return label.length >= INSTANCE_LABEL && /[\d-]/.test(label)
}

/** What b2c's logger prints in place of the secret half of a Basic header it redacts. */
const REDACTED = 'REDACTED'

/** `text` as `application/x-www-form-urlencoded` writes it (a space is `+`). */
function formEncoded(text: string): string {
  return new URLSearchParams([['', text]]).toString().slice(1)
}

/**
 * The base64 of one `left:right` pair, as an `Authorization: Basic` header carries it: its
 * UTF-8 bytes, and its Latin-1 bytes too when every character fits in one and they differ (what
 * `btoa` encodes); each in the standard and the URL-safe alphabets, with and without padding.
 * At most eight forms.
 */
function base64Forms(pair: string): string[] {
  const encodings = [Buffer.from(pair, 'utf8')]
  if (/[\u0080-ÿ]/.test(pair) && !/[^\u0000-ÿ]/.test(pair)) encodings.push(Buffer.from(pair, 'latin1'))
  const urlSafe = (text: string) => text.replace(/\+/g, '-').replace(/\//g, '_')
  return encodings.flatMap((bytes) => {
    const padded = bytes.toString('base64')
    const bare = padded.replace(/=+$/, '')
    return [padded, bare, urlSafe(padded), urlSafe(bare)]
  })
}

/**
 * Every base64 form of the Basic pairs a role's values make, which b2c may print in a header:
 * - `user:password` (the sandbox's sign-in) and `user:REDACTED` (b2c's own redaction of it);
 * - `client-id:client-secret`, raw and with each half form-encoded (how the SDK signs in to
 *   Account Manager by default), and `client-id:REDACTED` in both.
 * Bounded: at most 48 forms per role.
 */
export function basicForms(vars: B2cEnvironment): string[] {
  const pairs: string[] = []
  const { SFCC_USERNAME: user, SFCC_PASSWORD: password, SFCC_CLIENT_ID: id, SFCC_CLIENT_SECRET: secret } = vars
  if (user) {
    if (password) pairs.push(`${user}:${password}`)
    pairs.push(`${user}:${REDACTED}`)
  }
  if (id) {
    if (secret) pairs.push(`${id}:${secret}`, `${formEncoded(id)}:${formEncoded(secret)}`)
    pairs.push(`${id}:${REDACTED}`, `${formEncoded(id)}:${REDACTED}`)
  }
  return [...new Set([...new Set(pairs)].flatMap(base64Forms))]
}

/**
 * ANSI escape sequences: colours and other CSI sequences, OSC sequences (a terminal title, a
 * link), the escapes with intermediate bytes (`ESC ( B`) and the two-character escapes, `ESC 7`
 * and `ESC 8` (save and restore the cursor) included. A colour code ends in a letter
 * (`ESC[1m`), which would leave a short value right after it no longer standing alone, and so
 * unmasked. An OSC sequence ends at its terminator on the same line: one without it loses only
 * its `ESC ]`, and the text after it is kept.
 */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\r\n]*(?:\u0007|\u001b\\)|\u001b[ -/]+[0-~]|\u001b[0-~]|\u009b[0-?]*[ -/]*[@-~]/g

/** `text` without its ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.includes('\u001b') || text.includes('\u009b') ? text.replace(ANSI, '') : text
}

/**
 * The position of the first argument that holds a value read from dw.json, or -1, in any letter
 * case. The runner passes the base64 forms of each role's Basic pairs (`basicForms`) among the
 * values: whatever is masked may not go in an argument. A value of eight characters or more is looked for anywhere in the argument; a shorter
 * one only as the whole argument or the whole value of a `--flag=value`, so it does not block
 * unrelated ones.
 */
export function argumentWithValue(args: readonly string[], values: readonly string[]): number {
  const known = values.filter(Boolean).map((value) => value.toLowerCase())
  return args.findIndex((arg) => {
    const lower = arg.toLowerCase()
    const equals = lower.startsWith('-') ? lower.indexOf('=') : -1
    const flagValue = equals === -1 ? null : lower.slice(equals + 1)
    return known.some((value) => (value.length >= LONG_VALUE ? lower.includes(value) : lower === value || flagValue === value))
  })
}

function withFlag(args: readonly string[], flag: '--json' | '--jsonl' | null): string[] {
  return flag === null || topicOf(args) === '--version' || args.includes(flag) ? [...args] : [...args, flag]
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The source of a pattern that finds `text` in any letter case, without the `i` flag: each letter
 * becomes the class of its cases (`[hH]`), so needles of either kind share one pattern.
 */
function anyCaseSource(text: string): string {
  let source = ''
  for (const char of text) {
    const cases = new Set([char, char.toLowerCase(), char.toUpperCase()].filter((each) => [...each].length === 1))
    source += cases.size > 1 ? `[${[...cases].join('')}]` : escapeRegExp(char)
  }
  return source
}

/** Where a short value stands alone: not inside a word, a hyphenated name or a dotted one. */
const ALONE_BEFORE = '(?<![\\p{L}\\p{N}_-])(?<![\\p{L}\\p{N}_-]\\.)'
const ALONE_AFTER = '(?![\\p{L}\\p{N}_-])(?!\\.[\\p{L}\\p{N}_-])'

function percentEncoded(value: string): string {
  try {
    return encodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * What hides the values of dw.json in a text. It masks by exact value and never by shape:
 * guessing what looks like a host destroys ordinary names (`jquery.min.js`,
 * `dw.order.calculate`, a Java package in a stack trace) that a piece needs whole.
 *
 * It remembers every value it is given and never forgets one, so a text is masked the same
 * whichever workspace is focused when it is masked. What is masked:
 * - each value, as it is written in the file; a host in any letter case;
 * - the first label of a host, when it has six characters or more and holds a digit or a
 *   hyphen: it names the instance. A plain word (`staging`) is masked only within the host;
 * - the base64 of the Basic pairs of a role (`basicForms`): `user:password`,
 *   `client-id:client-secret` raw and form-encoded, and each name with `REDACTED`; in UTF-8
 *   and Latin-1, the standard and the URL-safe alphabets, with and without padding;
 * - the percent-encoded and the JSON-escaped form of a value, where they differ from it;
 * - `home`, the user's folder (its last part is usually the account name), as `~`.
 * A value shorter than eight characters is masked only where it stands alone: a user called
 * `admin` leaves `admin-fix`, `bm_admin_tools` and `Administrator` as they are.
 */
export function createMasker(home?: string) {
  const values = new Set<string>()
  const hosts = new Set<string>()
  /** The pattern of everything remembered; rebuilt only when a value is added or becomes a host. */
  let pattern: RegExp | null = null
  let stale = false
  let compiled = 0

  /**
   * One pattern for everything remembered: each needle is an alternative, the longest first, so a
   * single pass over a text masks them all, and a value is masked whole before a shorter one
   * that starts where it does. Null when there is nothing to mask.
   */
  function compile(): RegExp | null {
    const needles = new Map<string, { text: string; anyCase: boolean; alone: boolean }>()
    const add = (text: string, anyCase: boolean, alone: boolean) => {
      const key = anyCase ? text.toLowerCase() : text
      const same = needles.get(key)
      // The widest reading wins: any case over exact, anywhere over alone.
      if (text) needles.set(key, { text, anyCase: anyCase || !!same?.anyCase, alone: alone && (same?.alone ?? true) })
    }
    for (const value of values) {
      const host = hosts.has(value)
      const alone = value.length < LONG_VALUE
      add(value, host, alone)
      const encoded = percentEncoded(value)
      // The hexadecimal digits of an encoded character come in either case.
      if (encoded !== value) add(encoded, true, alone)
      const escaped = JSON.stringify(value).slice(1, -1)
      if (escaped !== value) add(escaped, host, alone)
      const label = host ? value.split('.')[0] : ''
      if (namesInstance(label) && label !== value) add(label, true, label.length < LONG_VALUE)
    }
    if (needles.size === 0) return null
    const alternatives = [...needles.values()]
      .sort((a, b) => b.text.length - a.text.length)
      .map(({ text, anyCase, alone }) => {
        const body = anyCase ? anyCaseSource(text) : escapeRegExp(text)
        return alone ? `${ALONE_BEFORE}${body}${ALONE_AFTER}` : body
      })
    return new RegExp(alternatives.join('|'), 'gu')
  }

  const root = home?.replace(/[\\/]+$/, '')
  const homePattern = root && root.length > 1 ? new RegExp(escapeRegExp(root).replace(/\\\\|\//g, '[\\\\/]'), 'gi') : null

  return {
    /** Adds the values of one role, as dw.json has them. The host is the one b2c is sent to. */
    remember(vars: B2cEnvironment): void {
      const keep = (value: string, host: boolean) => {
        if (!values.has(value) || (host && !hosts.has(value))) stale = true
        values.add(value)
        if (host) hosts.add(value)
      }
      for (const [variable, value] of Object.entries(vars)) if (value) keep(value, variable === 'SFCC_SERVER')
      for (const form of basicForms(vars)) keep(form, false)
    },
    /**
     * `text` without its ANSI escape sequences, with everything remembered masked in one pass.
     * Anything that is not a text comes back as it is.
     */
    mask(text: string): string {
      if (typeof text !== 'string') return text
      if (stale) {
        pattern = compile()
        stale = false
        compiled++
      }
      let out = stripAnsi(text)
      if (pattern) out = out.replace(pattern, '***')
      return homePattern ? out.replace(homePattern, '~') : out
    },
    /** How many times the pattern has been built: once per change of the values, for the tests. */
    get compiled(): number {
      return compiled
    }
  }
}

/**
 * How deep a JSON line of stderr is walked. b2c's events are a few levels deep; a line nested
 * further (twenty thousand brackets would overflow the stack) arrives as its text, each of its
 * strings masked (`maskJsonText`).
 */
export const MAX_JSON_DEPTH = 100

/** Thrown inside `maskDeep` when a value is nested past `MAX_JSON_DEPTH`. */
class TooDeep extends Error {}

/**
 * A parsed JSON value with every string in it passed through `mask`, keys included (a host can
 * be the key of a map as well as a value). Two keys that mask alike are both kept, the later one
 * numbered. Throws `TooDeep` past `MAX_JSON_DEPTH` levels, before the stack runs out.
 */
function maskDeep(value: unknown, mask: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return mask(value)
  if (!value || typeof value !== 'object') return value
  if (depth >= MAX_JSON_DEPTH) throw new TooDeep()
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, mask, depth + 1))
  const used = new Set<string>()
  const entries: [string, unknown][] = []
  for (const [key, item] of Object.entries(value)) {
    const masked = mask(key)
    let name = masked
    for (let count = 2; used.has(name); count++) name = `${masked} ${count}`
    used.add(name)
    entries.push([name, maskDeep(item, mask, depth + 1)])
  }
  return Object.fromEntries(entries)
}

/** A string of a JSON text, quotes and escapes included. Linear: its two branches never overlap. */
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g

/**
 * The text of a JSON line too deep to walk, masked as the walk would mask it: each of its
 * strings, keys included, is decoded, masked and encoded again. Masked as the raw text, a short
 * value right after an escape (`\n`, `\t`, `é`) would follow a letter or a digit, no longer
 * stand alone, and go through. Linear, with no recursion; a string seen twice is masked once.
 */
function maskJsonText(text: string, mask: (text: string) => string): string {
  const seen = new Map<string, string>()
  return text.replace(JSON_STRING, (token) => {
    let masked = seen.get(token)
    if (masked === undefined) {
      try {
        masked = JSON.stringify(mask(JSON.parse(token) as string))
      } catch {
        masked = mask(token)
      }
      seen.set(token, masked)
    }
    return masked
  })
}

/**
 * One whole line of stderr as the event a caller gets: its JSON masked when the line parses and
 * is no deeper than `MAX_JSON_DEPTH`, else its text with each of its strings masked. A line
 * that is not JSON loses its ANSI escape sequences, then is masked. Never throws on what b2c
 * printed.
 */
export function maskedEvent(line: string, mask: (text: string) => string): B2cEvent {
  const json = parseJson(line)
  if (json === undefined) return { text: mask(line) }
  try {
    return { json: maskDeep(json, mask) }
  } catch {
    // Too deep to walk, or anything else a hostile line could cause: the text, masked string by string.
    return { text: maskJsonText(line, mask) }
  }
}

/**
 * b2c's error message from its stderr: the last line that parses as `{ error: { message } }`,
 * else the text of the last `ERROR:` line, else null.
 */
export function errorMessageOf(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseJson(lines[i]) as { error?: { message?: unknown } } | undefined
    if (parsed && typeof parsed.error?.message === 'string') return parsed.error.message
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^ERROR:\s*(.*)$/)
    if (match) return match[1]
  }
  return null
}

/** The version in `@salesforce/b2c-cli/2.11.0 win32-x64 node-v24` (or a bare `2.11.0`). */
export function parseVersion(text: string): string | null {
  const named = text.match(/b2c-cli\/(\d+\.\d+\.\d+[\w.+-]*)/)
  if (named) return named[1]
  return text.match(/\b(\d+\.\d+\.\d+[\w.+-]*)/)?.[1] ?? null
}

/** Calls `onLine` with each complete line written to a stream, then the rest at `flush`. */
function lineSplitter(onLine: (line: string) => void) {
  let pending = ''
  return {
    push(text: string) {
      pending += text
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line)
    },
    flush() {
      if (pending.trim()) onLine(pending)
      pending = ''
    }
  }
}

function defaultKillTree(child: ChildLike): void {
  // Killing cmd.exe leaves the shim's node process running: end the whole tree.
  if (process.platform === 'win32' && child.pid) {
    const killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill())
  } else {
    child.kill()
  }
}

/**
 * Decodes the chunks of one stream as one text. A pipe cuts its output anywhere, so a character
 * of several bytes can arrive in two chunks: its first bytes are kept until the rest comes,
 * where decoding each chunk alone would give replacement characters.
 */
function streamDecoder() {
  const decoder = new TextDecoder('utf-8')
  return {
    push: (chunk: Chunk): string => (typeof chunk === 'string' ? decoder.decode() + chunk : decoder.decode(chunk, { stream: true })),
    /** What is left when the stream ends: nothing, unless it stopped in the middle of a character. */
    end: (): string => decoder.decode()
  }
}

function bytesOf(chunk: Chunk): Uint8Array {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
}

/** A thrown error's code when it is one (`ENOENT`, `ERR_INVALID_ARG_VALUE`), never its message. */
function codeOfThrown(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'error'
}

// ---------------------------------------------------------------------------------------------
// The runner

export function createB2c(deps: B2cDeps): B2c {
  const platform = deps.platform ?? process.platform
  const baseEnv = deps.env ?? process.env
  const spawn: Spawner = deps.spawn ?? ((file, args, options) => nodeSpawn(file, args, options))
  const isFile = deps.isFile ?? defaultIsFile
  const isDirectory = deps.isDirectory ?? defaultIsDirectory
  const killTree = deps.killTree ?? defaultKillTree
  const log = deps.log ?? (() => {})
  const home = deps.homedir ?? homedir()
  const pipeGraceMs = deps.pipeGraceMs ?? DEFAULT_PIPE_GRACE_MS

  /**
   * Every value read from a dw.json since the worker started, whichever workspace it came from:
   * masking must not depend on the workspace focused at the moment a text is masked.
   */
  const masker = createMasker(home)
  let everRead = false

  /** Every value the file holds, of every role: none of them may be in an argument. */
  function valuesOf(config: LoadedConfig): string[] {
    // The base64 forms of its Basic pairs count too: they are masked, so they may not go in an argument.
    return ROLES.flatMap((each) => [...Object.values(config.roles[each].vars), ...basicForms(config.roles[each].vars)]).filter(
      (value): value is string => !!value
    )
  }

  async function readConfig(): Promise<LoadedConfig> {
    const values = await deps.settings.read()
    const config = await loadConfig({ root: await deps.configRoot(), configFile: values.configFile, suffixes: await deps.settings.suffixes() }, deps.fs)
    for (const role of ROLES) masker.remember(config.roles[role].vars)
    everRead = true
    return config
  }

  /**
   * Guard, flags, credentials, arguments, the folder and the command to spawn; throws a B2cError
   * before any start.
   */
  async function prepare(args: readonly string[], options: { role?: Role; cwd?: string }, flag: '--json' | '--jsonl' | null) {
    const { role } = options
    const verdict = guard(args, role)
    if (!verdict.ok) throw new B2cError(verdict.code)
    // `--version` is a command of its own, not a flag any other command may carry.
    const flagAt = commandOf(args) === '--version' ? -1 : refusedFlag(args)
    if (flagAt !== -1) throw new B2cError('flag_not_allowed', { argument: flagAt })
    const config = await readConfig()
    const known = valuesOf(config)
    const mask = masker.mask
    let vars: B2cEnvironment = {}
    if (verdict.needsRole && role) {
      if (config.state === 'invalid') throw new B2cError('config_invalid')
      const own = config.roles[role]
      if (own.state === 'absent') throw new B2cError('role_not_configured')
      // Without usable credentials b2c would fall back to a browser sign-in: never start it.
      if (own.state === 'incomplete') throw new B2cError(own.reason ?? 'credentials_missing')
      vars = own.vars
      const valueAt = argumentWithValue(args, known)
      if (valueAt !== -1) throw new B2cError('unsafe_argument', { argument: valueAt })
    }
    const executable = await resolveExecutable((await deps.settings.read()).b2cPath, { platform, env: baseEnv, isFile })
    if (!executable) throw new B2cError('b2c_not_found')
    const command = commandFor(executable, withFlag(args, flag), { platform, env: baseEnv })
    const cwd = options.cwd || home
    if (!(await isDirectory(cwd))) throw new B2cError('cwd_not_found')
    const env = childEnvironment(baseEnv, vars, { platform, homedir: home, role: verdict.needsRole ? role : undefined })
    const label = `b2c ${topicOf(args)}${verdict.needsRole && role ? ` (${role})` : ''}`
    // What the runner writes to the log goes through the mask too, whatever it comes to hold.
    return { command, env, cwd, mask, say: (message: string) => log(mask(`${label}: ${message}`)) }
  }

  type Prepared = Awaited<ReturnType<typeof prepare>>

  /** Starts the process. Whatever `spawn` throws names the offending value: only its code is kept. */
  function launch(prepared: Prepared, stdin: 'ignore' | 'pipe'): ChildLike {
    try {
      return spawn(prepared.command.file, prepared.command.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        windowsVerbatimArguments: prepared.command.verbatim,
        windowsHide: true,
        stdio: [stdin, 'pipe', 'pipe']
      })
    } catch (error) {
      prepared.say(`could not start (${codeOfThrown(error)})`)
      throw new B2cError('b2c_failed')
    }
  }

  /** Why a process could not start: a folder that went away gives the same ENOENT as a file. */
  async function startFailure(prepared: Prepared, error: { code?: string }): Promise<StartFailure> {
    if (error.code !== 'ENOENT') return 'b2c_failed'
    return (await isDirectory(prepared.cwd)) ? 'b2c_not_found' : 'cwd_not_found'
  }

  const api: B2c = {
    async run(args, options = {}) {
      const prepared = await prepare(args, options, '--json')
      if (options.signal?.aborted) throw new B2cError('aborted')
      const child = launch(prepared, 'ignore')
      let stdout = ''
      let stderr = ''
      const out = streamDecoder()
      const err = streamDecoder()
      child.stdout?.on('data', (chunk) => {
        const text = out.push(chunk)
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += text
      })
      child.stderr?.on('data', (chunk) => {
        const text = err.push(chunk)
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += text
      })
      return new Promise<RunResult>((resolve, reject) => {
        let settled = false
        const finish = (outcome: () => void) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          outcome()
        }
        // A stopped tree can keep its pipes open for a while: answer as soon as the kill is sent.
        const stop = (code: B2cErrorCode) => {
          if (settled) return
          killTree(child)
          prepared.say(`stopped (${code})`)
          finish(() => reject(new B2cError(code)))
        }
        const timer = setTimeout(() => stop('b2c_timeout'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        const onAbort = () => stop('aborted')
        options.signal?.addEventListener('abort', onAbort, { once: true })
        // A process that could not start also closes: the failure is reported once, as itself.
        let failed = false
        child.on('error', (error) => {
          if (failed) return
          failed = true
          prepared.say(`could not start (${codeOfThrown(error)})`)
          void startFailure(prepared, error).then((code) => finish(() => reject(new B2cError(code))))
        })
        child.on('close', (code) => {
          if (failed) return
          const exitCode = code ?? -1
          prepared.say(`exit ${exitCode}`)
          finish(() => {
            stdout += out.end()
            stderr += err.end()
            if (exitCode === 0) {
              resolve({ stdout, stderr, json: parseJson(stdout) })
            } else {
              const message = errorMessageOf(stderr)
              reject(new B2cError('b2c_failed', { exitCode, detail: message === null ? null : prepared.mask(message) }))
            }
          })
        })
      })
    },

    async start(args, options = {}) {
      const prepared = await prepare(args, options, options.jsonl ? '--jsonl' : null)
      if (options.signal?.aborted) throw new B2cError('aborted')
      const child = launch(prepared, 'pipe')
      let done = false
      let stdinOpen = !!child.stdin
      let grace: ReturnType<typeof setTimeout> | undefined
      const lines = lineSplitter((line) => options.onEvent?.(maskedEvent(line, prepared.mask)))
      const decoder = streamDecoder()
      // Both streams are read whether or not anyone listens: a full pipe would block the process.
      child.stderr?.on('data', (chunk) => {
        if (!done) lines.push(decoder.push(chunk))
      })
      child.stdout?.on('data', (chunk) => {
        if (!done) options.onStdout?.(bytesOf(chunk))
      })
      // Writing to a process that has ended fails later, as an event: it must not be uncaught.
      child.stdin?.on('error', () => {
        stdinOpen = false
      })
      let resolveExit: (value: Exit) => void = () => {}
      const exited = new Promise<Exit>((resolve) => {
        resolveExit = resolve
      })
      const end = (exitCode: number | null, stopped: boolean, reason?: StartFailure) => {
        if (done) return
        // What the pipe still held is handed over first; then nothing more is.
        lines.push(decoder.end())
        lines.flush()
        done = true
        stdinOpen = false
        clearTimeout(grace)
        options.signal?.removeEventListener('abort', stop)
        prepared.say(stopped ? 'stopped' : reason ? `failed (${reason})` : `exit ${exitCode ?? -1}`)
        resolveExit(reason ? { exitCode, stopped, reason } : { exitCode, stopped })
      }
      function stop() {
        if (done) return
        killTree(child)
        end(null, true)
      }
      options.signal?.addEventListener('abort', stop, { once: true })
      // A process that could not start has no exit code: `exited` says why instead, at once and
      // without waiting for pipes that will never carry anything. It also closes: the failure is
      // reported once, as itself.
      let failed = false
      child.on('error', (error) => {
        if (done || failed) return
        failed = true
        prepared.say(`could not start (${codeOfThrown(error)})`)
        void startFailure(prepared, error).then((reason) => end(null, false, reason))
      })
      // The process has ended but its pipes may still hold output: wait for them to close, though
      // not for long, since the pipes of a tree that left a process behind stay open.
      let exitCode: number | null = null
      child.on('exit', (code) => {
        if (done || failed || grace) return
        exitCode = code
        grace = setTimeout(() => end(code, false), pipeGraceMs)
      })
      child.on('close', (code) => {
        if (!failed) end(exitCode ?? code, false)
      })
      return {
        exited,
        write(data) {
          if (done || !stdinOpen || !child.stdin) return false
          try {
            child.stdin.write(data)
            return true
          } catch {
            stdinOpen = false
            return false
          }
        },
        end() {
          if (!stdinOpen || !child.stdin) return
          stdinOpen = false
          try {
            child.stdin.end()
          } catch {
            // Already closed.
          }
        },
        stop
      }
    },

    async version() {
      const result = await api.run(['--version'], { timeoutMs: 30_000 })
      return parseVersion(result.stdout)
    },

    async instances() {
      const config = await readConfig()
      const instances = {} as Record<Role, RoleState>
      for (const role of ROLES) instances[role] = config.roles[role].state
      return { config: config.state, instances }
    },

    async mask(text) {
      // Whatever b2c printed, it printed after the runner read the file it was started with. The
      // file is read here only when nothing has been read yet since the worker started.
      if (!everRead) await readConfig()
      return masker.mask(text)
    },

    async isHost(role, value) {
      if (typeof value !== 'string' || !isRole(role)) return false
      try {
        const host = (await readConfig()).roles[role].vars.SFCC_SERVER
        return !!host && host.trim().toLowerCase() === value.trim().toLowerCase()
      } catch {
        return false
      }
    }
  }
  return api
}
