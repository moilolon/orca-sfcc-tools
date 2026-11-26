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
import { guard, refusedFlag, ROLES, topicOf, type ConfigState, type Role, type RoleState } from './instances'
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
 * with every role's values and anything shaped like a host masked. `argument` is the position
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

/** `json` is the parsed stdout; undefined when b2c printed nothing (`code activate`, `delete`). */
export type RunResult = { stdout: string; stderr: string; json: unknown }

/** One line of a long-lived command's stderr: its JSON event, or the raw text. */
export type B2cEvent = { json: unknown } | { text: string }

export type StartOptions = Omit<RunOptions, 'timeoutMs'> & {
  /** Adds `--jsonl`, so b2c writes its log as one JSON event per line of stderr. */
  jsonl?: boolean
  /** Each line of stderr: its JSON when the line parses, its text otherwise. */
  onEvent?: (event: B2cEvent) => void
  /** Stdout as it arrives, in raw chunks: a debug adapter frames its messages in bytes. */
  onStdout?: (chunk: Uint8Array) => void
}

export type Running = {
  /**
   * Resolves when the process ended and its output was handed over, or at once when `stop()` is
   * called. A process whose pipes stay open after it ended (a grandchild holds them) is not
   * waited for longer than a moment.
   */
  readonly exited: Promise<{ exitCode: number | null; stopped: boolean }>
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
 * The child's environment: everything the worker has except any `SFCC_*` variable (so no
 * inherited `SFCC_INSTANCE` or credential), then no configuration or `.env` file of b2c's own,
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
    if (value !== undefined && !/^SFCC_/i.test(key)) env[key] = value
  }
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
 * A value this short is common inside ordinary words (a one-letter user name is in every
 * sentence), so it only counts when it stands alone.
 */
const SHORT_VALUE = 4

/**
 * The position of the first argument that holds a value read from dw.json, or -1. A value of
 * four characters or more is looked for anywhere in the argument; a shorter one only as the
 * whole argument or the whole value of a `--flag=value`, so it does not block unrelated ones.
 */
export function argumentWithValue(args: readonly string[], values: readonly string[]): number {
  const known = values.filter(Boolean)
  return args.findIndex((arg) => {
    const equals = arg.startsWith('-') ? arg.indexOf('=') : -1
    const flagValue = equals === -1 ? null : arg.slice(equals + 1)
    return known.some((value) => (value.length >= SHORT_VALUE ? arg.includes(value) : arg === value || flagValue === value))
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

/** A host name of three or more labels, the last alphabetic. */
const HOST_LONG = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}[a-z]{2,}\b/gi
/** A name of two labels, the last alphabetic: a host (`shop.internal`) or a file (`Cart.js`). */
const HOST_SHORT = /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.([a-z]{2,})\b/gi
/** Last labels that mean a file, not a host. None of them is a top-level domain. */
const FILE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'isml', 'xml', 'properties', 'css', 'scss', 'html', 'htm', 'txt', 'log', 'yml', 'yaml', 'png', 'jpg', 'svg', 'cmd', 'bat', 'exe', 'ds'])
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g
/** Four or more groups, or a form shortened with `::`; a time (`12:34:56`) is neither. */
const IPV6 = /(?<![0-9a-z:])(?:(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})(?![0-9a-z:])/gi

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `text` with each of `values` masked, then anything shaped like a host: an IP address, a name
 * of three or more labels, or one of two labels that is not a file name. A value shorter than
 * four characters is masked only where it stands alone, never inside a word. `home`, the user's
 * folder (its last part is usually the account name), becomes `~`.
 */
export function redact(text: string, values: readonly string[], home?: string): string {
  let out = text
  for (const value of [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (value.length >= SHORT_VALUE) out = out.split(value).join('***')
    else out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}_])`, 'gu'), '***')
  }
  const root = home?.replace(/[\\/]+$/, '')
  if (root && root.length > 1) out = out.replace(new RegExp(escapeRegExp(root).replace(/\\\\|\//g, '[\\\\/]'), 'gi'), '~')
  return out
    .replace(IPV4, '<host>')
    .replace(IPV6, '<host>')
    .replace(HOST_LONG, '<host>')
    .replace(HOST_SHORT, (name, last: string) => (FILE_EXTENSIONS.has(last.toLowerCase()) ? name : '<host>'))
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

function textOf(chunk: Chunk): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
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

  async function readConfig(): Promise<LoadedConfig> {
    const values = await deps.settings.read()
    return loadConfig({ root: await deps.configRoot(), configFile: values.configFile, suffixes: await deps.settings.suffixes() }, deps.fs)
  }

  /**
   * Guard, flags, credentials, arguments, the folder and the command to spawn; throws a B2cError
   * before any start.
   */
  async function prepare(args: readonly string[], options: { role?: Role; cwd?: string }, flag: '--json' | '--jsonl' | null) {
    const { role } = options
    const verdict = guard(args, role)
    if (!verdict.ok) throw new B2cError(verdict.code)
    const flagAt = refusedFlag(args)
    if (flagAt !== -1) throw new B2cError('flag_not_allowed', { argument: flagAt })
    const config = await readConfig()
    // Every role's values are masked in what b2c answers, not only the ones this command gets.
    const known = ROLES.flatMap((each) => Object.values(config.roles[each].vars)).filter((value): value is string => !!value)
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
    return { command, env, cwd, known, label: `b2c ${topicOf(args)}${verdict.needsRole && role ? ` (${role})` : ''}` }
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
      log(`${prepared.label}: could not start (${codeOfThrown(error)})`)
      throw new B2cError('b2c_failed')
    }
  }

  /** Why a process could not start: a folder that went away gives the same ENOENT as a file. */
  async function startFailure(prepared: Prepared, error: { code?: string }): Promise<B2cErrorCode> {
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
      child.stdout?.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += textOf(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += textOf(chunk)
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
          log(`${prepared.label}: stopped (${code})`)
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
          log(`${prepared.label}: could not start (${codeOfThrown(error)})`)
          void startFailure(prepared, error).then((code) => finish(() => reject(new B2cError(code))))
        })
        child.on('close', (code) => {
          if (failed) return
          const exitCode = code ?? -1
          log(`${prepared.label}: exit ${exitCode}`)
          finish(() => {
            if (exitCode === 0) {
              resolve({ stdout, stderr, json: parseJson(stdout) })
            } else {
              const message = errorMessageOf(stderr)
              reject(new B2cError('b2c_failed', { exitCode, detail: message === null ? null : redact(message, prepared.known, home) }))
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
      const lines = lineSplitter((line) => {
        const json = parseJson(line)
        options.onEvent?.(json === undefined ? { text: line } : { json })
      })
      // Both streams are read whether or not anyone listens: a full pipe would block the process.
      child.stderr?.on('data', (chunk) => {
        if (!done) lines.push(textOf(chunk))
      })
      child.stdout?.on('data', (chunk) => {
        if (!done) options.onStdout?.(bytesOf(chunk))
      })
      // Writing to a process that has ended fails later, as an event: it must not be uncaught.
      child.stdin?.on('error', () => {
        stdinOpen = false
      })
      let resolveExit: (value: { exitCode: number | null; stopped: boolean }) => void = () => {}
      const exited = new Promise<{ exitCode: number | null; stopped: boolean }>((resolve) => {
        resolveExit = resolve
      })
      const end = (exitCode: number | null, stopped: boolean) => {
        if (done) return
        lines.flush()
        done = true
        stdinOpen = false
        clearTimeout(grace)
        options.signal?.removeEventListener('abort', stop)
        log(`${prepared.label}: ${stopped ? 'stopped' : `exit ${exitCode ?? -1}`}`)
        resolveExit({ exitCode, stopped })
      }
      function stop() {
        if (done) return
        killTree(child)
        end(null, true)
      }
      options.signal?.addEventListener('abort', stop, { once: true })
      child.on('error', (error) => {
        log(`${prepared.label}: could not start (${codeOfThrown(error)})`)
        end(null, false)
      })
      // The process has ended but its pipes may still hold output: wait for them to close, though
      // not for long, since the pipes of a tree that left a process behind stay open.
      let exitCode: number | null = null
      child.on('exit', (code) => {
        if (done || grace) return
        exitCode = code
        grace = setTimeout(() => end(code, false), pipeGraceMs)
      })
      child.on('close', (code) => end(exitCode ?? code, false))
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
    }
  }
  return api
}
