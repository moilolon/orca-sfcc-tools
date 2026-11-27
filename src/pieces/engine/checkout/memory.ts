// A checkout in memory, for the tests and for whatever is read as a whole (a git ref's files):
// files by relative path, each with its text and a modification time. Pure: no Node, no Orca.
import { normalizePath, type CheckoutFiles, type DirEntry } from './files'

export class MemoryFiles implements CheckoutFiles {
  private readonly files = new Map<string, { text: string; time: number }>()
  /** How many times each operation ran, for the tests of what a rebuild reads again. */
  readonly reads = new Map<string, number>()

  constructor(entries: Record<string, string> = {}, time = 1) {
    for (const [path, text] of Object.entries(entries)) this.set(path, text, time)
  }

  set(path: string, text: string, time = 1): void {
    const plain = normalizePath(path)
    if (plain === null || plain === '') throw new Error(`not a relative path: ${path}`)
    this.files.set(plain, { text, time })
  }

  delete(path: string): void {
    const plain = normalizePath(path)
    if (plain === null) return
    this.files.delete(plain)
    for (const key of [...this.files.keys()]) if (key.startsWith(plain + '/')) this.files.delete(key)
  }

  paths(): string[] {
    return [...this.files.keys()].sort()
  }

  async list(dir: string): Promise<DirEntry[] | null> {
    const plain = normalizePath(dir)
    if (plain === null || this.files.has(plain)) return null
    const prefix = plain === '' ? '' : plain + '/'
    const entries = new Map<string, DirEntry>()
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const at = rest.indexOf('/')
      const name = at === -1 ? rest : rest.slice(0, at)
      if (!entries.has(name)) entries.set(name, { name, kind: at === -1 ? 'file' : 'folder' })
    }
    if (entries.size === 0 && plain !== '') return null
    return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  async read(path: string): Promise<string | null> {
    const plain = normalizePath(path)
    if (plain === null) return null
    this.reads.set(plain, (this.reads.get(plain) ?? 0) + 1)
    return this.files.get(plain)?.text ?? null
  }

  async time(path: string): Promise<number | null> {
    const plain = normalizePath(path)
    if (plain === null) return null
    return this.files.get(plain)?.time ?? null
  }
}
