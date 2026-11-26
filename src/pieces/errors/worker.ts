// The errors piece's worker half, listed in src/worker/pieces.ts: reads each environment's log
// with `b2c logs get`, keeps a seen list per environment (seen.ts) keyed by signature
// (signature.ts), and tells the person what is new: a notification with how many, the sandbox's
// count on the status bar, and the section's view.
//
// The sandbox is read on a timer (Settings, in minutes; 0, the default, is off), the other three
// only when a person asks. Two reads of one environment never overlap: asking during a read joins
// it. Each read asks for the ERROR and FATAL entries (`--level`) of the files a setting names
// (`--filter`), since a few minutes before the newest entry already read (`cursor.<role>`), at
// most `MAX_ENTRIES`; an entry counts once, by the newest time read from its own file. What is
// stored, in the plugin's own storage: per signature its counters and one bounded sample, masked;
// never a raw entry.
//
// b2c's `logs get` reads only the last 64 KB of each log file (not a flag) and keeps at most
// `--count` entries, so a busy log can hold entries no read ever sees. That cannot be fixed here;
// it is detected, and the environment is marked "some entries may have been missed since <time>"
// in the view, when:
//   - a read got `MAX_ENTRIES` entries;
//   - the error entries of one file add up to nearly a whole window (`FULL_WINDOW_BYTES`);
//   - a file grew by more than its window since the last read, by `logs list`, which runs before
//     each read for the same files: whatever the level of its lines, so a window that warnings
//     or info lines filled counts too. A file not seen before counts when it is already larger
//     than its window and was written since the read's start.
import { B2cError } from '../../core/b2c'
import { isRole, type Role } from '../../core/instances'
import { createOpenFile, type OpenFile } from '../../core/open-file'
import type { Disposable, PieceContext, WorkerPiece } from '../../core/piece'
import { isLocal } from '../../core/workspaces'
import { createFrameResolver, type FrameResolver } from './frames'
import { messages, ROLE_KEYS } from './i18n'
import type { ErrorRow, OpenFrameResult, RoleErrors } from './protocol'
import { ERROR_LEVELS, filtersOf, parseLogEntries, parseMessage, type ParsedMessage } from './reader'
import { createSeenList, type Occurrence, type Sample, type SeenJson, type SeenStore } from './seen'
import { identityOf, normalize, signatureOfIdentity } from './signature'

/** The most entries one read asks for. b2c also reads only the last 64 KB of each file. */
export const MAX_ENTRIES = 200
/** How much of a file b2c reads, from its end. */
export const FILE_WINDOW_BYTES = 64 * 1024
/** Entries of one file adding up to this much mean its window was (nearly) full. */
export const FULL_WINDOW_BYTES = 48 * 1024
/** How far before the cursor a read starts, so an entry another server wrote late is still read. */
export const OVERLAP_MS = 5 * 60 * 1000
/** How long a file's own cursor is kept. */
const FILE_CURSOR_MS = 2 * 24 * 60 * 60 * 1000
/** How far back the first read of an environment looks. */
export const FIRST_READ_MS = 24 * 60 * 60 * 1000
/** How long after the worker starts the timer's first read runs. */
export const START_DELAY_MS = 5_000
// How long each b2c call of a read may take. A read runs on its own, never inside a panel's
// request (`errors.refresh` starts it and answers at once), so the two calls together may take
// longer than a request may wait.
const READ_TIMEOUT_MS = 90_000
/** The status bar item, declared in this piece's manifest. */
export const STATUS_ITEM = 'errors-new'

/** The piece's settings, declared in its manifest. */
export const SETTING_INTERVAL = 'errorsInterval'
export const SETTING_FILTER = 'errorsFilter'

export type ErrorsDeps = {
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  openFile?: OpenFile
  frames?: FrameResolver
}

type ReadStatus = { lastRead: number | null; error: string | null; missedSince: number | null }

/**
 * Where reading stopped: the newest entry read, overall (null before any) and per file, and each
 * file's size as `logs list` gave it at the last read.
 */
type Cursor = { at: number | null; files: Record<string, number>; sizes: Record<string, number> }

function numbersOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (typeof item === 'number') out[key] = item
  return out
}

function cursorOf(value: unknown): Cursor | null {
  // An older worker kept one number.
  if (typeof value === 'number') return { at: value, files: {}, sizes: {} }
  if (!value || typeof value !== 'object') return null
  const at = (value as { at?: unknown }).at
  if (typeof at !== 'number' && at !== null) return null
  return { at, files: numbersOf((value as { files?: unknown }).files), sizes: numbersOf((value as { sizes?: unknown }).sizes) }
}

/** Each log file's size and last change, from a `logs list --json` answer. */
export function fileSizesOf(json: unknown): Map<string, { size: number; modified: number | null }> {
  const files = json && typeof json === 'object' ? (json as { files?: unknown }).files : undefined
  const out = new Map<string, { size: number; modified: number | null }>()
  if (!Array.isArray(files)) return out
  for (const file of files) {
    if (!file || typeof file !== 'object') continue
    const { name, size, lastModified } = file as Record<string, unknown>
    if (typeof name !== 'string' || typeof size !== 'number') continue
    const modified = typeof lastModified === 'string' ? Date.parse(lastModified) : Number.NaN
    out.set(name, { size, modified: Number.isNaN(modified) ? null : modified })
  }
  return out
}

/**
 * Whether a file outgrew b2c's window since the last read: it grew by more than the window, or,
 * not seen before (or shorter than before, so a new file under the same name), it is larger than
 * the window and was written since `since`.
 */
export function outgrewWindow(previous: Record<string, number>, current: Map<string, { size: number; modified: number | null }>, since: number): boolean {
  for (const [name, { size, modified }] of current) {
    const before = previous[name]
    if (before !== undefined && size >= before) {
      if (size - before > FILE_WINDOW_BYTES) return true
    } else if (size > FILE_WINDOW_BYTES && (modified === null || modified >= since)) {
      return true
    }
  }
  return false
}

/** The number of entries b2c returned, whatever their level. */
function returnedCount(json: unknown): number {
  const entries = json && typeof json === 'object' ? (json as { entries?: unknown }).entries : undefined
  return Array.isArray(entries) ? entries.length : 0
}

function invalid(): Error {
  return Object.assign(new Error('invalid_params'), { code: 'invalid_params' })
}

function roleOf(input: unknown): Role {
  const role = input && typeof input === 'object' ? (input as { role?: unknown }).role : undefined
  if (!isRole(role)) throw invalid()
  return role
}

/** Minutes between reads of the sandbox: a whole number from 0 (off) to a day. */
export function intervalOf(value: unknown): number {
  const minutes = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : 0
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.round(minutes), 1440) : 0
}

/** The arguments of one read: ERROR and FATAL entries of the files named, since `since`, at most `MAX_ENTRIES`. */
export function readArguments(filters: readonly string[], since: number): string[] {
  // `--no-normalize`: the frames keep the instance's own script paths, so a signature does not
  // depend on the checkout, and no local path reaches the sample. `--level`: a file the setting
  // names may mix levels (`custom-*`); only errors are read.
  return [
    'logs',
    'get',
    '--no-normalize',
    ...filters.map((filter) => `--filter=${filter}`),
    ...ERROR_LEVELS.map((level) => `--level=${level}`),
    `--count=${MAX_ENTRIES}`,
    `--since=${new Date(since).toISOString()}`
  ]
}

/** The arguments of the listing that comes before each read: the same files. */
export function listArguments(filters: readonly string[]): string[] {
  return ['logs', 'list', ...filters.map((filter) => `--filter=${filter}`)]
}

export function createErrorsPiece(deps: ErrorsDeps = {}): WorkerPiece {
  return {
    id: 'errors',
    activate(ctx) {
      return start(ctx, deps)
    }
  }
}

function start(ctx: PieceContext, deps: ErrorsDeps): Disposable {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const openFile = deps.openFile ?? createOpenFile({ log: ctx.log })
  const frames = deps.frames ?? createFrameResolver()
  const store: SeenStore = {
    get: (key, fallback) => ctx.store.get(key, fallback) as Promise<typeof fallback>,
    set: (key, value: SeenJson) => ctx.store.set(key, value)
  }
  const seen = createSeenList(store)
  const reads = new Map<Role, Promise<void>>()
  let stopped = false

  async function rawSettings(): Promise<Record<string, unknown>> {
    try {
      return await ctx.orca.settings.get()
    } catch {
      return {}
    }
  }

  /**
   * The workspace whose cartridges a frame is looked for in: the uploading one, else the focused
   * one while no workspace uploads. Only a workspace on this machine. The one place that decides.
   */
  async function frameRoot(): Promise<string | null> {
    try {
      const workspace = (await ctx.workspaces.uploading()) ?? (await ctx.workspaces.focused())
      return workspace && isLocal(workspace) ? workspace.path : null
    } catch {
      return null
    }
  }

  const statusKey = (role: Role) => `status.${role}`
  const cursorKey = (role: Role) => `cursor.${role}`

  async function readStatus(role: Role): Promise<ReadStatus> {
    const value = await ctx.store.get<SeenJson>(statusKey(role), null)
    const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return {
      lastRead: typeof stored.lastRead === 'number' ? stored.lastRead : null,
      error: typeof stored.error === 'string' ? stored.error : null,
      missedSince: typeof stored.missedSince === 'number' ? stored.missedSince : null
    }
  }

  async function updateStatusBar(): Promise<void> {
    const count = await seen.newCount('sandbox')
    try {
      await ctx.orca.host.call('statusBar.update', {
        id: STATUS_ITEM,
        text: String(count),
        tooltip: ctx.t(messages, 'statusTooltip', { count }),
        visible: count > 0
      })
    } catch {
      // Desktop only; a host without a status bar has nothing to show it on.
    }
  }

  async function changed(role: Role): Promise<void> {
    if (stopped) return
    const newCount = await seen.newCount(role)
    ctx.orca.panels.post('errors.changed', { role, newCount })
    if (role === 'sandbox') await updateStatusBar()
  }

  /** Texts masked with one call to `mask`. A text holds no line break, so the lines map back. */
  async function maskAll(texts: readonly string[]): Promise<string[]> {
    if (texts.length === 0) return []
    const masked = (await ctx.b2c.mask(texts.map((text) => text.replace(/[\r\n]+/g, ' ')).join('\n'))).split('\n')
    return texts.map((_, index) => masked[index] ?? '')
  }

  /**
   * The samples of the newest entry of each signature. Masked, then normalised (a host in the text
   * is masked whole before its digits go, and a URL loses its host), then masked again.
   */
  async function maskedSamples(newest: Map<string, ParsedMessage>): Promise<Map<string, Sample>> {
    const plan = [...newest].map(([signature, parsed]) => ({ signature, parsed, identity: identityOf(parsed) }))
    // A sample as a list of texts, and back: message, logger, then each frame's file and function.
    const flatten = (sample: Sample) => [sample.message, sample.logger ?? '', ...sample.frames.flatMap((frame) => [frame.file, frame.function ?? ''])]
    const rebuild = (sample: Sample, texts: string[]): Sample => {
      let i = 0
      const next = () => texts[i++] ?? ''
      const message = next()
      const logger = next()
      return {
        message,
        logger: sample.logger === null ? null : logger,
        frames: sample.frames.map((frame) => {
          const file = next()
          const name = next()
          return { file, function: frame.function === null ? null : name, line: frame.line }
        })
      }
    }
    const maskEach = async (samples: Sample[]): Promise<Sample[]> => {
      const masked = await maskAll(samples.flatMap(flatten))
      let offset = 0
      return samples.map((sample) => {
        const size = flatten(sample).length
        return rebuild(sample, masked.slice(offset, (offset += size)))
      })
    }
    const raw: Sample[] = plan.map(({ parsed, identity }) => ({
      message: parsed.text,
      logger: identity.logger,
      frames: identity.frames.map((frame) => ({ file: frame.file, function: frame.function, line: frame.line }))
    }))
    const normalised = (await maskEach(raw)).map((sample) => ({ ...sample, message: normalize(sample.message) }))
    const twice = await maskEach(normalised)
    return new Map(twice.map((sample, index) => [plan[index].signature, sample]))
  }

  async function read(role: Role): Promise<void> {
    const { instances } = await ctx.b2c.instances()
    if (instances[role] !== 'ready') return
    const settings = await rawSettings()
    const cursor = cursorOf(await ctx.store.get<SeenJson>(cursorKey(role), null))
    const since = cursor?.at != null ? cursor.at - OVERLAP_MS : now() - FIRST_READ_MS
    const filters = filtersOf(settings[SETTING_FILTER])
    // The files' sizes first: growth during the read then counts at the next one, never lost.
    let sizes: Map<string, { size: number; modified: number | null }> | null = null
    try {
      sizes = fileSizesOf((await ctx.b2c.run(listArguments(filters), { role, timeoutMs: READ_TIMEOUT_MS })).json)
    } catch (error) {
      ctx.log(`listing the ${role} log files failed: ${error instanceof B2cError ? error.code : 'error'}`)
    }
    let json: unknown
    try {
      json = (await ctx.b2c.run(readArguments(filters, since), { role, timeoutMs: READ_TIMEOUT_MS })).json
    } catch (error) {
      const code = error instanceof B2cError ? error.code : 'b2c_failed'
      ctx.log(`reading the ${role} log failed: ${code}`)
      await ctx.store.set(statusKey(role), { ...(await readStatus(role)), error: code })
      return
    }
    const all = parseLogEntries(json, { levels: ERROR_LEVELS })
    // An entry at or before the newest one read from its own file was counted by an earlier read;
    // a file not read before has nothing counted since the read's start.
    const entries = all.filter((entry) => !cursor || entry.timestamp > (cursor.files[entry.file] ?? since))
    const occurrences: { signature: string; at: number }[] = []
    const newest = new Map<string, ParsedMessage>()
    for (const entry of entries) {
      const parsed = parseMessage(entry.message)
      const signature = signatureOfIdentity(identityOf(parsed))
      occurrences.push({ signature, at: entry.timestamp })
      // Entries come oldest first: the last one of a signature is its newest.
      newest.set(signature, parsed)
    }
    const samples = await maskedSamples(newest)
    const recorded: Occurrence[] = occurrences.map(({ signature, at }) => ({ signature, at, sample: samples.get(signature) as Sample }))
    const { added } = await seen.record(role, recorded)

    if (all.length > 0 || sizes !== null) {
      const newestAt = all.length > 0 ? Math.max(cursor?.at ?? 0, ...all.map((entry) => entry.timestamp)) : (cursor?.at ?? null)
      const files: Record<string, number> = {}
      const keepAfter = (newestAt ?? now()) - FILE_CURSOR_MS
      for (const [file, at] of Object.entries(cursor?.files ?? {})) if (at >= keepAfter) files[file] = at
      for (const entry of all) files[entry.file] = Math.max(files[entry.file] ?? 0, entry.timestamp)
      // The sizes of the files listed now; a failed listing keeps the last ones.
      const fileSizes = sizes ? Object.fromEntries([...sizes].map(([name, { size }]) => [name, size])) : (cursor?.sizes ?? {})
      await ctx.store.set(cursorKey(role), { at: newestAt, files, sizes: fileSizes })
    }
    // b2c kept at most MAX_ENTRIES, and read only the end of each file: any cut means entries
    // since the last read may never be seen. It is said in the view, never notified.
    const bytesPerFile = new Map<string, number>()
    for (const entry of all) bytesPerFile.set(entry.file, (bytesPerFile.get(entry.file) ?? 0) + entry.bytes)
    const cut =
      returnedCount(json) >= MAX_ENTRIES ||
      [...bytesPerFile.values()].some((bytes) => bytes >= FULL_WINDOW_BYTES) ||
      (sizes !== null && outgrewWindow(cursor?.sizes ?? {}, sizes, since))
    await ctx.store.set(statusKey(role), { lastRead: now(), error: null, missedSince: cut ? (cursor?.at ?? since) : null })
    if (cut) ctx.log(`the ${role} read may have missed entries`)
    if (added.length > 0 && !stopped) {
      const name = ctx.t(messages, ROLE_KEYS[role])
      try {
        await ctx.orca.host.call('notifications.show', {
          title: ctx.t(messages, 'notifyTitle', { role: name }),
          body: added.length === 1 ? ctx.t(messages, 'notifyBodyOne') : ctx.t(messages, 'notifyBody', { count: added.length })
        })
      } catch {
        // A notification that cannot be shown changes nothing: the view and the counter say it.
      }
    }
  }

  /** Reads a role's log now, or joins the read already running. */
  function refresh(role: Role): Promise<void> {
    const running = reads.get(role)
    if (running) return running
    const reading = (async () => {
      try {
        await read(role)
      } catch (error) {
        ctx.log(`reading the ${role} log failed: ${error instanceof B2cError ? error.code : 'error'}`)
      } finally {
        reads.delete(role)
        await changed(role).catch(() => undefined)
      }
    })()
    reads.set(role, reading)
    void changed(role).catch(() => undefined)
    return reading
  }

  async function list(role: Role): Promise<RoleErrors> {
    // Taken first: an answer that says it is not reading holds nothing older than the last read.
    const reading = reads.has(role)
    const [{ instances }, rows, status, settings, root] = await Promise.all([ctx.b2c.instances(), seen.list(role), readStatus(role), rawSettings(), frameRoot()])
    const out: ErrorRow[] = []
    for (const row of rows) {
      const rowFrames = await Promise.all(
        row.sample.frames.map(async (frame) => ({ ...frame, openable: root !== null && (await frames.resolve(root, frame.file).catch(() => null)) !== null }))
      )
      out.push({
        signature: row.signature,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        count: row.count,
        markedAt: row.markedAt ?? null,
        message: row.sample.message,
        logger: row.sample.logger,
        frames: rowFrames
      })
    }
    return {
      role,
      state: instances[role],
      reading,
      lastRead: status.lastRead,
      error: status.error,
      missedSince: status.missedSince,
      intervalMinutes: role === 'sandbox' ? intervalOf(settings[SETTING_INTERVAL]) : 0,
      rows: out
    }
  }

  async function open(role: Role, signature: unknown, index: unknown): Promise<OpenFrameResult> {
    if (typeof signature !== 'string' || typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw invalid()
    const row = (await seen.list(role)).find((candidate) => candidate.signature === signature)
    const frame = row?.sample.frames[index]
    if (!frame) return { opened: false, reason: 'not_found' }
    const root = await frameRoot()
    if (root === null) return { opened: false, reason: 'no_workspace' }
    const path = await frames.resolve(root, frame.file)
    if (path === null) return { opened: false, reason: 'not_in_workspace' }
    // The person pressed the link to see the file: it is brought forward.
    const result = await openFile({ root, path, line: frame.line ?? undefined, focus: true })
    return result.opened ? { opened: true } : { opened: false, reason: result.reason }
  }

  // The sandbox's timer. A tick reads, then schedules the next one, so two never overlap; a
  // change of the setting starts a new generation and the old one stops at its next step.
  let timer: unknown = null
  let generation = 0
  async function schedule(delayMs?: number): Promise<void> {
    const mine = ++generation
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    const minutes = intervalOf((await rawSettings())[SETTING_INTERVAL])
    if (stopped || mine !== generation || minutes === 0) return
    timer = setTimer(() => void tick(mine), delayMs ?? minutes * 60_000)
  }
  async function tick(mine: number): Promise<void> {
    timer = null
    if (stopped || mine !== generation) return
    await refresh('sandbox')
    if (!stopped && mine === generation) await schedule()
  }

  const disposables: Disposable[] = [
    ctx.orca.panels.handle('errors.list', (input) => list(roleOf(input))),
    ctx.orca.panels.handle('errors.refresh', (input) => {
      const role = roleOf(input)
      // Started, not awaited: the answer says it is reading, and `errors.changed` brings the rest.
      void refresh(role)
      return list(role)
    }),
    ctx.orca.panels.handle('errors.mark', async (input) => {
      const role = roleOf(input)
      const signatures = (input as { signatures?: unknown }).signatures
      if (!Array.isArray(signatures) || !signatures.every((signature) => typeof signature === 'string')) throw invalid()
      await seen.mark(role, signatures, now())
      await changed(role)
      return list(role)
    }),
    ctx.orca.panels.handle('errors.forget', async (input) => {
      const role = roleOf(input)
      const signature = (input as { signature?: unknown }).signature
      if (typeof signature !== 'string') throw invalid()
      await seen.forget(role, signature)
      await changed(role)
      return list(role)
    }),
    ctx.orca.panels.handle('errors.open', (input) => {
      const role = roleOf(input)
      const { signature, frame } = input as { signature?: unknown; frame?: unknown }
      return open(role, signature, frame)
    }),
    ctx.settings.onDidChange((key) => {
      if (key === SETTING_INTERVAL) void schedule()
    })
  ]

  void updateStatusBar()
  void schedule(START_DELAY_MS)

  return {
    dispose() {
      stopped = true
      generation++
      if (timer !== null) clearTimer(timer)
      timer = null
      for (const disposable of disposables) disposable.dispose()
    }
  }
}

export const piece: WorkerPiece = createErrorsPiece()
