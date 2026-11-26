// What `b2c code watch --jsonl` says, one stderr line at a time. It prints nothing on stdout: each
// event is a JSON line on stderr, a file event (`event` with `path`) and then the result of the
// upload in `msg` (`[UPLOAD] 3 file(s)`, `[DELETE] 1 file(s)`). Other lines (the start banner,
// b2c's update notice, which is not JSON) say nothing about uploads. Pure: no Node or Orca imports.
import type { B2cEvent } from '../../core/b2c'

export type WatchSignal =
  /** A file changed, was added or removed: an upload is on its way. */
  | { kind: 'changed' }
  /** Files reached the sandbox, or were removed from it. */
  | { kind: 'uploaded'; files: number }
  /** b2c logged an error: an upload failed. */
  | { kind: 'error' }

const FILE_EVENTS = new Set(['change', 'add', 'unlink', 'addDir', 'unlinkDir'])

/** pino's numeric levels: 50 is `error`, 60 `fatal`. */
const ERROR_LEVEL = 50

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** What one stderr line of `code watch` means for the upload, or null when it means nothing. */
export function readWatchEvent(event: B2cEvent): WatchSignal | null {
  if (!('json' in event) || !isRecord(event.json)) return null
  const line = event.json
  const level = line.level
  if (level === 'error' || level === 'fatal' || (typeof level === 'number' && level >= ERROR_LEVEL)) return { kind: 'error' }
  if (typeof line.event === 'string' && FILE_EVENTS.has(line.event)) return { kind: 'changed' }
  const msg = typeof line.msg === 'string' ? line.msg : ''
  const done = /^\s*\[(UPLOAD|DELETE)\]\s+(\d+)\s+file/.exec(msg)
  if (done) return { kind: 'uploaded', files: Number(done[2]) }
  return null
}
