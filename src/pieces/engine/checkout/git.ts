// Reads a git ref of the checkout's repository without checking it out, for the cartridge paths
// and metadata of `metadataRef` (`checkout.ts` asks it through `RefReader`). Worker only.
//
// With src/core/b2c.ts and src/core/open-file.ts, the only module that starts a process. It
// imports nothing of b2c.ts or dw-config.ts and handles no value of dw.json. It runs three
// commands and nothing else, each read-only, so it writes nothing (no checkout, no fetch, no
// change of configuration, no optional lock, no fetch of a missing object in a partial clone):
//
// - `rev-parse --verify --quiet <ref>^{commit}`: the commit a ref names;
// - `ls-tree --full-tree -r --name-only <ref> -- <path>`: the files below a path at that commit,
//   from the repository's root whatever folder of it the workspace is, as `show` takes them;
// - `show <ref>:<path>`: one file's text at that commit. When it fails, `ls-tree` of that one path
//   tells a file the commit does not have (null) from a failure (`git_failed`).
//
// A ref must match `REF_PATTERN` (letters, digits, `/ . _ -`, no leading `-`, no `..`, no `@{`,
// at most 200 characters) and a path `validGitPath` (relative, inside the repository, no leading
// `-`, no `..`); anything else is refused (`ref_invalid`, `path_invalid`) before git starts. Git
// is started directly with an argument array, never through a shell, in the workspace's folder,
// within a timeout, reading at most `MAX_OUTPUT_BYTES` of its output. On Windows only a
// `git.exe` is started: a `git.cmd` or `git.bat` found first on the PATH is refused
// (`git_shim_refused`). What git prints on stderr is never shown: a failure is a code.
import { spawn as nodeSpawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { GitError, type GitFailure, type RefReader } from './checkout'

export const REF_PATTERN = /^[A-Za-z0-9/._-]{1,200}$/
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000

/** Whether a ref may be handed to git: see `REF_PATTERN`, and no leading `-`, no `..`, no `@{`. */
export function validRef(ref: string): boolean {
  return REF_PATTERN.test(ref) && !ref.startsWith('-') && !ref.includes('..') && !ref.includes('@{') && !ref.startsWith('/') && !ref.endsWith('/')
}

/** Whether a path may be handed to git: relative, inside the repository, no leading `-`, no `..`. `''` is the whole tree. */
export function validGitPath(path: string): boolean {
  if (path === '') return true
  if (path.length > 1024 || path.startsWith('-') || path.startsWith('/') || path.includes('\\') || path.includes(':')) return false
  if (/[\u0000-\u001f\u007f]/.test(path)) return false
  return path.split('/').every((part) => part !== '..' && part !== '' && !part.startsWith('-'))
}

/** What the child is started with: never a shell, never verbatim arguments, nothing read from stdin. */
export type GitSpawnOptions = {
  cwd: string
  env: Record<string, string>
  shell: false
  windowsVerbatimArguments: false
  windowsHide: true
  stdio: ['ignore', 'pipe', 'pipe']
}

/** The part of a Node ChildProcess this module uses; tests pass a fake. */
export type GitChild = {
  readonly stdout: { on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown } | null
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(): boolean
}

export type GitSpawner = (file: string, args: readonly string[], options: GitSpawnOptions) => GitChild

export type GitDeps = {
  spawn?: GitSpawner
  platform?: string
  /** The worker's environment; default `process.env`. */
  env?: Record<string, string | undefined>
  isFile?: (path: string) => Promise<boolean>
  timeoutMs?: number
  maxBytes?: number
}

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function valueOf(env: Record<string, string | undefined>, wanted: string): string | undefined {
  const key = Object.keys(env).find((name) => name.toUpperCase() === wanted)
  return key ? env[key] : undefined
}

/** The git to start: the first on the PATH. On Windows only `git.exe`; a `.cmd` or `.bat` found first is refused. */
export async function findGit({ platform, env, isFile }: { platform: string; env: Record<string, string | undefined>; isFile: (path: string) => Promise<boolean> }): Promise<{ file: string } | { refused: GitFailure }> {
  const windows = platform === 'win32'
  const api = windows ? win32 : posix
  const dirs = (valueOf(env, 'PATH') || '').split(windows ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    if (!windows) {
      const candidate = api.join(dir, 'git')
      if (await isFile(candidate)) return { file: candidate }
      continue
    }
    if (await isFile(api.join(dir, 'git.exe'))) return { file: api.join(dir, 'git.exe') }
    // A shim would need cmd.exe, which reads characters of the arguments itself.
    for (const shim of ['git.cmd', 'git.bat']) if (await isFile(api.join(dir, shim))) return { refused: 'git_shim_refused' }
  }
  return { refused: 'git_not_found' }
}

/**
 * The child's environment: the worker's own, with git told to take no optional lock, never to
 * prompt, and never to fetch an object a partial clone lacks (which would write to `.git`).
 */
export function gitEnvironment(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (typeof value === 'string') env[key] = value
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_NO_LAZY_FETCH = '1'
  return env
}

/** A line of `ls-tree` output: git quotes a name holding unusual bytes as a C string. */
export function unquoteGitPath(line: string): string {
  if (!line.startsWith('"') || !line.endsWith('"') || line.length < 2) return line
  const bytes: number[] = []
  const body = line.slice(1, -1)
  const encoder = new TextEncoder()
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...encoder.encode(c))
      continue
    }
    const next = body[++i]
    if (next >= '0' && next <= '7') {
      const octal = body.slice(i, i + 3)
      bytes.push(parseInt(octal, 8) & 0xff)
      i += 2
    } else {
      const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34 }
      bytes.push(escapes[next] ?? next.charCodeAt(0))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

type GitRun = { code: number | null; stdout: string }

export function createGitReader(root: string, deps: GitDeps = {}): RefReader {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const isFile = deps.isFile ?? defaultIsFile
  const spawn: GitSpawner = deps.spawn ?? ((file, args, options) => nodeSpawn(file, args, options) as unknown as GitChild)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? MAX_OUTPUT_BYTES

  async function run(args: string[]): Promise<GitRun> {
    const git = await findGit({ platform, env, isFile })
    if ('refused' in git) throw new GitError(git.refused)
    let child: GitChild
    try {
      child = spawn(git.file, args, { cwd: root, env: gitEnvironment(env), shell: false, windowsVerbatimArguments: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      throw new GitError('git_failed')
    }
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = []
      let size = 0
      let settled = false
      const finish = (outcome: { run: GitRun } | { failure: GitFailure }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if ('run' in outcome) resolve(outcome.run)
        else reject(new GitError(outcome.failure))
      }
      const timer = setTimeout(() => {
        child.kill()
        finish({ failure: 'git_timeout' })
      }, timeoutMs)
      child.stdout?.on('data', (chunk) => {
        const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
        size += bytes.length
        if (size > maxBytes) {
          child.kill()
          finish({ failure: 'git_output_too_large' })
          return
        }
        chunks.push(bytes)
      })
      // Read so the child never blocks on a full pipe; never kept, never shown.
      child.stderr?.on('data', () => {})
      child.on('error', () => finish({ failure: 'git_failed' }))
      child.on('close', (code) => {
        const all = new Uint8Array(size)
        let at = 0
        for (const chunk of chunks) {
          all.set(chunk, at)
          at += chunk.length
        }
        finish({ run: { code, stdout: new TextDecoder().decode(all) } })
      })
    })
  }

  function checkRef(ref: string): void {
    if (!validRef(ref)) throw new GitError('ref_invalid')
  }
  function checkPath(path: string): void {
    if (!validGitPath(path)) throw new GitError('path_invalid')
  }

  async function list(ref: string, path: string): Promise<string[]> {
    checkRef(ref)
    checkPath(path)
    const result = await run(['ls-tree', '--full-tree', '-r', '--name-only', ref, '--', path === '' ? '.' : path])
    if (result.code !== 0) throw new GitError('git_failed')
    return result.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0)
      .map(unquoteGitPath)
  }

  return {
    async commit(ref) {
      checkRef(ref)
      const result = await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      if (result.code === 0) {
        const commit = result.stdout.trim()
        return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null
      }
      if (result.code === 1) return null
      throw new GitError('git_failed')
    },
    list,
    async read(ref, path) {
      checkRef(ref)
      checkPath(path)
      if (path === '') throw new GitError('path_invalid')
      const result = await run(['show', `${ref}:${path}`])
      if (result.code === 0) return result.stdout
      // Not there at that commit: null, as the contract says. Anything else is a failure.
      if (!(await list(ref, path)).includes(path)) return null
      throw new GitError('git_failed')
    }
  }
}
