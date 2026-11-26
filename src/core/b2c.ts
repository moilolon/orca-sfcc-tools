// The only module that starts a process: the official b2c CLI. It applies the role guard, puts
// the role's host and credentials (from src/core/dw-config.ts) in the environment of the child
// and never in its arguments, and tells b2c to load no configuration file of its own.
//
// On Windows `b2c` is usually a `.cmd` shim, which Node only starts through cmd.exe. The command
// line is then built here: each argument quoted for the program's own parser and its cmd.exe
// characters escaped twice (once for `cmd /c`, once for the shim's `%*`), so spaces, quotes,
// `%`, `&` or `^` reach the program the shim starts unchanged.
//
// What b2c prints: with `--json` a one-shot command writes one JSON document on stdout and exits
// 0; log lines and update notices go to stderr. Any other exit code is a failure (a version
// manager's shim turns every failure into 126), stdout is then empty and the error, when there
// is one, is the last JSON line of stderr or else its last `ERROR:` line. A long-lived command
// with `--jsonl` writes one JSON event per line on stderr.
import { spawn as nodeSpawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, posix } from 'node:path'
import { ConfigError, DW_KEYS, resolveRole, type B2cEnvironment, type FileSystem } from './dw-config'
import { guard, topicOf, type Role } from './instances'
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
  | 'unsafe_argument'
  | 'config_invalid'

/**
 * Its message is its code and nothing else. `detail` is b2c's own error text when it gave one,
 * with the role's host, its credential values and anything shaped like a host name masked.
 */
export class B2cError extends Error {
  readonly code: B2cErrorCode
  readonly exitCode: number | null
  readonly detail: string | null
  constructor(code: B2cErrorCode, exitCode: number | null = null, detail: string | null = null) {
    super(code)
    this.name = 'B2cError'
    this.code = code
    this.exitCode = exitCode
    this.detail = detail
  }
}

type Chunk = string | Uint8Array
type Readable = { on(event: 'data', listener: (chunk: Chunk) => void): unknown } | null

/** The part of a Node ChildProcess the runner uses; tests pass a fake. */
export type ChildLike = {
  readonly pid?: number
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
  stdio: ['ignore', 'pipe', 'pipe']
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
  onEvent?: (event: B2cEvent) => void
}

export type Running = {
  /** Resolves when the process exits or `stop()` is called, without waiting for its pipes. */
  readonly exited: Promise<{ exitCode: number | null; stopped: boolean }>
  stop(): void
}

export type B2c = {
  /** A one-shot command; `--json` is added. Throws a B2cError unless b2c exits 0. */
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>
  /** A long-lived command (`code watch`, `debug`); `--jsonl` is added. */
  start(args: readonly string[], options?: StartOptions): Promise<Running>
  /** b2c's version, `null` when it answers something unexpected. */
  version(): Promise<string | null>
  /** Whether dw.json configures the role. The only thing the rest of the plugin learns of it. */
  configured(role: Role): Promise<boolean>
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
  killTree?: (child: ChildLike) => void
  fs?: FileSystem
  /** The user's home folder: the default `cwd`, and the base of the profile variables. */
  homedir?: string
}

const DEFAULT_TIMEOUT_MS = 120_000
/** More output than this from one command is cut. */
const MAX_OUTPUT_CHARS = 32 * 1024 * 1024
/** Flags that would put a host or a credential in the arguments, or point b2c at another config. */
const CONNECTION_FLAGS = [
  '--server',
  '--hostname',
  '--username',
  '--user',
  '--password',
  '--client-id',
  '--client-secret',
  '--short-code',
  '--tenant-id',
  '--config',
  '--instance',
  '--account-manager-host',
  '--auth-methods'
]

/**
 * How each role may sign in, in order. Never a browser sign-in or a saved session: with no
 * usable credentials b2c fails instead of opening a browser.
 */
export function authMethodsFor(role: Role | undefined): string {
  return role === 'sandbox' ? 'client-credentials,basic' : 'client-credentials'
}

/** Whether the role's variables hold credentials one of its sign-in methods can use. */
export function hasCredentials(role: Role, vars: B2cEnvironment): boolean {
  if (vars.SFCC_CLIENT_ID && vars.SFCC_CLIENT_SECRET) return true
  return role === 'sandbox' && !!vars.SFCC_USERNAME && !!vars.SFCC_PASSWORD
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

/** What to spawn for `file` with `args`: the file itself, or cmd.exe around a shim. */
export function commandFor(
  file: string,
  args: readonly string[],
  { platform, env }: { platform: string; env: Record<string, string | undefined> }
): { file: string; args: string[]; verbatim: boolean } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    // cmd.exe cannot carry a line break, and a quote or percent sign in the shim's own path
    // would be read by cmd.exe itself.
    if (/["%]/.test(file) || args.some((arg) => /[\r\n\0]/.test(arg))) throw new B2cError('unsafe_argument')
    const line = [`"${file}"`, ...args.map(escapeShimArgument)].join(' ')
    const shell = valueOf(env, 'COMSPEC') || 'cmd.exe'
    return { file: shell, args: ['/d', '/s', '/v:off', '/c', `"${line}"`], verbatim: true }
  }
  if (args.some((arg) => arg.includes('\0'))) throw new B2cError('unsafe_argument')
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

/** Refuses a connection flag, or any argument that holds a value read from dw.json. */
export function checkArguments(args: readonly string[], vars: B2cEnvironment): void {
  const values = Object.values(vars).filter((value): value is string => !!value)
  for (const arg of args) {
    const lower = arg.toLowerCase()
    if (CONNECTION_FLAGS.some((flag) => lower === flag || lower.startsWith(`${flag}=`))) throw new B2cError('unsafe_argument')
    if (values.some((value) => arg.includes(value))) throw new B2cError('unsafe_argument')
  }
}

function withFlag(args: readonly string[], flag: '--json' | '--jsonl'): string[] {
  return topicOf(args) === '--version' || args.includes(flag) ? [...args] : [...args, flag]
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

/** Something shaped like a host name: three or more dot-separated labels, the last alphabetic. */
const HOST_LIKE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}[a-z]{2,}\b/gi

/** `text` with each of `values` and anything shaped like a host name masked. */
export function redact(text: string, values: readonly string[]): string {
  let out = text
  for (const value of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(value).join('***')
  return out.replace(HOST_LIKE, '<host>')
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

// ---------------------------------------------------------------------------------------------
// The runner

export function createB2c(deps: B2cDeps): B2c {
  const platform = deps.platform ?? process.platform
  const baseEnv = deps.env ?? process.env
  const spawn: Spawner = deps.spawn ?? ((file, args, options) => nodeSpawn(file, args, options))
  const isFile = deps.isFile ?? defaultIsFile
  const killTree = deps.killTree ?? defaultKillTree
  const log = deps.log ?? (() => {})
  const home = deps.homedir ?? homedir()

  async function roleVariables(role: Role): Promise<B2cEnvironment | null> {
    const values = await deps.settings.read()
    try {
      return await resolveRole(role, { root: await deps.configRoot(), configFile: values.configFile, suffixes: await deps.settings.suffixes() }, deps.fs)
    } catch (error) {
      if (error instanceof ConfigError) throw new B2cError('config_invalid')
      throw error
    }
  }

  /** Guard, credentials, arguments and the command to spawn; throws a B2cError before any start. */
  async function prepare(args: readonly string[], role: Role | undefined, flag: '--json' | '--jsonl') {
    const verdict = guard(args, role)
    if (!verdict.ok) throw new B2cError(verdict.code)
    let vars: B2cEnvironment = {}
    if (verdict.needsRole && role) {
      const resolved = await roleVariables(role)
      if (!resolved) throw new B2cError('role_not_configured')
      // Without usable credentials b2c would fall back to a browser sign-in: never start it.
      if (!hasCredentials(role, resolved)) throw new B2cError('credentials_missing')
      vars = resolved
    }
    checkArguments(args, vars)
    const executable = await resolveExecutable((await deps.settings.read()).b2cPath, { platform, env: baseEnv, isFile })
    if (!executable) throw new B2cError('b2c_not_found')
    const command = commandFor(executable, withFlag(args, flag), { platform, env: baseEnv })
    const env = childEnvironment(baseEnv, vars, { platform, homedir: home, role: verdict.needsRole ? role : undefined })
    const secrets = Object.values(vars).filter((value): value is string => !!value)
    return { command, env, secrets, topic: topicOf(args), label: `b2c ${topicOf(args)}${verdict.needsRole && role ? ` (${role})` : ''}` }
  }

  type Prepared = Awaited<ReturnType<typeof prepare>>

  function launch(prepared: Prepared, cwd: string | undefined): ChildLike {
    return spawn(prepared.command.file, prepared.command.args, {
      cwd: cwd || home,
      env: prepared.env,
      windowsVerbatimArguments: prepared.command.verbatim,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }

  const api: B2c = {
    async run(args, options = {}) {
      const prepared = await prepare(args, options.role, '--json')
      if (options.signal?.aborted) throw new B2cError('aborted')
      const child = launch(prepared, options.cwd)
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
        child.on('error', (error) => {
          log(`${prepared.label}: could not start (${error.code ?? 'error'})`)
          finish(() => reject(new B2cError(error.code === 'ENOENT' ? 'b2c_not_found' : 'b2c_failed')))
        })
        child.on('close', (code) => {
          const exitCode = code ?? -1
          log(`${prepared.label}: exit ${exitCode}`)
          finish(() => {
            if (exitCode === 0) {
              resolve({ stdout, stderr, json: parseJson(stdout) })
            } else {
              const message = errorMessageOf(stderr)
              reject(new B2cError('b2c_failed', exitCode, message === null ? null : redact(message, prepared.secrets)))
            }
          })
        })
      })
    },

    async start(args, options = {}) {
      const prepared = await prepare(args, options.role, '--jsonl')
      if (options.signal?.aborted) throw new B2cError('aborted')
      const child = launch(prepared, options.cwd)
      const lines = lineSplitter((line) => {
        const json = parseJson(line)
        options.onEvent?.(json === undefined ? { text: line } : { json })
      })
      child.stderr?.on('data', (chunk) => lines.push(textOf(chunk)))
      let resolveExit: (value: { exitCode: number | null; stopped: boolean }) => void = () => {}
      let done = false
      const exited = new Promise<{ exitCode: number | null; stopped: boolean }>((resolve) => {
        resolveExit = resolve
      })
      const end = (exitCode: number | null, stopped: boolean) => {
        if (done) return
        done = true
        lines.flush()
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
        log(`${prepared.label}: could not start (${error.code ?? 'error'})`)
        end(null, false)
      })
      // `exit`, not `close`: the pipes of a killed tree can stay open long after it ended.
      child.on('exit', (code) => end(code, false))
      return { exited, stop }
    },

    async version() {
      const result = await api.run(['--version'], { timeoutMs: 30_000 })
      return parseVersion(result.stdout)
    },

    async configured(role) {
      try {
        return (await roleVariables(role)) !== null
      } catch {
        return false
      }
    }
  }
  return api
}
