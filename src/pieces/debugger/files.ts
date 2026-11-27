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

type Entry = { name: string; isDirectory(): boolean; isFile(): boolean }
export type ReadDir = (path: string) => Promise<Entry[]>

const defaultReadDir: ReadDir = (path) => readdir(path, { withFileTypes: true })

/**
 * Every script file of the workspace's cartridges, relative to `root`; `truncated` past MAX_FILES.
 * `cartridges` are the folders, relative to `root` (`''` for the root itself), holding the
 * `.project` file that makes a cartridge, outermost only, in the order they were found.
 */
export async function scriptFiles(root: string, readDir: ReadDir = defaultReadDir): Promise<{ files: string[]; truncated: boolean; cartridges: string[] }> {
  const files: string[] = []
  const cartridges: string[] = []
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
    if (cartridge && !inCartridge) cartridges.push(parts.join('/'))
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
  return { files, truncated, cartridges }
}

/** The script files grouped by the cartridge that holds them; a cartridge with none is left out. */
export function byCartridge(files: readonly string[], cartridges: readonly string[]): { path: string; files: string[] }[] {
  // The longest cartridge path that holds a file wins, so a cartridge's files are only its own.
  const roots = [...cartridges].sort((a, b) => b.length - a.length)
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const root = roots.find((path) => path === '' || file.startsWith(`${path}/`))
    if (root === undefined) continue
    const list = groups.get(root) ?? []
    list.push(file)
    groups.set(root, list)
  }
  return cartridges.filter((path) => groups.has(path)).map((path) => ({ path, files: groups.get(path) ?? [] }))
}

