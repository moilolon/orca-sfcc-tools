// The error diff of the command line (bin/errors.ts): per environment, what is new since the last
// report and what is still not marked as seen in the plugin.
//
// A report reads each environment's log through the plugin's runner (src/core/b2c.ts, the same
// arguments as the worker: digest.ts), computes each entry's signature and sample the way the
// worker does, and compares them with two files of the plugin's data folder:
//   - `seen.json`, the seen list the worker keeps: read, never written here. A signature a person
//     marked there is not reported. Recording occurrences there would count the panel's entries
//     twice, so nothing is.
//   - `report.json`, this command's own cursor: `{ version: 1, roles: { <role>: { lastReportAt,
//     reported, counted } } }`. `lastReportAt` is the time of the newest entry read, as the
//     instance stamped it (GMT), never past the run itself; before any entry, the start of the
//     first window (`nextCursor`). A report reads each log from
//     `REPORT_OVERLAP_MS` before it (one day back the first time, or `--since`), since another
//     app server may flush an entry stamped earlier after the last report; an entry the last
//     report already counted (`counted`: its signature and time, for the entries of that overlap)
//     is not counted again. A signature is listed as new when no earlier report listed it, as
//     still unmarked when one did. The cursor of a role moves only once a report was printed whole
//     and only for a role that was read.
//
// What is printed: per signature its short form, its count and first and last time in the
// window, its normalised first line, its logger and its top frame's file and function (or its
// pipeline when it has no frame), all masked by the runner. Never a raw entry, a line of the stack
// beyond the top frame, the site, a host, or anything of dw.json; an environment that cannot be
// read says only its code.
//
// Under plain Node: explicit `.ts` imports only.
import { B2cError, type B2c } from '../../core/b2c.ts'
import { t } from '../../core/i18n.ts'
import type { ConfigState, Role } from '../../core/instances.ts'
import { DATA_VERSION, readDataFile, updateDataFile, type DataFile } from './data-folder.ts'
import { maskedSamples, occurrencesOf, readArguments, windowFull } from './digest.ts'
import { cliMessages, type CliMessageKey } from './i18n.ts'
import { ERROR_LEVELS, filtersOf, parseLogEntries } from './reader.ts'
import type { SeenRecord } from './seen.ts'

export const REPORT_VERSION = 1
/** How far before the newest entry last read a report reads again: an entry flushed late is still read. */
export const REPORT_OVERLAP_MS = 5 * 60 * 1000
/** How far back the first report of an environment reads. */
export const FIRST_REPORT_MS = 24 * 60 * 60 * 1000
/** Rows listed per group of an environment; the rest are counted. */
export const MAX_REPORT_ROWS = 50
/** Signatures kept as reported per environment, the most recent first. */
export const MAX_REPORTED = 1_000
/** Characters of the short signature. */
export const SHORT_SIGNATURE = 8
/** How long each b2c call may take. */
const READ_TIMEOUT_MS = 90_000

/** One signature in a report. Times are ISO 8601 in UTC. */
export type ReportRow = {
  signature: string
  count: number
  firstSeen: string
  lastSeen: string
  /** The normalised first line, masked. */
  message: string
  logger: string | null
  /** The top frame's file and function, masked; null without one. */
  frame: { file: string; function: string | null } | null
  /** The pipeline or controller, only when the entry has no frame. */
  pipeline: string | null
}

export type RoleReport =
  | {
      role: Role
      read: true
      /** The start of the window read. */
      since: string
      new: ReportRow[]
      unmarked: ReportRow[]
      /** Rows past `MAX_REPORT_ROWS`, not listed. */
      omitted: { new: number; unmarked: number }
      /** Signatures in the window marked as seen, not listed. */
      marked: number
      /** b2c returned a full window: entries may be missing. */
      mayHaveMissed: boolean
    }
  | { role: Role; read: false; error: string }

export type Report = {
  version: typeof REPORT_VERSION
  generatedAt: string
  config: ConfigState
  seenList: 'ok' | 'missing' | 'invalid'
  /** `invalid`: the last report could not be read, so this one moves no cursor. */
  lastReport: 'ok' | 'missing' | 'invalid'
  roles: RoleReport[]
}

/** One role's cursor in `report.json`. */
export type ReportCursor = {
  /** The newest entry read, in milliseconds since the epoch, as the instance stamped it. */
  lastReportAt: number
  reported: string[]
  /** `<signature>@<time>` of each entry counted within `REPORT_OVERLAP_MS` of `lastReportAt`. */
  counted: string[]
}

export type ReportDeps = {
  b2c: Pick<B2c, 'run' | 'instances' | 'mask'>
  roles: readonly Role[]
  seenPath: string
  reportPath: string
  now: () => number
  /** The start of the window for every role, instead of each one's last report. */
  since?: number
}

type SeenTable = Record<string, SeenRecord>

function cursorOf(value: unknown): ReportCursor | null {
  if (!value || typeof value !== 'object') return null
  const { lastReportAt, reported, counted } = value as { lastReportAt?: unknown; reported?: unknown; counted?: unknown }
  if (typeof lastReportAt !== 'number' || !Number.isFinite(lastReportAt)) return null
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [])
  return { lastReportAt, reported: strings(reported), counted: strings(counted) }
}

async function readOrState<T>(path: string): Promise<{ state: 'ok' | 'missing' | 'invalid'; file: DataFile<T> | null }> {
  try {
    const file = await readDataFile<T>(path)
    return { state: file ? 'ok' : 'missing', file }
  } catch {
    return { state: 'invalid', file: null }
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Why a role cannot be read with the configuration given; null when it can. */
function refusalOf(config: ConfigState, state: string): string | null {
  if (config === 'invalid') return 'config_invalid'
  if (config === 'missing') return 'config_missing'
  if (state === 'ready') return null
  return state === 'incomplete' ? 'credentials_missing' : 'role_not_configured'
}

/** Most occurrences first, then the newest. */
function byWeight(a: ReportRow, b: ReportRow): number {
  return b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.signature.localeCompare(b.signature)
}

/**
 * Reads every role and builds the report, with the cursor each read role moves to. Writes
 * nothing: `commitReport` does, once the report was printed.
 */
export async function buildReport(deps: ReportDeps): Promise<{ report: Report; cursors: Partial<Record<Role, ReportCursor>> }> {
  const now = deps.now()
  const { config, instances } = await deps.b2c.instances()
  const seen = await readOrState<SeenTable>(deps.seenPath)
  const last = await readOrState<unknown>(deps.reportPath)
  const roles: RoleReport[] = []
  const cursors: Partial<Record<Role, ReportCursor>> = {}
  for (const role of deps.roles) {
    const refusal = refusalOf(config, instances[role])
    if (refusal) {
      roles.push({ role, read: false, error: refusal })
      continue
    }
    const cursor = cursorOf(last.file?.roles[role])
    const since = deps.since ?? (cursor ? cursor.lastReportAt - REPORT_OVERLAP_MS : now - FIRST_REPORT_MS)
    let json: unknown
    try {
      json = (await deps.b2c.run(readArguments(filtersOf(undefined), since), { role, timeoutMs: READ_TIMEOUT_MS })).json
    } catch (error) {
      roles.push({ role, read: false, error: error instanceof B2cError ? error.code : 'b2c_failed' })
      continue
    }
    const all = parseLogEntries(json, { levels: ERROR_LEVELS })
    const inWindow = all.filter((entry) => entry.timestamp >= since)
    // Each entry's key; one the last report counted, in the overlap, is not counted again.
    const keys = occurrencesOf(inWindow).occurrences.map(({ signature, at }) => `${signature}@${at}`)
    const counted = new Set(cursor?.counted ?? [])
    const { occurrences, newest } = occurrencesOf(inWindow.filter((_, index) => !counted.has(keys[index])))
    const samples = await maskedSamples(newest, (text) => deps.b2c.mask(text))
    const table: SeenTable = seen.file?.roles[role] ?? {}
    const reported = new Set(cursor?.reported ?? [])
    const fresh: ReportRow[] = []
    const unmarked: ReportRow[] = []
    let marked = 0
    for (const signature of newest.keys()) {
      if (table[signature]?.markedAt !== undefined) {
        marked++
        continue
      }
      const times = occurrences.filter((each) => each.signature === signature).map((each) => each.at)
      const sample = samples.get(signature)
      const top = sample?.frames[0]
      const row: ReportRow = {
        signature,
        count: times.length,
        firstSeen: iso(Math.min(...times)),
        lastSeen: iso(Math.max(...times)),
        message: sample?.message ?? '',
        logger: sample?.logger ?? null,
        frame: top ? { file: top.file, function: top.function } : null,
        pipeline: top ? null : (sample?.pipeline ?? null)
      }
      ;(reported.has(signature) ? unmarked : fresh).push(row)
    }
    fresh.sort(byWeight)
    unmarked.sort(byWeight)
    roles.push({
      role,
      read: true,
      since: iso(since),
      new: fresh.slice(0, MAX_REPORT_ROWS),
      unmarked: unmarked.slice(0, MAX_REPORT_ROWS),
      omitted: { new: Math.max(0, fresh.length - MAX_REPORT_ROWS), unmarked: Math.max(0, unmarked.length - MAX_REPORT_ROWS) },
      marked,
      mayHaveMissed: windowFull(json, all)
    })
    // Listed now first, then what earlier reports listed and nobody marked since; bounded.
    const listed = [...fresh, ...unmarked].map((row) => row.signature)
    const kept = (cursor?.reported ?? []).filter((signature) => !listed.includes(signature) && table[signature]?.markedAt === undefined)
    cursors[role] = nextCursor(cursor, inWindow.map((entry, index) => ({ at: entry.timestamp, key: keys[index] })), { now, since })
    cursors[role]!.reported = [...listed, ...kept].slice(0, MAX_REPORTED)
  }
  return {
    report: { version: REPORT_VERSION, generatedAt: iso(now), config, seenList: seen.state, lastReport: last.state, roles },
    cursors
  }
}

/**
 * Where the next report of a role starts, from the entries of this one's window (`at`, and
 * `key`: signature and time):
 *   - the newest entry's own time (GMT), so a machine clock ahead of the instance's loses nothing;
 *   - but never past the run itself: an entry a server stamped in the future cannot push the
 *     cursor past every other server's entries;
 *   - never back from where the last report left it;
 *   - with no entry yet, the start of this window, kept: the next report reads on from there
 *     instead of a new day back from its own clock, so an entry stamped just before this report
 *     and flushed after it is still read.
 * `counted` holds every entry the next window reads again (at or after the cursor less
 * `REPORT_OVERLAP_MS`, the same bound as its `since`), so none is counted twice.
 */
export function nextCursor(cursor: ReportCursor | null, entries: readonly { at: number; key: string }[], { now, since }: { now: number; since: number }): ReportCursor {
  const newestEntry = Math.max(-Infinity, ...entries.map(({ at }) => at))
  let at = Math.max(cursor?.lastReportAt ?? -Infinity, Math.min(newestEntry, now))
  if (!Number.isFinite(at)) at = since
  const counted = entries.filter((entry) => entry.at >= at - REPORT_OVERLAP_MS).map(({ key }) => key)
  return { lastReportAt: at, reported: cursor?.reported ?? [], counted: [...new Set(counted)] }
}

/** Whether every role asked was read: the command line exits 0 only then. */
export function reportOk(report: Report): boolean {
  return report.roles.every((role) => role.read) && report.seenList !== 'invalid' && report.lastReport !== 'invalid'
}

/**
 * Moves each read role's cursor in `report.json`, under its lock. Nothing moves when the last
 * report could not be read: it is never overwritten.
 */
export async function commitReport(path: string, report: Report, cursors: Partial<Record<Role, ReportCursor>>): Promise<void> {
  if (report.lastReport === 'invalid' || Object.keys(cursors).length === 0) return
  await updateDataFile<unknown>(path, (current) => ({ version: DATA_VERSION, roles: { ...(current?.roles ?? {}), ...cursors } }))
}

/** `2026-11-26 09:12 UTC`. */
function shortTime(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`
}

const ROLE_NAMES: Record<Role, string> = { sandbox: 'Sandbox', development: 'Development', staging: 'Staging', production: 'Production' }

/** The report as text, in `locale`'s language. */
export function formatText(report: Report, locale: string): string {
  const say = (key: CliMessageKey, vars?: Record<string, string | number>) => t(cliMessages, locale, key, vars)
  const lines: string[] = [say('title', { time: shortTime(report.generatedAt) })]
  if (report.config === 'missing') lines.push(say('configMissing'))
  if (report.config === 'invalid') lines.push(say('configInvalid'))
  if (report.seenList === 'missing') lines.push(say('seenMissing'))
  if (report.seenList === 'invalid') lines.push(say('seenInvalid'))
  if (report.lastReport === 'invalid') lines.push(say('reportInvalid'))
  const rows = (group: ReportRow[], omitted: number) => {
    for (const row of group) {
      lines.push(`  - ${say('row', { signature: row.signature.slice(0, SHORT_SIGNATURE), count: row.count, first: shortTime(row.firstSeen), last: shortTime(row.lastSeen) })}`)
      lines.push(`    ${row.message}`)
      const where = [row.logger, row.frame ? [row.frame.file, row.frame.function].filter(Boolean).join(' ') : row.pipeline].filter(Boolean)
      if (where.length > 0) lines.push(`    ${where.join(' · ')}`)
    }
    if (omitted > 0) lines.push(`  ${say('more', { count: omitted })}`)
  }
  for (const role of report.roles) {
    lines.push('')
    const name = ROLE_NAMES[role.role]
    if (!role.read) {
      lines.push(`${name}: ${say('notRead', { code: role.error })}`)
      continue
    }
    const newCount = role.new.length + role.omitted.new
    const unmarkedCount = role.unmarked.length + role.omitted.unmarked
    const summary = newCount + unmarkedCount === 0 ? say('nothing') : say('summary', { new: newCount, unmarked: unmarkedCount })
    lines.push(`${name}: ${summary}, ${say('since', { time: shortTime(role.since) })}`)
    if (role.new.length > 0) {
      lines.push(say('newGroup'))
      rows(role.new, role.omitted.new)
    }
    if (role.unmarked.length > 0) {
      lines.push(say('unmarkedGroup'))
      rows(role.unmarked, role.omitted.unmarked)
    }
    if (role.marked > 0) lines.push(say('marked', { count: role.marked }))
    if (role.mayHaveMissed) lines.push(say('missed'))
  }
  return `${lines.join('\n')}\n`
}

/** The report as one JSON document. */
export function formatJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`
}
