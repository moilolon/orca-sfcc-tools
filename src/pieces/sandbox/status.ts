// The state of the sandbox, read from `b2c sandbox list`: the entry whose `hostName` is the
// sandbox role's host (`isHost`), never `sandbox get`, which can answer with a deleted record that
// shares the live one's id. Start and stop are fired with the id the list gave, without waiting on
// b2c, and followed on the list at a modest interval until the state settles or a timeout passes.
// A list that is refused leaves the state unknown and breaks nothing else.
import { B2cError, type B2c } from '../../core/b2c'
import type { SandboxAction, SandboxState, SandboxStatus } from './protocol'

/** How often a start or stop is followed on the list, and for how long at most. */
export const FOLLOW_INTERVAL_MS = 15_000
export const FOLLOW_TIMEOUT_MS = 15 * 60_000

/** What `sandbox list` may take. */
const LIST_TIMEOUT_MS = 60_000

/** The states of the ODS API, in the four the plugin shows. */
export function stateOf(raw: unknown): SandboxState {
  switch (raw) {
    case 'started':
      return 'started'
    case 'stopped':
      return 'stopped'
    case 'new':
    case 'creating':
    case 'starting':
    case 'stopping':
    case 'resetting':
    case 'upgrading':
    case 'deleting':
      return 'busy'
    default:
      // failed, unknown, deleted, or anything newer than this list.
      return 'unknown'
  }
}

/** The code of a failure: a B2cError's, else `action_failed`. */
export function codeOf(error: unknown): string {
  if (error instanceof B2cError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') return (error as { code: string }).code
  return 'action_failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The entries of a `sandbox list` answer: `{ data: [...] }`, or a bare list. */
function entriesOf(json: unknown): Record<string, unknown>[] {
  const list = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.data) ? json.data : []
  return list.filter(isRecord)
}

function isDeleted(entry: Record<string, unknown>): boolean {
  return entry.state === 'deleted' || (entry.deletedAt !== undefined && entry.deletedAt !== null)
}

/**
 * The live entry of the sandbox role in a `sandbox list` answer: its host matches, it is not a
 * deleted record, and among several the newest. Null when the list holds no such entry.
 */
export async function findSandbox(b2c: Pick<B2c, 'isHost'>, json: unknown): Promise<{ id: string; state: string } | null> {
  const matches: Record<string, unknown>[] = []
  for (const entry of entriesOf(json)) {
    if (!isDeleted(entry) && typeof entry.id === 'string' && (await b2c.isHost('sandbox', entry.hostName))) matches.push(entry)
  }
  if (matches.length === 0) return null
  const created = (entry: Record<string, unknown>) => (typeof entry.createdAt === 'string' ? Date.parse(entry.createdAt) || 0 : 0)
  const newest = matches.reduce((best, entry) => (created(entry) > created(best) ? entry : best))
  return { id: newest.id as string, state: typeof newest.state === 'string' ? newest.state : 'unknown' }
}

/** An id b2c can be given as it is: what the ODS API uses (a UUID) or `realm-instance`. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export type Timers = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const REAL_TIMERS: Timers = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms)
    // A pending poll must never keep a test or a check alive.
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export type SandboxWatchDeps = {
  b2c: B2c
  timers: Timers
  /** Something the section shows changed. */
  onChange(): void
  /** A start, stop or list failed (`code`), or worked again (null). */
  onProblem(action: SandboxAction, code: string | null): void
}

export class SandboxWatch {
  private state: SandboxState = 'unknown'
  private reason: string | null = null
  private checkedAt: number | null = null
  /** The id the list gave the live sandbox; only ever handed back to b2c, never shown. */
  private id: string | null = null
  private following: { verb: 'start' | 'stop'; since: number } | null = null
  private timer: unknown = null
  private reading: Promise<void> | null = null
  private disposed = false

  constructor(private readonly deps: SandboxWatchDeps) {}

  snapshot(): SandboxStatus['sandbox'] {
    return { state: this.state, following: this.following?.verb ?? null, reason: this.reason, checkedAt: this.checkedAt }
  }

  /** The state when the sandbox role cannot run anything: unknown, with why. */
  notReady(reason: string): void {
    this.state = 'unknown'
    this.reason = reason
    this.id = null
    this.deps.onChange()
  }

  /** Reads the list again; one read at a time, a second caller shares it. */
  refresh(): Promise<void> {
    if (!this.reading) this.reading = this.read().finally(() => (this.reading = null))
    return this.reading
  }

  private async read(): Promise<void> {
    try {
      const { json } = await this.deps.b2c.run(['sandbox', 'list'], { role: 'sandbox', timeoutMs: LIST_TIMEOUT_MS })
      const found = await findSandbox(this.deps.b2c, json)
      this.checkedAt = this.deps.timers.now()
      this.deps.onProblem('status', null)
      if (!found) {
        this.id = null
        this.state = 'unknown'
        this.reason = 'sandbox_not_listed'
        this.following = null
      } else {
        this.id = found.id
        this.reason = null
        this.settle(stateOf(found.state), found.state)
      }
    } catch (error) {
      this.state = 'unknown'
      this.reason = codeOf(error)
      this.deps.onProblem('status', this.reason)
    }
    if (!this.disposed) this.deps.onChange()
  }

  /** The state the list gave, seen through a start or stop being followed. */
  private settle(listed: SandboxState, raw: string): void {
    if (!this.following) {
      this.state = listed
      return
    }
    const target = this.following.verb === 'start' ? 'started' : 'stopped'
    if (listed === target) {
      this.following = null
      this.state = listed
    } else if (raw === 'failed' || raw === 'deleted') {
      this.following = null
      this.state = 'unknown'
      this.reason = raw === 'failed' ? 'sandbox_failed' : 'sandbox_not_listed'
    } else {
      // Until the operation shows on the list, the old state is still listed: the sandbox is busy.
      this.state = 'busy'
    }
  }

  /**
   * Fires `sandbox start` or `stop` and follows it on the list. Throws, before running anything,
   * when the sandbox was not found, is busy or is already in that state.
   */
  async fire(verb: 'start' | 'stop'): Promise<void> {
    if (this.following || this.state === 'busy') throw new SandboxError('sandbox_busy')
    if (!this.id || this.state === 'unknown') throw new SandboxError('sandbox_not_listed')
    if (verb === 'start' && this.state === 'started') throw new SandboxError('sandbox_already_started')
    if (verb === 'stop' && this.state === 'stopped') throw new SandboxError('sandbox_already_stopped')
    const id = this.id
    if (!SAFE_ID.test(id)) throw new SandboxError('sandbox_not_listed')
    this.following = { verb, since: this.deps.timers.now() }
    this.state = 'busy'
    this.deps.onChange()
    // Not awaited: the operation is followed on the list, never on b2c.
    void this.deps.b2c.run(['sandbox', verb, id], { role: 'sandbox', timeoutMs: LIST_TIMEOUT_MS }).then(
      () => this.deps.onProblem(verb, null),
      (error) => {
        if (this.following?.verb !== verb) return
        this.following = null
        this.deps.onProblem(verb, codeOf(error))
        void this.refresh()
      }
    )
    this.schedule()
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer)
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = null
      void this.follow()
    }, FOLLOW_INTERVAL_MS)
  }

  private async follow(): Promise<void> {
    const current = this.following
    if (!current || this.disposed) return
    await this.refresh()
    if (!this.following) return
    if (this.deps.timers.now() - current.since >= FOLLOW_TIMEOUT_MS) {
      this.following = null
      this.deps.onProblem(current.verb, 'sandbox_follow_timeout')
      await this.refresh()
      return
    }
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.following = null
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer)
    this.timer = null
  }
}

/** A refusal of the piece's own, carried like the runner's errors: its code and nothing else. */
export class SandboxError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SandboxError'
  }
}
