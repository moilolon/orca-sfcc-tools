// What `b2c logs get --json` prints, taken apart. Pure: no Orca or Node imports, so the command
// line of phase 4 can load it outside Orca.
//
// The answer is `{ count, entries: [{ file, timestamp, level, message, raw }] }`. One entry is one
// error with its whole stack trace inside `message`; `raw` is `[timestamp] LEVEL ` and the message
// again, and is never kept. The first line of `message` holds pipe-separated fields (thread,
// thread id, site, pipeline or controller, call type, session), then the logger and the text:
//
//   PipelineCallServlet|1234|Sites-Example-Site|Cart-Show|PipelineCall|sessionid custom.Cart ERROR text
//
// The lines after it are the rest of the entry: system and request information, and the stack
// trace, one `at …` line per frame. `timestamp` is `YYYY-MM-DD HH:mm:ss.SSS GMT`, not ISO 8601,
// and entries do not come in order: they are parsed and sorted here.

/** One entry of the log, without its `raw` text. `timestamp` is milliseconds since the epoch. */
export type LogEntry = { file: string; timestamp: number; level: string; message: string }

/**
 * A frame of a stack trace. `file` is the script's path on the instance
 * (`app_example/cartridge/scripts/cart.js`) or a Java file (`Engine.java`); `script` says which.
 */
export type Frame = { file: string; function: string | null; line: number | null; script: boolean }

export type ParsedMessage = {
  /** The pipe-separated fields of the first line, the session included. */
  fields: string[]
  /** The field naming the site (`Sites-Example-Site`), or null. */
  site: string | null
  /** The pipeline or controller (`Cart-Show`), or null. */
  pipeline: string | null
  /** The logger (`custom.Cart`, `system.core`), or null when the line names none. */
  logger: string | null
  /** The rest of the first line: the error's own text. */
  text: string
  /** The lines after the first. */
  trace: string[]
  /** The frames of the trace, top first. */
  frames: Frame[]
}

/** The levels a log line can carry, as b2c and the instance write them. */
const LEVELS = /^(?:FATAL|ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\b\s*/

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3})\d*)?\s*(?:GMT|UTC|Z)?$/

/** `2026-11-26 00:10:02.123 GMT` as milliseconds since the epoch, or null when it is not that. */
export function parseTimestamp(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const match = TIMESTAMP.exec(text.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second, millis = '0'] = match
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millis.padEnd(3, '0')))
  // Date.UTC rolls an impossible date over (the 31st of November is the 1st of December).
  const date = new Date(ms)
  if (Number.isNaN(ms) || date.getUTCDate() !== Number(day) || date.getUTCMonth() !== Number(month) - 1) return null
  return ms
}

/**
 * The entries of a `logs get --json` answer, oldest first. An entry without a message or a
 * timestamp that parses is left out; `raw` is never kept.
 */
export function parseLogEntries(json: unknown): LogEntry[] {
  const entries = json && typeof json === 'object' && Array.isArray((json as { entries?: unknown }).entries) ? (json as { entries: unknown[] }).entries : []
  const parsed: LogEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const { file, timestamp, level, message } = entry as Record<string, unknown>
    const at = parseTimestamp(timestamp)
    if (at === null || typeof message !== 'string') continue
    parsed.push({ file: typeof file === 'string' ? file : '', timestamp: at, level: typeof level === 'string' ? level : '', message })
  }
  // Stable: two entries of the same millisecond keep the order b2c gave them.
  return parsed.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.index - b.index).map(({ entry }) => entry)
}

/** A logger: a dotted name (`custom.Cart`, `system.core`, `com.example.Engine`). */
const LOGGER = /^[A-Za-z_$][\w$-]*(?:\.[\w$-]+)+$/

/** Pipe-separated fields with no space in them, then the session, then the rest. */
const FIELDS = /^((?:[^|\s]*\|)+)(\S*)(?:\s+([\s\S]*))?$/

/** A script frame: `at app_x/cartridge/scripts/a.js:12 (name)`, the line and the name optional. */
const SCRIPT_FRAME = /^\s*at\s+(\S+?\.(?:js|ds|isml))(?:[:#](\d+))?(?::\d+)?(?:\s*\(([^()]*)\))?\s*$/
/** A Java frame: `at com.example.Engine.run(Engine.java:42)`. */
const JAVA_FRAME = /^\s*at\s+([\w$.<>]+)\(([^():]+?)(?::(\d+))?\)\s*$/

/** One line of a trace as a frame, or null when it is not one. */
export function parseFrame(line: string): Frame | null {
  const script = SCRIPT_FRAME.exec(line)
  if (script) {
    const [, file, lineNumber, name] = script
    return { file: file.replace(/^\/+/, ''), function: name?.trim() || null, line: lineNumber ? Number(lineNumber) : null, script: true }
  }
  const java = JAVA_FRAME.exec(line)
  if (java) {
    const [, name, file, lineNumber] = java
    return { file, function: name, line: lineNumber ? Number(lineNumber) : null, script: false }
  }
  return null
}

/** The message of an entry taken apart: its fields, its logger and text, and its trace. */
export function parseMessage(message: string): ParsedMessage {
  const [first = '', ...trace] = message.replace(/\r\n?/g, '\n').split('\n')
  let fields: string[] = []
  let rest = first.trim()
  const match = FIELDS.exec(first.trim())
  if (match) {
    fields = [...match[1].split('|').slice(0, -1), match[2]]
    rest = match[3] ?? ''
  }
  let logger: string | null = null
  const [word = ''] = rest.split(/\s+/)
  if (LOGGER.test(word)) {
    logger = word
    rest = rest.slice(rest.indexOf(word) + word.length)
  }
  const text = rest.trim().replace(LEVELS, '').replace(/^[-:]\s+/, '').trim()
  const site = fields.find((field) => /^Sites-.+-Site$/.test(field)) ?? null
  const siteIndex = site === null ? -1 : fields.indexOf(site)
  const pipeline = siteIndex !== -1 && fields[siteIndex + 1] ? fields[siteIndex + 1] : null
  const frames = trace.map(parseFrame).filter((frame): frame is Frame => frame !== null)
  return { fields, site, pipeline, logger, text, trace, frames }
}

/** The `--filter` prefixes of a setting (`error,customerror`); only plain prefixes are kept (a letter or digit first, so none reads as a flag). */
export function filtersOf(setting: unknown): string[] {
  const words = typeof setting === 'string' ? setting.split(/[\s,]+/) : []
  const kept = words.filter((word) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(word))
  return kept.length > 0 ? [...new Set(kept)] : ['error', 'customerror']
}
