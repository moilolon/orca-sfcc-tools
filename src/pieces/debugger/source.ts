// The lines of one script, read when the person opens it in the debugger's view to put a
// breakpoint on a line, and never stored: the worker reads the file, cuts it to what a view can
// draw, and answers. Only a file of the workspace's cartridges is read (the caller checks it is in
// the list `scriptFiles` found), and only when it really is inside the workspace's folder, links
// included.
import { open, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

/** At most this much of a file is read. */
export const MAX_BYTES = 1024 * 1024
/** At most this many lines are answered, each cut to MAX_LINE_CHARS, and MAX_TOTAL_CHARS in all. */
export const MAX_LINES = 5_000
export const MAX_LINE_CHARS = 240
export const MAX_TOTAL_CHARS = 300_000

export type SourceFileSystem = {
  /** The real path of a path, links resolved. */
  realpath(path: string): Promise<string>
  /** At most `limit` bytes from the start of the file, and whether there were more. */
  read(path: string, limit: number): Promise<{ bytes: Uint8Array; more: boolean }>
}

export const NODE_SOURCE_FS: SourceFileSystem = {
  realpath: (path) => realpath(path),
  async read(path, limit) {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(limit + 1)
      const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0)
      return { bytes: buffer.subarray(0, Math.min(bytesRead, limit)), more: bytesRead > limit }
    } finally {
      await handle.close()
    }
  }
}

/** Whether `child` is `parent` or inside it. */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class SourceError extends Error {
  constructor(readonly code: 'not_found' | 'outside_workspace') {
    super(code)
  }
}

/**
 * The lines of `path` (relative to `root`, already checked to be a script of the workspace), cut
 * to MAX_LINES lines of MAX_LINE_CHARS characters and MAX_TOTAL_CHARS in all; `truncated` when
 * anything was left out. Throws `not_found` when it cannot be read, `outside_workspace` when a
 * link takes it out of the workspace's folder.
 */
export async function readSource(root: string, path: string, fs: SourceFileSystem = NODE_SOURCE_FS): Promise<{ lines: string[]; truncated: boolean }> {
  let real: string
  let realRoot: string
  try {
    ;[realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(join(root, ...path.split('/')))])
  } catch {
    throw new SourceError('not_found')
  }
  if (!inside(realRoot, real)) throw new SourceError('outside_workspace')
  let read: { bytes: Uint8Array; more: boolean }
  try {
    read = await fs.read(real, MAX_BYTES)
  } catch {
    throw new SourceError('not_found')
  }
  // A character cut by the byte limit is dropped rather than shown broken.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(read.bytes).replace(/�$/, '')
  const all = text.split(/\r?\n/)
  if (all.length > 1 && all[all.length - 1] === '' && !read.more) all.pop()
  let truncated = read.more || all.length > MAX_LINES
  const lines: string[] = []
  let total = 0
  for (const line of all.slice(0, MAX_LINES)) {
    const cut = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
    if (cut !== line) truncated = true
    if (total + cut.length > MAX_TOTAL_CHARS) {
      truncated = true
      break
    }
    total += cut.length
    lines.push(cut)
  }
  return { lines, truncated }
}
