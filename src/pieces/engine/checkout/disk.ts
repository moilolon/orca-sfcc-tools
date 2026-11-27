// The real disk as the checkout index reads it, and a watcher of the checkout's folder. Worker
// only. Every path is relative to the workspace's folder and refused when it leaves it; symbolic
// links are not followed (a link to a folder could loop, or leave the checkout).
import { existsSync, watch as nodeWatch, type FSWatcher } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizePath, type CheckoutFiles, type DirEntry } from './files'

export function diskFiles(root: string): CheckoutFiles {
  const full = (path: string): string | null => {
    const plain = normalizePath(path)
    return plain === null ? null : plain === '' ? root : join(root, ...plain.split('/'))
  }
  return {
    async list(dir) {
      const path = full(dir)
      if (path === null) return null
      try {
        const entries = await readdir(path, { withFileTypes: true })
        const out: DirEntry[] = []
        for (const entry of entries) {
          if (entry.isDirectory()) out.push({ name: entry.name, kind: 'folder' })
          else if (entry.isFile()) out.push({ name: entry.name, kind: 'file' })
        }
        return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      } catch {
        return null
      }
    },
    async read(file) {
      const path = full(file)
      if (path === null) return null
      // Only a path `time()` found to be a file (not a link) is read: no second check here.
      try {
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    async time(file) {
      const path = full(file)
      if (path === null) return null
      try {
        const info = await lstat(path)
        return info.isFile() ? info.mtimeMs : null
      } catch {
        return null
      }
    }
  }
}

export type Watcher = { dispose(): void }

/**
 * Watches the folder and every folder below it, calling `onChange` with each changed path,
 * relative and with `/`. Null when the platform cannot watch a tree (then the index is kept current
 * only by a rebuild). `onError` is called once when the watcher stops on its own: on an error, or
 * once the folder itself is gone. On Windows, Node goes on reporting the removed folder's own
 * path (`\\?\C:\…`) many thousands of times a second and never fails: an event that names no
 * path inside the folder is the one that checks whether the folder is still there.
 */
export function watchCheckout(root: string, onChange: (path: string) => void, onError: () => void = () => {}): Watcher | null {
  let closed = false
  const stop = () => {
    if (closed) return
    closed = true
    watcher.close()
    onError()
  }
  let watcher: FSWatcher
  try {
    watcher = nodeWatch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (closed) return
      const plain = typeof filename === 'string' && filename !== '' ? normalizePath(filename) : null
      if (plain !== null && plain !== '') onChange(plain)
      else if (!existsSync(root)) stop()
    })
  } catch {
    return null
  }
  watcher.on('error', stop)
  return {
    dispose() {
      closed = true
      watcher.close()
    }
  }
}
