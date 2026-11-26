// The script files a breakpoint can go in: every `.js` and `.ds` file inside a cartridge of the
// workspace, a cartridge being any folder that holds a `.project` file, as `b2c debug` finds them.
// Paths are relative to the workspace, with `/`. Read from the local folder only.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Folders never looked into, as b2c skips them too, plus version control and editor state. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.svn', '.hg', '.orca', '.claude', '.idea', '.vscode', 'bower_components'])
const SCRIPT = /\.(js|ds)$/i
const MAX_FILES = 5_000
const MAX_DEPTH = 12
/** How many matches one search answers. */
export const MAX_MATCHES = 50

type Entry = { name: string; isDirectory(): boolean; isFile(): boolean }
export type ReadDir = (path: string) => Promise<Entry[]>

const defaultReadDir: ReadDir = (path) => readdir(path, { withFileTypes: true })

/** Every script file of the workspace's cartridges, relative to `root`; `truncated` past MAX_FILES. */
export async function scriptFiles(root: string, readDir: ReadDir = defaultReadDir): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let truncated = false

  async function entries(path: string): Promise<Entry[]> {
    try {
      return await readDir(path)
    } catch {
      return []
    }
  }

  /** Walks `dir` (relative parts in `parts`); `inCartridge` once a `.project` was seen above. */
  async function walk(dir: string, parts: string[], inCartridge: boolean): Promise<void> {
    if (truncated || parts.length > MAX_DEPTH) return
    const list = await entries(dir)
    const cartridge = inCartridge || list.some((entry) => entry.isFile() && entry.name === '.project')
    for (const entry of list.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated) return
      if (entry.isDirectory()) {
        if (SKIPPED.has(entry.name)) continue
        await walk(join(dir, entry.name), [...parts, entry.name], cartridge)
      } else if (cartridge && entry.isFile() && SCRIPT.test(entry.name)) {
        if (files.length >= MAX_FILES) {
          truncated = true
          return
        }
        files.push([...parts, entry.name].join('/'))
      }
    }
  }

  await walk(root, [], false)
  return { files, truncated }
}

/**
 * The files whose path holds every word of `query`, ignoring case; the shortest paths first, at
 * most MAX_MATCHES. An empty query matches nothing: there are too many files to list.
 */
export function matchFiles(files: readonly string[], query: string): { files: string[]; truncated: boolean } {
  const words = query.toLowerCase().split(/[\s]+/).filter(Boolean)
  if (words.length === 0) return { files: [], truncated: false }
  const matches = files.filter((file) => {
    const lower = file.toLowerCase()
    return words.every((word) => lower.includes(word))
  })
  // The file's own name matching first, then the shorter path.
  const name = (file: string) => file.slice(file.lastIndexOf('/') + 1).toLowerCase()
  matches.sort((a, b) => Number(words.every((w) => name(b).includes(w))) - Number(words.every((w) => name(a).includes(w))) || a.length - b.length || (a < b ? -1 : 1))
  return { files: matches.slice(0, MAX_MATCHES), truncated: matches.length > MAX_MATCHES }
}
