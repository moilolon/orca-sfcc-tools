// Opens a file of a workspace at a line in Orca's editor, through `orca file open`. Used by any
// piece that links to a file (a frame of a stack trace, a breakpoint, a finding).
//
// With src/core/b2c.ts, the only module that starts a process; it starts Orca's own command line,
// never b2c, and imports nothing of b2c.ts or dw-config.ts, so no value of dw.json reaches it.
//
// A plugin worker runs with a trimmed environment, with no `APPDATA`, and with Orca's install
// folder as its working folder, so the call works only when the child gets `APPDATA` (filled from
// the home folder when missing, with `LOCALAPPDATA` and `USERPROFILE`; nothing else is added) and
// the workspace is named with `--worktree path:<root>` rather than guessed from the working
// folder. The executable is `resources/bin/orca` (`orca.exe` on Windows) beside the running Orca
// (`process.execPath`), else `orca` on the PATH. It is started directly, never through a shell:
// on Windows only an `.exe`, so an `orca.cmd` or `orca.bat` on the PATH is refused
// (`orca_shim_refused`) rather than handed to cmd.exe. `--focus`, which switches Orca's window to
// the workspace, is passed only when the caller asks: a link the person pressed asks for it.
//
// Only a file inside the workspace is opened: the path is resolved, through symbolic links too,
// and refused when it leaves the workspace's folder.
import { spawn as nodeSpawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { Logger } from './piece'

export type OpenFileRequest = {
  /** The workspace's folder, on this machine. */
  root: string
  /** The file: absolute, or relative to `root`. */
  path: string
  /** 1-based. */
  line?: number
  /** 1-based; only with `line`. */
  column?: number
  /** Brings the person to the file. Only when they asked to see it. */
  focus?: boolean
}

export type OpenFileFailure = 'outside_workspace' | 'not_found' | 'orca_not_found' | 'orca_shim_refused' | 'orca_failed' | 'orca_timeout'

export type OpenFileResult = { opened: true } | { opened: false; reason: OpenFileFailure }

/** What the child is started with: never a shell, never verbatim arguments. */
export type OpenFileSpawnOptions = {
  cwd: string
  env: Record<string, string>
  shell: false
  windowsVerbatimArguments: false
  windowsHide: true
  stdio: ['ignore', 'pipe', 'pipe']
}

/** The part of a Node ChildProcess this module uses; tests pass a fake. */
export type OpenFileChild = {
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null) => void): unknown
  kill(): boolean
}

export type OpenFileSpawner = (file: string, args: readonly string[], options: OpenFileSpawnOptions) => OpenFileChild

export type OpenFileDeps = {
  spawn?: OpenFileSpawner
  /** The running Orca's executable; default `process.execPath`. */
  execPath?: string
  platform?: string
  /** The worker's environment; default `process.env`. */
  env?: Record<string, string | undefined>
  homedir?: string
  isFile?: (path: string) => Promise<boolean>
  /** The real path of a file or folder, links followed; null when it does not exist. */
  realPath?: (path: string) => Promise<string | null>
  /** Default 15 seconds. */
  timeoutMs?: number
  log?: Logger
}

const DEFAULT_TIMEOUT_MS = 15_000

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function defaultRealPath(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

function pathFor(platform: string) {
  return platform === 'win32' ? win32 : posix
}

/** Whether `path` is `root` itself or below it. Case-insensitive on Windows, as its paths are. */
export function isInside(root: string, path: string, platform: string): boolean {
  const api = pathFor(platform)
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value)
  const rel = api.relative(fold(root), fold(path))
  // `..cache` is a folder of the workspace; only `..` itself, or `..` and a separator, leaves it.
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + api.sep) && !api.isAbsolute(rel))
}

function valueOf(env: Record<string, string | undefined>, wanted: string): string | undefined {
  const key = Object.keys(env).find((name) => name.toUpperCase() === wanted)
  return key ? env[key] : undefined
}

/**
 * The child's environment: the worker's own, with the folders Orca's command line keeps its state
 * under filled from the home folder when the worker has none. Nothing else is added.
 */
export function orcaEnvironment(base: Record<string, string | undefined>, { platform, homedir: home }: { platform: string; homedir: string }): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (typeof value === 'string') env[key] = value
  if (platform === 'win32') {
    const has = (name: string) => Boolean(valueOf(env, name))
    if (!has('USERPROFILE')) env.USERPROFILE = home
    if (!has('APPDATA')) env.APPDATA = win32.join(home, 'AppData', 'Roaming')
    if (!has('LOCALAPPDATA')) env.LOCALAPPDATA = win32.join(home, 'AppData', 'Local')
  }
  return env
}

/** The arguments of `orca file open`, the workspace named explicitly; nothing else. */
export function openArguments(file: string, root: string, { line, column, focus }: Pick<OpenFileRequest, 'line' | 'column' | 'focus'>): string[] {
  const args = ['file', 'open', file, '--worktree', `path:${root}`]
  const whole = (value: number | undefined) => typeof value === 'number' && Number.isInteger(value) && value > 0
  if (whole(line)) {
    args.push('--line', String(line))
    if (whole(column)) args.push('--column', String(column))
  }
  if (focus) args.push('--focus')
  args.push('--json')
  return args
}

/**
 * The Orca to start: the one beside the running Orca, else `orca` on the PATH. On Windows only
 * `orca.exe` is started; a `.cmd` or `.bat` found first on the PATH is refused.
 */
export async function findOrca({ execPath, platform, env, isFile }: { execPath: string; platform: string; env: Record<string, string | undefined>; isFile: (path: string) => Promise<boolean> }): Promise<{ file: string } | { refused: OpenFileFailure }> {
  const api = pathFor(platform)
  const windows = platform === 'win32'
  const bundled = api.join(api.dirname(execPath), 'resources', 'bin', windows ? 'orca.exe' : 'orca')
  if (await isFile(bundled)) return { file: bundled }
  const dirs = (valueOf(env, 'PATH') || '').split(windows ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    if (!windows) {
      const candidate = api.join(dir, 'orca')
      if (await isFile(candidate)) return { file: candidate }
      continue
    }
    if (await isFile(api.join(dir, 'orca.exe'))) return { file: api.join(dir, 'orca.exe') }
    // A shim would need cmd.exe, which reads characters of the path itself.
    for (const shim of ['orca.cmd', 'orca.bat']) if (await isFile(api.join(dir, shim))) return { refused: 'orca_shim_refused' }
  }
  return { refused: 'orca_not_found' }
}

/** Waits for the child to end: `ok` for exit 0, `timeout` past the limit (it is then stopped). */
function waitFor(child: OpenFileChild, timeoutMs: number): Promise<'ok' | 'failed' | 'timeout'> {
  return new Promise((done) => {
    let settled = false
    const finish = (result: 'ok' | 'failed' | 'timeout') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish('timeout')
    }, timeoutMs)
    // Both pipes are read, so the child never blocks on a full one; what it prints is not kept.
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    child.on('error', () => finish('failed'))
    child.on('exit', (code) => finish(code === 0 ? 'ok' : 'failed'))
  })
}

export type OpenFile = (request: OpenFileRequest) => Promise<OpenFileResult>

export function createOpenFile(deps: OpenFileDeps = {}): OpenFile {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const home = deps.homedir ?? osHomedir()
  const isFile = deps.isFile ?? defaultIsFile
  const realPath = deps.realPath ?? defaultRealPath
  const spawn: OpenFileSpawner = deps.spawn ?? ((file, args, options) => nodeSpawn(file, args, options))
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const api = pathFor(platform)

  return async function openFile(request) {
    const root = api.resolve(request.root)
    const file = api.resolve(root, request.path)
    if (!isInside(root, file, platform)) return { opened: false, reason: 'outside_workspace' }
    const [realRoot, realFile] = await Promise.all([realPath(root), realPath(file)])
    if (realRoot === null || realFile === null || !(await isFile(realFile))) return { opened: false, reason: 'not_found' }
    // A link inside the workspace may point out of it.
    if (!isInside(realRoot, realFile, platform)) return { opened: false, reason: 'outside_workspace' }
    // The file opened is the one checked: its real path, written under the workspace's folder as
    // Orca knows it, so a link changed after the check cannot send the call elsewhere.
    const opened = api.join(root, api.relative(realRoot, realFile))
    const orca = await findOrca({ execPath: deps.execPath ?? process.execPath, platform, env, isFile })
    if ('refused' in orca) return { opened: false, reason: orca.refused }
    let child: OpenFileChild
    try {
      child = spawn(orca.file, openArguments(opened, root, request), {
        cwd: root,
        env: orcaEnvironment(env, { platform, homedir: home }),
        shell: false,
        windowsVerbatimArguments: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      return { opened: false, reason: 'orca_failed' }
    }
    const result = await waitFor(child, timeoutMs)
    if (result === 'ok') return { opened: true }
    deps.log?.(`orca file open ${result === 'timeout' ? 'timed out' : 'failed'}`)
    return { opened: false, reason: result === 'timeout' ? 'orca_timeout' : 'orca_failed' }
  }
}
