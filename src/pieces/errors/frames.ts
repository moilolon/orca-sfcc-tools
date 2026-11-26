// Which frames of a stack trace are files of the workspace: a frame names a script by its path on
// the instance (`app_example/cartridge/scripts/cart.js`), whose first part is a cartridge. A
// cartridge of the workspace is a folder holding a `.project` file, as b2c finds them; the frame
// is a file of the workspace when that cartridge's folder holds the rest of the path.
import { readdir, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

export type FrameFileSystem = {
  /** The names of the folders in a folder, and whether it holds a `.project` file. */
  list(path: string): Promise<{ folders: string[]; isCartridge: boolean }>
  isFile(path: string): Promise<boolean>
}

/** How deep under the workspace cartridges are looked for, and how many folders at most. */
const MAX_DEPTH = 4
const MAX_FOLDERS = 2_000
/** How long a workspace's cartridges and the files found in them are trusted. */
const CACHE_MS = 30_000

const SKIPPED = new Set(['node_modules', '.git', '.orca', '.claude', 'dist', 'build', 'coverage'])

async function defaultList(path: string): Promise<{ folders: string[]; isCartridge: boolean }> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return {
      folders: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      isCartridge: entries.some((entry) => entry.isFile() && entry.name === '.project')
    }
  } catch {
    return { folders: [], isCartridge: false }
  }
}

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export const NODE_FILE_SYSTEM: FrameFileSystem = { list: defaultList, isFile: defaultIsFile }

/** The cartridges of a workspace, by name: the folders holding a `.project` file. */
export async function findCartridges(root: string, fs: FrameFileSystem, platform: string): Promise<Map<string, string>> {
  const join = platform === 'win32' ? win32.join : posix.join
  const found = new Map<string, string>()
  let queue: { path: string; name: string; depth: number }[] = [{ path: root, name: '', depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < MAX_FOLDERS) {
    const next: typeof queue = []
    for (const folder of queue) {
      if (visited++ >= MAX_FOLDERS) break
      const { folders, isCartridge } = await fs.list(folder.path)
      if (isCartridge && folder.depth > 0) {
        // The first one found, nearest the root, wins; a cartridge holds no other.
        if (!found.has(folder.name)) found.set(folder.name, folder.path)
        continue
      }
      if (folder.depth >= MAX_DEPTH) continue
      for (const name of folders) {
        if (name.startsWith('.') || SKIPPED.has(name)) continue
        next.push({ path: join(folder.path, name), name, depth: folder.depth + 1 })
      }
    }
    queue = next
  }
  return found
}

/**
 * The local file of a script path, or null. The path must start, after any leading folders the
 * instance adds, with a cartridge of the workspace followed by `cartridge/`, and hold no `..`.
 */
export function localPathOf(file: string, cartridges: ReadonlyMap<string, string>, platform: string): string | null {
  const parts = file.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.')
  if (parts.includes('..')) return null
  const join = platform === 'win32' ? win32.join : posix.join
  for (let i = 0; i < parts.length - 2; i++) {
    const folder = cartridges.get(parts[i])
    if (folder && parts[i + 1] === 'cartridge') return join(folder, ...parts.slice(i + 1))
  }
  return null
}

export type FrameResolver = {
  /** The local file of a frame's script in the workspace at `root`, or null. */
  resolve(root: string, file: string): Promise<string | null>
}

export function createFrameResolver({ fs = NODE_FILE_SYSTEM, platform = process.platform, now = Date.now }: { fs?: FrameFileSystem; platform?: string; now?: () => number } = {}): FrameResolver {
  const cartridges = new Map<string, { at: number; found: Promise<Map<string, string>> }>()
  const files = new Map<string, { at: number; exists: Promise<boolean> }>()
  function cartridgesOf(root: string): Promise<Map<string, string>> {
    const cached = cartridges.get(root)
    if (cached && now() - cached.at < CACHE_MS) return cached.found
    const found = findCartridges(root, fs, platform)
    cartridges.set(root, { at: now(), found })
    return found
  }
  function exists(path: string): Promise<boolean> {
    const cached = files.get(path)
    if (cached && now() - cached.at < CACHE_MS) return cached.exists
    const found = fs.isFile(path)
    if (files.size > 5_000) files.clear()
    files.set(path, { at: now(), exists: found })
    return found
  }
  return {
    async resolve(root, file) {
      const path = localPathOf(file, await cartridgesOf(root), platform)
      return path && (await exists(path)) ? path : null
    }
  }
}
