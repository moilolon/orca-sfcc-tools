// The plugin's own data folder, shared by every copy of the plugin and by the command line of
// bin/errors.ts: the seen list (`seen.json`, written by the worker only) and the command line's
// report cursor (`report.json`, written by the command line only). Orca's own storage cannot be
// shared with a process outside Orca: it is rewritten whole with no lock, so an outside writer
// loses updates and a half write wipes it (spike S8).
//
// A file here is a JSON object `{ version: 1, roles: { <role>: … } }`, read by anyone and written
// only through `updateDataFile`:
//   1. the lock `<file>.lock` is taken with an exclusive create (`wx`, O_EXCL), retried with
//      jitter for up to `LOCK_TIMEOUT_MS`. A lock older than `STALE_LOCK_MS` was left by a process
//      that died holding it, and is taken over atomically: under a second lock,
//      `<file>.lock.break` (also `wx`), the lock is checked again to be the same stale one,
//      renamed to a name of this writer's own, checked once more and only then removed; whoever
//      did not get the second lock retries. So a writer that saw a lock stale a moment ago can
//      never remove the fresh lock another writer took over it meanwhile;
//   2. the file is read again under the lock;
//   3. the new text is written to `<file>.<pid>.<random>.tmp` (owner-only), flushed to disk, then
//      renamed over the file, so a reader sees the old file or the new one, never half of one, and
//      a writer cut off halfway leaves only its temporary file behind;
//   4. the lock is removed, only if it is still this writer's. Temporary files a writer killed
//      between its write and its rename left behind are swept, once they are old.
// On Windows a rename over a file another process has open, and a read of a file being renamed,
// can fail for a moment (EPERM, EBUSY, EACCES): both are retried.
//
// Imports explicit `.ts` files only: the command line loads it under plain Node.
import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'

/** Overrides the data folder: for tests, never set by the plugin. */
export const DATA_FOLDER_ENV = 'ORCA_SFCC_TOOLS_DATA'
export const APP_FOLDER = 'orca-sfcc-tools'
export const SEEN_FILE = 'seen.json'
export const REPORT_FILE = 'report.json'
export const DATA_VERSION = 1

/** How long a writer waits for the lock before it gives up (`lock_timeout`). */
export const LOCK_TIMEOUT_MS = 10_000
/** A lock older than this was left by a process that died holding it. A write holds it for milliseconds. */
export const STALE_LOCK_MS = 30_000

/**
 * Whether this process runs under a test runner: Node's (`node --test` and `orca plugin test`
 * set `NODE_TEST_CONTEXT` in each test process) or vitest.
 */
export function underTestRunner(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_TEST_CONTEXT !== undefined || env.VITEST !== undefined
}

/**
 * The data folder, from the home folder only: the worker runs with a trimmed environment (no
 * `APPDATA`, maybe no `XDG_DATA_HOME`), and the worker and the command line must agree on it.
 * Windows `%APPDATA%\orca-sfcc-tools` as it is by default (`~\AppData\Roaming`), macOS
 * `~/Library/Application Support/orca-sfcc-tools`, Linux `~/.local/share/orca-sfcc-tools` (the
 * default `$XDG_DATA_HOME`). `ORCA_SFCC_TOOLS_DATA`, when set to an absolute folder, replaces it.
 *
 * Under a test runner the person's own folder is refused (`data_folder_in_test`) unless the
 * override is set: no test may read or write the real seen list, even by accident. `testing`
 * says whether that holds; by default, whether this process runs under one.
 */
export function dataFolder({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  testing = underTestRunner()
}: { platform?: string; home?: string; env?: Record<string, string | undefined>; testing?: boolean } = {}): string {
  const path = platform === 'win32' ? win32 : posix
  const override = env[DATA_FOLDER_ENV]
  if (override && path.isAbsolute(override)) return override
  if (testing) throw new DataFileError('data_folder_in_test')
  if (platform === 'win32') return win32.join(home, 'AppData', 'Roaming', APP_FOLDER)
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', APP_FOLDER)
  return posix.join(home, '.local', 'share', APP_FOLDER)
}

/** A data file's content: its version and one value per role. */
export type DataFile<T> = { version: typeof DATA_VERSION; roles: Record<string, T> }

/** Why a data file could not be used. Its message is the code and nothing else: never a path. */
export class DataFileError extends Error {
  readonly code: 'data_file_invalid' | 'data_file_version' | 'lock_timeout' | 'data_file_failed' | 'data_folder_in_test'
  constructor(code: DataFileError['code']) {
    super(code)
    this.name = 'DataFileError'
    this.code = code
  }
}

/** The file system calls a data file needs; tests replace one to cut a write off halfway. */
export type DataIo = {
  readText(path: string): Promise<string>
  /** Creates `path` only if it does not exist (O_EXCL), holding `text`. */
  createExclusive(path: string, text: string): Promise<void>
  /** Writes `text` to a new `path`, owner-only, and flushes it to disk. */
  writeTemp(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  modifiedAt(path: string): Promise<number>
  mkdir(path: string): Promise<void>
  /** Gives `from` a second name `to`, failing (EEXIST) when that name is taken: never replaces a file. */
  linkExclusive(from: string, to: string): Promise<void>
  /** The names in a folder. */
  list(path: string): Promise<string[]>
}

export const NODE_IO: DataIo = {
  readText: (path) => readFile(path, 'utf8'),
  async createExclusive(path, text) {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(text)
    } finally {
      await handle.close()
    }
  },
  async writeTemp(path, text) {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  modifiedAt: async (path) => (await stat(path)).mtimeMs,
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  linkExclusive: (from, to) => link(from, to),
  list: (path) => readdir(path)
}

export type DataFileOptions = { io?: DataIo; now?: () => number; lockTimeoutMs?: number; staleLockMs?: number }

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])
const codeOf = (error: unknown) => (error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `work`, again after a short pause while it fails for a moment: on Windows a rename over a
 * file another process is reading fails until that read ends. Up to about three seconds.
 */
async function retrying<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      if (attempt >= 60 || !TRANSIENT.has(codeOf(error) as string)) throw error
      await pause(Math.min(5 + attempt * 2, 60) + Math.random() * 5)
    }
  }
}

/** A parsed data file; throws on one that is not a data file of this version, never reads it as empty. */
function parse<T>(text: string): DataFile<T> {
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new DataFileError('data_file_invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DataFileError('data_file_invalid')
  const { version, roles } = value as { version?: unknown; roles?: unknown }
  if (version !== DATA_VERSION) throw new DataFileError(typeof version === 'number' ? 'data_file_version' : 'data_file_invalid')
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new DataFileError('data_file_invalid')
  return { version: DATA_VERSION, roles: roles as Record<string, T> }
}

/** The file's content, or null when it does not exist. Throws a DataFileError on any other failure. */
export async function readDataFile<T>(path: string, { io = NODE_IO }: DataFileOptions = {}): Promise<DataFile<T> | null> {
  let text: string
  try {
    text = await retrying(() => io.readText(path))
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null
    throw new DataFileError('data_file_failed')
  }
  return parse<T>(text)
}

/** The lock's token and when it last changed, or null when there is none. */
async function lockState(lockPath: string, io: DataIo): Promise<{ token: string; modified: number } | null> {
  try {
    const modified = await io.modifiedAt(lockPath)
    const token = await io.readText(lockPath)
    return { token, modified }
  } catch {
    return null
  }
}

/**
 * Removes the lock `seen` names, if it is still that same stale lock: under the breaker lock, so
 * two writers never take over at once, and by renaming it to a name of this writer's own first,
 * so what is removed is exactly what was checked. A lock moved by mistake is put back.
 */
async function takeOver(lockPath: string, seen: { token: string }, io: DataIo, now: () => number, staleMs: number, token: string): Promise<void> {
  const breaker = `${lockPath}.break`
  try {
    await io.createExclusive(breaker, token)
  } catch (error) {
    // Another writer is taking it over, or died doing so long ago.
    if (codeOf(error) !== 'EEXIST') return
    const modified = await io.modifiedAt(breaker).catch(() => null)
    if (modified !== null && now() - modified > staleMs) await io.unlink(breaker).catch(() => undefined)
    return
  }
  try {
    const current = await lockState(lockPath, io)
    // Released, or taken by a live writer since it was seen: nothing to take over.
    if (!current || current.token !== seen.token || now() - current.modified <= staleMs) return
    const moved = `${lockPath}.${token}.stale`
    try {
      await io.rename(lockPath, moved)
    } catch {
      return
    }
    const taken = await io.readText(moved).catch(() => null)
    // Not the lock that was checked: give it back, unless its place is taken again.
    if (taken !== seen.token) await io.linkExclusive(moved, lockPath).catch(() => undefined)
    await io.unlink(moved).catch(() => undefined)
  } finally {
    const held = await io.readText(breaker).catch(() => null)
    if (held === token) await io.unlink(breaker).catch(() => undefined)
  }
}

/** Takes the lock of `path`; answers its token, which releasing checks. */
async function lock(path: string, io: DataIo, now: () => number, timeoutMs: number, staleMs: number): Promise<string> {
  const lockPath = `${path}.lock`
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`
  const deadline = now() + timeoutMs
  for (let attempt = 0; ; attempt++) {
    try {
      await io.createExclusive(lockPath, token)
      return token
    } catch (error) {
      if (codeOf(error) === 'ENOENT' && attempt < 3) {
        // The folder is not there yet.
        await io.mkdir(dirname(path)).catch(() => undefined)
        continue
      }
      if (codeOf(error) !== 'EEXIST' && !TRANSIENT.has(codeOf(error) as string)) throw new DataFileError('data_file_failed')
    }
    // Held. A lock that has not changed for `staleMs` belongs to a process that died holding it.
    const held = await lockState(lockPath, io)
    if (held !== null && now() - held.modified > staleMs) await takeOver(lockPath, held, io, now, staleMs, token)
    if (now() >= deadline) throw new DataFileError('lock_timeout')
    // Short and jittered, so a waiting writer is not starved by one that keeps writing.
    await pause(1 + Math.random() * Math.min(20, 2 + attempt))
  }
}

/**
 * Removes the temporary files of `path` that a writer killed between its write and its rename
 * left behind, once older than `staleMs`. Runs under the lock; never fails the write.
 */
async function sweepTemps(path: string, io: DataIo, now: () => number, staleMs: number): Promise<void> {
  const folder = dirname(path)
  const prefix = `${path.slice(folder.length + 1)}.`
  const names = await io.list(folder).catch(() => [] as string[])
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
    const temp = join(folder, name)
    const modified = await io.modifiedAt(temp).catch(() => null)
    if (modified !== null && now() - modified > staleMs) await io.unlink(temp).catch(() => undefined)
  }
}

/** Removes the lock, only while it is still this writer's (a stale-lock rule may have handed it on). */
async function unlock(path: string, token: string, io: DataIo): Promise<void> {
  const lockPath = `${path}.lock`
  const held = await io.readText(lockPath).catch(() => null)
  if (held === token) await io.unlink(lockPath).catch(() => undefined)
}

/**
 * Changes the file under its lock: `change` gets its content (null when it does not exist) and
 * answers the new one, or undefined to leave it as it is. The new text is written whole to a
 * temporary file and renamed over the old one. Answers the content kept.
 */
export async function updateDataFile<T>(
  path: string,
  change: (current: DataFile<T> | null) => DataFile<T> | undefined,
  { io = NODE_IO, now = Date.now, lockTimeoutMs = LOCK_TIMEOUT_MS, staleLockMs = STALE_LOCK_MS }: DataFileOptions = {}
): Promise<DataFile<T> | null> {
  const token = await lock(path, io, now, lockTimeoutMs, staleLockMs)
  try {
    const current = await readDataFile<T>(path, { io })
    const next = change(current)
    if (next === undefined) return current
    const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await io.writeTemp(temp, `${JSON.stringify({ version: DATA_VERSION, roles: next.roles }, null, 2)}\n`)
      await retrying(() => io.rename(temp, path))
    } catch (error) {
      await io.unlink(temp).catch(() => undefined)
      throw error instanceof DataFileError ? error : new DataFileError('data_file_failed')
    }
    await sweepTemps(path, io, now, staleLockMs)
    return next
  } finally {
    await unlock(path, token, io)
  }
}

/** `seen.json` and `report.json` in the data folder. */
export function dataFiles(folder: string = dataFolder()): { seen: string; report: string } {
  return { seen: join(folder, SEEN_FILE), report: join(folder, REPORT_FILE) }
}

/** The key prefix of the seen list's store (`listKey` of seen.ts): `seen.<role>`. */
const SEEN_KEY = /^seen\.([a-z]+)$/

function roleOfKey(key: string): string {
  const match = SEEN_KEY.exec(key)
  if (!match) throw new DataFileError('data_file_failed')
  return match[1]
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * What a write finds in place of a `seen.json` that does not exist yet: the lists an older version
 * kept elsewhere (the worker's storage), or null. Asked before each write, outside the lock;
 * `seeded` is told when a write did create the file from them.
 */
export type SeenSeed = { roles(): Promise<Record<string, Json> | null>; seeded?(): Promise<void> }

/**
 * The seen list's store over `seen.json`: each role's table is one value of `roles`. A read of a
 * file that is missing gives the fallback; one that is not a seen list of this version throws and
 * is never overwritten. Every change goes through `updateDataFile`, under the lock. A write that
 * finds no file starts from `seed`, so lists kept elsewhere are never lost to the first write.
 */
export function createSeenFileStore(path: string, options: DataFileOptions & { seed?: SeenSeed } = {}) {
  async function write(role: string, change: (current: Json | null) => Json | undefined): Promise<void> {
    const seed = options.seed ? await options.seed.roles() : null
    let seeded = false
    await updateDataFile<Json>(
      path,
      (found) => {
        let current = found
        if (current === null && seed && Object.keys(seed).length > 0) {
          current = { version: DATA_VERSION, roles: { ...seed } }
          seeded = true
        }
        const next = change(current?.roles[role] ?? null)
        if (next === undefined) return seeded && current ? current : undefined
        return { version: DATA_VERSION, roles: { ...(current?.roles ?? {}), [role]: next } }
      },
      options
    )
    if (seeded) await options.seed?.seeded?.()
  }
  return {
    async get<T extends Json>(key: string, fallback: T): Promise<T> {
      const file = await readDataFile<Json>(path, options)
      const value = file?.roles[roleOfKey(key)]
      return value === undefined || value === null ? fallback : (value as T)
    },
    set: (key: string, value: Json) => write(roleOfKey(key), () => value),
    update: (key: string, change: (current: Json | null) => Json | undefined) => write(roleOfKey(key), change)
  }
}
