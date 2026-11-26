// The single store of breakpoints: by workspace, by file and by line. The debugger's view reads and
// writes it now; the editor (phase 7.3) will read and write the same store, so nothing else keeps
// a list of breakpoints of its own.
//
// Paths are relative to the workspace's folder, with `/` between their parts, so a breakpoint
// survives the workspace being moved and never stores where the person's files live. Kept in the
// piece's own storage under one key; whether the adapter accepted a line (`verified`) belongs to a
// session and is kept by it, not here.
import type { JsonValue } from 'orca'
import type { Disposable } from '../../core/piece'
import type { Store } from '../../core/store'

export type BreakpointFile = { path: string; lines: number[] }

/** Lines past this in one file, or files past this in one workspace, are not kept. */
export const MAX_LINES_PER_FILE = 100
export const MAX_FILES = 200
const MAX_LINE = 1_000_000

const KEY = 'breakpoints'

type Stored = Record<string, Record<string, number[]>>

/**
 * A path as the store keeps it: relative, `/` between its parts, no empty part, no `.` or `..`,
 * no drive or root, no control character. Null for anything else.
 */
export function normalizePath(path: unknown): string | null {
  if (typeof path !== 'string') return null
  const slashed = path.replace(/\\/g, '/')
  if (!slashed || slashed.startsWith('/') || /^[a-z]:/i.test(slashed) || /[\u0000-\u001f]/.test(slashed)) return null
  const parts = slashed.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts.join('/')
}

/** Whole lines from 1, once each, in order; at most `MAX_LINES_PER_FILE`. */
export function normalizeLines(lines: unknown): number[] {
  if (!Array.isArray(lines)) return []
  const kept = new Set<number>()
  for (const line of lines) {
    if (typeof line === 'number' && Number.isInteger(line) && line >= 1 && line <= MAX_LINE) kept.add(line)
  }
  return [...kept].sort((a, b) => a - b).slice(0, MAX_LINES_PER_FILE)
}

export type BreakpointsChange = { workspaceId: string }

export type Breakpoints = {
  /** A workspace's breakpoints, by path. */
  list(workspaceId: string): Promise<BreakpointFile[]>
  /**
   * Sets every line of one file: an empty list removes the file. Answers the workspace's list as
   * it is now. Throws `invalid_path` for a path the store does not keep, and `too_many_files` past
   * `MAX_FILES`.
   */
  set(workspaceId: string, path: string, lines: readonly number[]): Promise<BreakpointFile[]>
  /** Removes every breakpoint of a workspace. */
  clear(workspaceId: string): Promise<void>
  onChange(listener: (change: BreakpointsChange) => void): Disposable
}

export class BreakpointsError extends Error {
  constructor(readonly code: 'invalid_path' | 'too_many_files') {
    super(code)
  }
}

/** What is stored, read back defensively: a hand-edited or older value never throws. */
function sanitize(value: unknown): Stored {
  const result: Stored = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [workspaceId, files] of Object.entries(value as Record<string, unknown>)) {
    if (!files || typeof files !== 'object' || Array.isArray(files)) continue
    const kept: Record<string, number[]> = {}
    for (const [path, lines] of Object.entries(files as Record<string, unknown>)) {
      const normal = normalizePath(path)
      const normalLines = normalizeLines(lines)
      if (normal && normalLines.length > 0) kept[normal] = normalLines
    }
    if (Object.keys(kept).length > 0) result[workspaceId] = kept
  }
  return result
}

function listOf(files: Record<string, number[]> | undefined): BreakpointFile[] {
  return Object.entries(files ?? {})
    .map(([path, lines]) => ({ path, lines: [...lines] }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function createBreakpoints(store: Store): Breakpoints {
  const listeners = new Set<(change: BreakpointsChange) => void>()
  // Writes run one after another, so two quick changes never overwrite each other.
  let queue: Promise<unknown> = Promise.resolve()

  async function read(): Promise<Stored> {
    return sanitize(await store.get<JsonValue>(KEY, {}))
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => {})
    return next
  }

  function notify(workspaceId: string): void {
    for (const listener of listeners) {
      try {
        listener({ workspaceId })
      } catch {
        // One listener failing must not keep the others from hearing it.
      }
    }
  }

  return {
    async list(workspaceId) {
      await queue
      return listOf((await read())[workspaceId])
    },
    set(workspaceId, path, lines) {
      return serial(async () => {
        const normal = normalizePath(path)
        if (!normal) throw new BreakpointsError('invalid_path')
        const all = await read()
        const files = { ...(all[workspaceId] ?? {}) }
        const kept = normalizeLines(lines)
        if (kept.length === 0) delete files[normal]
        else {
          if (!(normal in files) && Object.keys(files).length >= MAX_FILES) throw new BreakpointsError('too_many_files')
          files[normal] = kept
        }
        if (Object.keys(files).length === 0) delete all[workspaceId]
        else all[workspaceId] = files
        await store.set(KEY, all)
        notify(workspaceId)
        return listOf(files)
      })
    },
    clear(workspaceId) {
      return serial(async () => {
        const all = await read()
        if (!(workspaceId in all)) return
        delete all[workspaceId]
        await store.set(KEY, all)
        notify(workspaceId)
      })
    },
    onChange(listener) {
      listeners.add(listener)
      return { dispose: () => void listeners.delete(listener) }
    }
  }
}
