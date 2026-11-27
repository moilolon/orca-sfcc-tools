// The file system the checkout index reads, as its caller gives it: the worker gives the real disk
// (`disk.ts`), the tests an invented checkout in memory (`memory.ts`), and a git ref is read
// through the same shape. Paths are relative to the checkout's root, `/` between their parts,
// `''` for the root itself; no path given here or answered leaves the root.
// Pure: no Node, no Orca.

export type EntryKind = 'file' | 'folder'

export type DirEntry = { name: string; kind: EntryKind }

export interface CheckoutFiles {
  /** The entries of a folder; null when it is not a folder (missing, or a file). */
  list(dir: string): Promise<DirEntry[] | null>
  /** A file's text; null when it is not a file. */
  read(path: string): Promise<string | null>
  /** A file's modification time in milliseconds; null when it is not a file. */
  time(path: string): Promise<number | null>
}

/** Folders never read: tools' own state and installed packages. Any folder whose name starts with a dot is skipped too. */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules', 'bower_components'])

/** How deep the walk goes below the root, and how many files it keeps: bounds, not assumptions about a layout. */
export const MAX_WALK_DEPTH = 24
export const MAX_FILES = 250_000

/** Whether a folder of that name is skipped by the walk. */
export function skippedFolder(name: string): boolean {
  return name.startsWith('.') || SKIPPED_FOLDERS.has(name)
}

/**
 * Whether a changed path lies in a skipped folder, or is one: what the watcher reports there is
 * ignored. A file whose own name starts with a dot (`.project`) is not skipped.
 */
export function skippedPath(path: string): boolean {
  const parts = path.split('/')
  for (let i = 0; i < parts.length - 1; i++) if (skippedFolder(parts[i])) return true
  const last = parts[parts.length - 1]
  return SKIPPED_FOLDERS.has(last) || last === '.git'
}

/**
 * A relative path made plain: `\` read as `/`, `.` and empty parts dropped, `..` applied. Null
 * when it leaves the root or is absolute.
 */
export function normalizePath(path: string): string | null {
  const text = path.replace(/\\/g, '/')
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return null
  const out: string[] = []
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

export function joinPath(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('/')
}

export function dirname(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The extension, dot included, in lower case; `''` when there is none. */
export function extname(path: string): string {
  const name = basename(path)
  const at = name.lastIndexOf('.')
  return at <= 0 ? '' : name.slice(at).toLowerCase()
}

/** Whether `path` is `folder` or lies below it. */
export function isUnder(path: string, folder: string): boolean {
  return folder === '' || path === folder || path.startsWith(folder + '/')
}

/**
 * Every file below `dir`, sorted, skipping the folders `skippedFolder` names, at most `MAX_FILES`
 * of them and `MAX_WALK_DEPTH` levels down. `truncated` says a bound was reached.
 */
export async function walkFiles(files: CheckoutFiles, dir = ''): Promise<{ files: string[]; truncated: boolean }> {
  const found: string[] = []
  let truncated = false
  const stack: { dir: string; depth: number }[] = [{ dir, depth: 0 }]
  while (stack.length > 0) {
    const { dir: current, depth } = stack.pop() as { dir: string; depth: number }
    const entries = await files.list(current)
    if (!entries) continue
    for (const entry of entries) {
      const path = joinPath(current, entry.name)
      if (entry.kind === 'folder') {
        if (skippedFolder(entry.name)) continue
        if (depth + 1 > MAX_WALK_DEPTH) {
          truncated = true
          continue
        }
        stack.push({ dir: path, depth: depth + 1 })
      } else if (found.length < MAX_FILES) {
        found.push(path)
      } else {
        truncated = true
      }
    }
  }
  found.sort()
  return { files: found, truncated }
}

/** The offsets where each line of `text` starts; CR, LF and CRLF all end a line. */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10) starts.push(i + 1)
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++
      starts.push(i + 1)
    }
  }
  return starts
}

/** The 1-based line of an offset, given the line starts of its text. */
export function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low + 1
}

/** Runs `task` over `items`, at most `limit` at a time, in order of the items. */
export async function eachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners: Promise<void>[] = []
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(
      (async () => {
        while (next < items.length) {
          const item = items[next++]
          await task(item)
        }
      })()
    )
  }
  await Promise.all(runners)
}
