// The state of the sandbox, read from `b2c sandbox list`: the entry whose `hostName` is the
// sandbox role's host (`isHost`), never `sandbox get`, which can answer with a deleted record that
// shares the live one's id. Start and stop are fired with the id the list gave, without waiting on
// b2c, and followed on the list at a modest interval until the state settles or a timeout passes.
// A start or stop takes the configuration in force when it is asked: the folder whose dw.json is
// read (`configRoot`), and the id the list gives under it, read again when the last list was made
// with another one. Every b2c call of its follow names that folder, and the follow matches the
// sandbox by that id, so focusing another workspace never loses it; an answer made with another
// configuration (a list already running when it was asked) does not count for it. Nothing global
// changes: other pieces, and this one when nothing is followed, read the dw.json of the moment.
// A list that is refused leaves the state unknown and breaks nothing else.
import { B2cError, type B2c, type ConfigChoice } from '../../core/b2c'
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
 * The live entry of the sandbox role in a `sandbox list` answer: its host matches (in the dw.json
 * `choice` names), it is not a deleted record, it has `id` when one is given, and among several the
 * newest. Null when the list holds no such entry.
 */
export async function findSandbox(b2c: Pick<B2c, 'isHost'>, json: unknown, choice: ConfigChoice = {}, id?: string): Promise<{ id: string; state: string } | null> {
  const matches: Record<string, unknown>[] = []
  for (const entry of entriesOf(json)) {
    if (isDeleted(entry) || typeof entry.id !== 'string' || (id !== undefined && entry.id !== id)) continue
    if (await b2c.isHost('sandbox', entry.hostName, choice)) matches.push(entry)
  }
  if (matches.length === 0) return null
  const created = (entry: Record<string, unknown>) => (typeof entry.createdAt === 'string' ? Date.parse(entry.createdAt) || 0 : 0)
  const newest = matches.reduce((best, entry) => (created(entry) > created(best) ? entry : best))
  return { id: newest.id as string, state: typeof newest.state === 'string' ? newest.state : 'unknown' }
}

/** The option that names `root` to b2c; none when the choice is left to the runner. */
function choiceOf(root: string | null | undefined): ConfigChoice {
  return root === undefined ? {} : { configRoot: root }
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
  /**
   * The folder whose dw.json is in force now, as the runner would read it. Without it, every call
   * leaves the choice to the runner.
   */
  configRoot?(): Promise<string | null>
}

/** A folder named for b2c, or `undefined`: the runner's own choice. */
type Root = string | null | undefined

/** A start or stop being followed: the configuration it was asked with, carried to its end. */
type Following = { verb: 'start' | 'stop'; since: number; root: Root; id: string }

export class SandboxWatch {
  private state: SandboxState = 'unknown'
  private reason: string | null = null
  private checkedAt: number | null = null
  /** The id the list gave the live sandbox; only ever handed back to b2c, never shown. */
  private id: string | null = null
  /** The folder whose dw.json the list that gave `id` was read with. */
  private idRoot: Root = undefined
  private following: Following | null = null
  private timer: unknown = null
  private reading: Promise<void> | null = null
  private disposed = false

  constructor(private readonly deps: SandboxWatchDeps) {}

  snapshot(): SandboxStatus['sandbox'] {
    return { state: this.state, following: this.following?.verb ?? null, reason: this.reason, checkedAt: this.checkedAt }
  }

  /** Whether a start or stop is followed: its reads then use its own configuration. */
  isFollowing(): boolean {
    return this.following !== null
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

  /** The folder whose dw.json is in force now; `undefined` leaves it to the runner. */
  private async currentRoot(): Promise<Root> {
    return this.deps.configRoot ? await this.deps.configRoot() : undefined
  }

  /** Lists the sandboxes with the dw.json of `root`, and finds ours (by `id` too, when given). */
  private async list(root: Root, id?: string): Promise<{ id: string; state: string } | null> {
    const choice = choiceOf(root)
    const { json } = await this.deps.b2c.run(['sandbox', 'list'], { role: 'sandbox', timeoutMs: LIST_TIMEOUT_MS, ...choice })
    return findSandbox(this.deps.b2c, json, choice, id)
  }

  /**
   * One read of the list: with the follow's configuration while one is followed, else with the
   * one in force now. An answer that comes back while a follow with another configuration runs
   * does not count: it was not made with the follow's dw.json.
   */
  private async read(): Promise<void> {
    const follow = this.following
    const root = follow ? follow.root : await this.currentRoot()
    const counts = () => !this.following || this.following.root === root
    try {
      const found = await this.list(root, follow?.id)
      if (!counts()) return
      this.checkedAt = this.deps.timers.now()
      this.deps.onProblem('status', null)
      this.apply(found, root)
    } catch (error) {
      if (!counts()) return
      this.state = 'unknown'
      this.reason = codeOf(error)
      this.deps.onProblem('status', this.reason)
    }
    if (!this.disposed) this.deps.onChange()
  }

  /** What a list made with the dw.json of `root` found. */
  private apply(found: { id: string; state: string } | null, root: Root): void {
    if (!found) {
      this.id = null
      this.idRoot = undefined
      this.state = 'unknown'
      this.reason = 'sandbox_not_listed'
      this.stopFollowing()
    } else {
      this.id = found.id
      this.idRoot = root
      this.reason = null
      this.settle(stateOf(found.state), found.state)
    }
  }

  /** The state the list gave, seen through a start or stop being followed. */
  private settle(listed: SandboxState, raw: string): void {
    if (!this.following) {
      this.state = listed
      return
    }
    const target = this.following.verb === 'start' ? 'started' : 'stopped'
    if (listed === target) {
      this.stopFollowing()
      this.state = listed
    } else if (raw === 'failed' || raw === 'deleted') {
      this.stopFollowing()
      this.state = 'unknown'
      this.reason = raw === 'failed' ? 'sandbox_failed' : 'sandbox_not_listed'
    } else {
      // Until the operation shows on the list, the old state is still listed: the sandbox is busy.
      this.state = 'busy'
    }
  }

  /**
   * Fires `sandbox start` or `stop` with the configuration in force now and follows it on the list
   * with that configuration. Throws, before running anything, when the sandbox was not found, is
   * busy or is already in that state. When the last list was made with another dw.json, the list
   * is read again with this one first, so the id fired is the one this dw.json names.
   */
  async fire(verb: 'start' | 'stop'): Promise<void> {
    if (this.following) throw new SandboxError('sandbox_busy')
    const root = await this.currentRoot()
    if (this.following) throw new SandboxError('sandbox_busy')
    let id = this.id
    let state = this.state
    if (this.idRoot !== root) {
      let found: { id: string; state: string } | null
      try {
        found = await this.list(root)
      } catch (error) {
        throw new SandboxError(codeOf(error))
      }
      if (this.following) throw new SandboxError('sandbox_busy')
      this.checkedAt = this.deps.timers.now()
      this.apply(found, root)
      this.deps.onChange()
      id = found?.id ?? null
      state = found ? stateOf(found.state) : 'unknown'
    }
    if (state === 'busy') throw new SandboxError('sandbox_busy')
    if (!id || state === 'unknown') throw new SandboxError('sandbox_not_listed')
    if (verb === 'start' && state === 'started') throw new SandboxError('sandbox_already_started')
    if (verb === 'stop' && state === 'stopped') throw new SandboxError('sandbox_already_stopped')
    if (!SAFE_ID.test(id)) throw new SandboxError('sandbox_not_listed')
    const following: Following = { verb, since: this.deps.timers.now(), root, id }
    this.following = following
    this.state = 'busy'
    this.deps.onChange()
    // Not awaited: the operation is followed on the list, never on b2c.
    void this.deps.b2c.run(['sandbox', verb, id], { role: 'sandbox', timeoutMs: LIST_TIMEOUT_MS, ...choiceOf(root) }).then(
      () => this.deps.onProblem(verb, null),
      (error) => {
        if (this.following !== following) return
        this.stopFollowing()
        this.deps.onProblem(verb, codeOf(error))
        void this.refresh()
      }
    )
    this.schedule()
  }

  /** Ends following a start or stop. */
  private stopFollowing(): void {
    this.following = null
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
      this.stopFollowing()
      this.deps.onProblem(current.verb, 'sandbox_follow_timeout')
      await this.refresh()
      return
    }
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.stopFollowing()
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
