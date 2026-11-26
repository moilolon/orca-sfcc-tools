// The errors piece's worker half, listed in src/worker/pieces.ts: reads each environment's log
// with `b2c logs get`, keeps a seen list per environment (seen.ts) keyed by signature
// (signature.ts), and tells the person what is new: a notification with how many, the sandbox's
// count on the status bar, and the section's view.
//
// The sandbox is read on a timer (Settings, in minutes; 0, the default, is off), the other three
// only when a person asks. Two reads of one environment never overlap: asking during a read joins
// it. Each read asks for the entries since the newest one already read (`cursor.<role>`), at most
// `MAX_ENTRIES`, error-level files only (`--filter`, a setting). What is stored, in the plugin's
// own storage: per signature its counters and one bounded sample, masked; never a raw entry.
import { B2cError } from '../../core/b2c'
import { isRole, type Role } from '../../core/instances'
import { createOpenFile, type OpenFile } from '../../core/open-file'
import type { Disposable, PieceContext, WorkerPiece } from '../../core/piece'
import { isLocal } from '../../core/workspaces'
import { createFrameResolver, type FrameResolver } from './frames'
import { messages, ROLE_KEYS } from './i18n'
import type { ErrorRow, OpenFrameResult, RoleErrors } from './protocol'
import { filtersOf, parseLogEntries, parseMessage, type ParsedMessage } from './reader'
import { createSeenList, type Occurrence, type Sample, type SeenJson, type SeenStore } from './seen'
import { identityOf, normalize, signatureOfIdentity } from './signature'

/** The most entries one read asks for. */
export const MAX_ENTRIES = 200
/** How far back the first read of an environment looks. */
export const FIRST_READ_MS = 24 * 60 * 60 * 1000
/** How long after the worker starts the timer's first read runs. */
export const START_DELAY_MS = 5_000
// Under the 120 s a panel request may wait, so a read the panel asked for answers in time.
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

type ReadStatus = { lastRead: number | null; error: string | null }

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

/** The arguments of one read: error-level files since `since`, at most `MAX_ENTRIES`. */
export function readArguments(filters: readonly string[], since: number): string[] {
  // `--no-normalize`: the frames keep the instance's own script paths, so a signature does not
  // depend on the checkout, and no local path reaches the sample.
  return ['logs', 'get', '--no-normalize', ...filters.map((filter) => `--filter=${filter}`), `--count=${MAX_ENTRIES}`, `--since=${new Date(since).toISOString()}`]
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
      error: typeof stored.error === 'string' ? stored.error : null
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

  /** The samples of the newest entry of each signature, masked: one call to `mask` for all. */
  async function maskedSamples(newest: Map<string, ParsedMessage>): Promise<Map<string, Sample>> {
    const texts: string[] = []
    const take = (text: string) => texts.push(text.replace(/[\r\n]+/g, ' ')) - 1
    const plan = [...newest].map(([signature, parsed]) => {
      const identity = identityOf(parsed)
      return {
        signature,
        message: take(parsed.text),
        logger: identity.logger === null ? null : take(identity.logger),
        frames: identity.frames.map((frame) => ({ file: take(frame.file), function: frame.function === null ? null : take(frame.function), line: frame.line }))
      }
    })
    const masked = (await ctx.b2c.mask(texts.join('\n'))).split('\n')
    const at = (index: number) => masked[index] ?? ''
    return new Map(
      plan.map((item) => [
        item.signature,
        {
          // Masked first, then normalised: a host in the text is masked whole before its digits go.
          message: normalize(at(item.message)),
          logger: item.logger === null ? null : at(item.logger),
          frames: item.frames.map((frame) => ({ file: at(frame.file), function: frame.function === null ? null : at(frame.function), line: frame.line }))
        }
      ])
    )
  }

  async function read(role: Role): Promise<void> {
    const { instances } = await ctx.b2c.instances()
    if (instances[role] !== 'ready') return
    const settings = await rawSettings()
    const cursor = await ctx.store.get<number | null>(cursorKey(role), null)
    const since = typeof cursor === 'number' ? cursor : now() - FIRST_READ_MS
    let json: unknown
    try {
      json = (await ctx.b2c.run(readArguments(filtersOf(settings[SETTING_FILTER]), since), { role, timeoutMs: READ_TIMEOUT_MS })).json
    } catch (error) {
      const code = error instanceof B2cError ? error.code : 'b2c_failed'
      ctx.log(`reading the ${role} log failed: ${code}`)
      await ctx.store.set(statusKey(role), { ...(await readStatus(role)), error: code })
      return
    }
    // An entry at or before the cursor was counted by an earlier read.
    const entries = parseLogEntries(json).filter((entry) => typeof cursor !== 'number' || entry.timestamp > cursor)
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
    if (entries.length > 0) await ctx.store.set(cursorKey(role), entries[entries.length - 1].timestamp)
    await ctx.store.set(statusKey(role), { lastRead: now(), error: null })
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
      reading: reads.has(role),
      lastRead: status.lastRead,
      error: status.error,
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
    ctx.orca.panels.handle('errors.refresh', async (input) => {
      const role = roleOf(input)
      await refresh(role)
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
