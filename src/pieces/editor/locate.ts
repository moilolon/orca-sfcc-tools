// Which file an editor shows (spike S3). The frame knows the text and its workspace, never the
// path. Here, two sources, in order:
//   (a) a file the plugin itself opened in its editor (src/core/open-file.ts records it, with the
//       line to show) in the last `OPEN_WINDOW_MS`, when that file holds this text now: given to
//       the first editor that asks and then forgotten, so a copy opened later is never taken for it;
//   (b) the workspace's `.isml`, `.js`, `.xml` and `.properties` files whose text hashes the same:
//       an index of every one, built in the background and refreshed by file time.
// Several files with one text: the candidates, unless the person chose one for this workspace and
// text before. A save names a file only for the editor that saved it: the frame knows it was the
// one flushed before the save (locate-client.ts), so a save never names any other editor with
// the same text. Hashes are SHA-256 of the text as Orca decodes it (a BOM kept as U+FEFF, every
// line break as written), as UTF-8, in hex.
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { EDITOR_OPENS, isInside, type EditorOpen, type EditorOpens } from '../../core/open-file'
import type { Store } from '../../core/store'
import type { EditorLocated } from './protocol'

/** The file types indexed: those the editor opens. */
export const INDEXED = /\.(isml|js|xml|properties)$/i
/** Folders never walked. */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules', 'bower_components'])
/** How deep the walk goes, and how many files it takes at most. */
export const MAX_DEPTH = 24
export const MAX_FILES = 60_000
/** Larger files are not hashed (no editor works on them by name). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024
/** Candidates listed for identical files; the rest are counted. */
export const MAX_CANDIDATES = 20
/** Saves remembered per workspace, and choices kept per workspace. */
export const MAX_SAVES = 50
/** How long after the plugin opened a file the first editor holding its text is taken for it. */
export const OPEN_WINDOW_MS = 60_000
export const MAX_CHOICES = 200
/** An index younger than this answers a miss without being refreshed first. */
export const FRESH_MS = 2_000
/** Files of a folder read at once. */
const PARALLEL_READS = 16

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The filesystem calls the index makes; tests pass a folder in memory. */
export type IndexFs = {
  /** The entries of a folder: names and whether each is a folder (links are neither). */
  list(dir: string): Promise<{ name: string; folder: boolean; file: boolean }[]>
  /** A file's time and size; null when it is gone. */
  stat(file: string): Promise<{ mtimeMs: number; size: number } | null>
  read(file: string): Promise<string>
}

export const nodeFs: IndexFs = {
  async list(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, folder: entry.isDirectory(), file: entry.isFile() }))
  },
  async stat(file) {
    try {
      const info = await stat(file)
      return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null
    } catch {
      return null
    }
  },
  read: (file) => readFile(file, 'utf8')
}

type Entry = { mtimeMs: number; size: number; hash: string | null }

/** The hashes of one workspace's files, by relative path (`/` between parts). */
export class FileIndex {
  readonly files = new Map<string, Entry>()
  private readonly byHash = new Map<string, Set<string>>()
  builtAt = -Infinity
  private running: Promise<void> | null = null
  /** Files hashed by the last refresh, and how long it took: what the background costs. */
  lastRefresh = { files: 0, hashed: 0, ms: 0 }

  readonly root: string
  private readonly fs: IndexFs
  private readonly api: typeof posix | typeof win32
  private readonly now: () => number

  constructor(root: string, fs: IndexFs, api: typeof posix | typeof win32, now: () => number) {
    this.root = root
    this.fs = fs
    this.api = api
    this.now = now
  }

  /** Paths whose text hashes to `hash`, sorted. */
  lookup(hash: string): string[] {
    return [...(this.byHash.get(hash) ?? [])].sort()
  }

  private setHash(path: string, entry: Entry, hash: string | null): void {
    if (entry.hash) {
      const set = this.byHash.get(entry.hash)
      set?.delete(path)
      if (set && set.size === 0) this.byHash.delete(entry.hash)
    }
    entry.hash = hash
    if (hash) {
      let set = this.byHash.get(hash)
      if (!set) this.byHash.set(hash, (set = new Set()))
      set.add(path)
    }
  }

  /** One file read again now (after a save, or to check a recorded open). */
  async refreshFile(path: string): Promise<string | null> {
    const file = this.api.join(this.root, ...path.split('/'))
    const info = await this.fs.stat(file)
    const old = this.files.get(path)
    if (!info || info.size > MAX_FILE_BYTES) {
      if (old) {
        this.setHash(path, old, null)
        this.files.delete(path)
      }
      return null
    }
    if (old && old.mtimeMs === info.mtimeMs && old.size === info.size && old.hash) return old.hash
    let hash: string | null = null
    try {
      hash = hashText(await this.fs.read(file))
    } catch {
      hash = null
    }
    const entry = old ?? { mtimeMs: info.mtimeMs, size: info.size, hash: null }
    entry.mtimeMs = info.mtimeMs
    entry.size = info.size
    this.files.set(path, entry)
    this.setHash(path, entry, hash)
    return hash
  }

  /** Walks the workspace again: new files hashed, changed ones (by time or size) hashed again, gone ones dropped. One at a time. */
  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.walk().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private async walk(): Promise<void> {
    const started = this.now()
    const seen = new Set<string>()
    let hashed = 0
    const folders: { dir: string; rel: string; depth: number }[] = [{ dir: this.root, rel: '', depth: 0 }]
    while (folders.length > 0 && seen.size < MAX_FILES) {
      const { dir, rel, depth } = folders.pop() as { dir: string; rel: string; depth: number }
      let entries: Awaited<ReturnType<IndexFs['list']>>
      try {
        entries = await this.fs.list(dir)
      } catch {
        continue
      }
      const files: string[] = []
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const path = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.folder) {
          if (!SKIPPED_FOLDERS.has(entry.name) && depth < MAX_DEPTH) folders.push({ dir: this.api.join(dir, entry.name), rel: path, depth: depth + 1 })
        } else if (entry.file && INDEXED.test(entry.name) && seen.size < MAX_FILES) {
          seen.add(path)
          files.push(path)
        }
      }
      // A folder's files a few at a time: the disk works while the hashes are computed.
      for (let i = 0; i < files.length; i += PARALLEL_READS) {
        const batch = files.slice(i, i + PARALLEL_READS)
        const before = batch.map((path) => this.files.get(path)?.hash)
        const after = await Promise.all(batch.map((path) => this.refreshFile(path)))
        for (let k = 0; k < batch.length; k++) if (after[k] !== null && after[k] !== before[k]) hashed++
      }
    }
    for (const [path, entry] of [...this.files]) {
      if (!seen.has(path)) {
        this.setHash(path, entry, null)
        this.files.delete(path)
      }
    }
    this.builtAt = this.now()
    this.lastRefresh = { files: seen.size, hashed, ms: this.builtAt - started }
  }

  get fresh(): boolean {
    return this.now() - this.builtAt < FRESH_MS
  }
}

export type LocatorDeps = {
  fs?: IndexFs
  platform?: string
  now?: () => number
  opens?: EditorOpens
  /** Where the choices among identical files are kept (the piece's store). */
  store?: Store
}

const CHOICES_KEY = 'choices'

export class Locator {
  private readonly fs: IndexFs
  private readonly platform: string
  private readonly api: typeof posix | typeof win32
  private readonly now: () => number
  private readonly opens: EditorOpens
  private readonly store: Store | null
  private readonly indexes = new Map<string, FileIndex>()
  /** The files saved per workspace, newest last: only for the command that opens the last one. */
  private readonly saves = new Map<string, string[]>()

  constructor(deps: LocatorDeps = {}) {
    this.fs = deps.fs ?? nodeFs
    this.platform = deps.platform ?? process.platform
    this.api = this.platform === 'win32' ? win32 : posix
    this.now = deps.now ?? (() => Date.now())
    this.opens = deps.opens ?? EDITOR_OPENS
    this.store = deps.store ?? null
  }

  private key(root: string): string {
    const resolved = this.api.resolve(root)
    return this.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  /** The index of a workspace's folder, made on first use (empty until its first refresh). */
  index(root: string): FileIndex {
    const key = this.key(root)
    let index = this.indexes.get(key)
    if (!index) {
      index = new FileIndex(this.api.resolve(root), this.fs, this.api, this.now)
      this.indexes.set(key, index)
    }
    return index
  }

  /** Starts indexing a workspace without waiting: the first `locate` there finds it ready. */
  warm(root: string): void {
    void this.index(root).refresh()
  }

  /** The path of a file below `root`, relative and with `/`; null when it is not below it. */
  relative(root: string, file: string): string | null {
    const base = this.api.resolve(root)
    const full = this.api.resolve(base, file)
    if (!isInside(base, full, this.platform)) return null
    const rel = this.api.relative(base, full).split(this.api.sep).join('/')
    return rel === '' ? null : rel
  }

  /**
   * A save at `path` (relative to `root`): the relative path, or null outside the workspace. It
   * names no editor here (the editor that saved knows it was itself); it is kept for the command
   * and makes the index read the file again.
   */
  recordSave(root: string, path: string): string | null {
    const rel = this.relative(root, path)
    if (rel === null) return null
    const key = this.key(root)
    const list = (this.saves.get(key) ?? []).filter((saved) => saved !== rel)
    list.push(rel)
    if (list.length > MAX_SAVES) list.shift()
    this.saves.set(key, list)
    void this.index(root).refreshFile(rel).catch(() => {})
    return rel
  }

  /** The newest file saved in a workspace, relative; null when none was. */
  lastSaved(root: string, accept: (path: string) => boolean = () => true): string | null {
    const list = this.saves.get(this.key(root)) ?? []
    for (let i = list.length - 1; i >= 0; i--) if (accept(list[i])) return list[i]
    return null
  }

  /** Which file of the workspace at `root` holds the text with this hash. */
  async locate(root: string, workspaceId: string, hash: string): Promise<EditorLocated> {
    // (a) A file the plugin opened in its editor just now, newest first, when it holds this text.
    const index = this.index(root)
    for (const open of this.opens.under(this.api.resolve(root), this.platform)) {
      if (this.now() - open.at > OPEN_WINDOW_MS) continue
      const rel = this.relative(root, open.file)
      if (rel === null) continue
      if ((await index.refreshFile(rel)) !== hash) continue
      return this.taken(rel, open)
    }
    // (b) The workspace's files: refreshed by time on a miss, unless just refreshed.
    if (!index.fresh && index.lookup(hash).length === 0) await index.refresh()
    const found = index.lookup(hash)
    if (found.length === 0) return null
    if (found.length === 1) return { path: found[0] }
    const chosen = await this.choice(workspaceId, hash)
    if (chosen && found.includes(chosen)) return { path: chosen }
    return { candidates: found.slice(0, MAX_CANDIDATES), more: Math.max(0, found.length - MAX_CANDIDATES) }
  }

  /** A recorded open, given to the editor that asked and forgotten: never handed to a second one. */
  private taken(path: string, open: EditorOpen): EditorLocated {
    const answer: { path: string; line?: number; column?: number } = { path }
    if (open.line !== undefined) {
      answer.line = open.line
      if (open.column !== undefined) answer.column = open.column
    }
    this.opens.forget(open)
    return answer
  }

  /** The person's choice among identical files: kept only when that file holds this text. */
  async choose(root: string, workspaceId: string, hash: string, path: string): Promise<boolean> {
    const rel = this.relative(root, path)
    if (rel === null || (await this.index(root).refreshFile(rel)) !== hash) return false
    if (!this.store) return true
    const all = await this.store.get<Record<string, Record<string, string>>>(CHOICES_KEY, {})
    const mine = { ...(all[workspaceId] ?? {}) }
    delete mine[hash]
    mine[hash] = rel
    const keys = Object.keys(mine)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CHOICES))) delete mine[old]
    await this.store.set(CHOICES_KEY, { ...all, [workspaceId]: mine })
    return true
  }

  private async choice(workspaceId: string, hash: string): Promise<string | null> {
    if (!this.store) return null
    const all = await this.store.get<Record<string, Record<string, string>>>(CHOICES_KEY, {})
    const path = all[workspaceId]?.[hash]
    return typeof path === 'string' ? path : null
  }
}
