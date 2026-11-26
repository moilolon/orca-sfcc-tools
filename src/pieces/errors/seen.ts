// The seen list: per environment, every signature met, with its counters and one bounded sample.
// New means not marked. Marking moves a signature to seen for good: more occurrences raise its
// count but never make it new again, unless a person forgets it, which drops it from the list.
// The lists of two environments are independent.
//
// Pure over the store it is given: no Orca or Node import, so the command line of phase 4 runs it
// outside Orca over a store of its own. What is kept per signature is its counters and a sample
// (the normalised first line, the logger and the top frames), each cut to a bound: never a raw
// log entry. The caller masks the sample before it is recorded.

/** The part of a store the list needs: the plugin's own `Store` is one. */
export type SeenStore = {
  get<T extends SeenJson>(key: string, fallback: T): Promise<T>
  set(key: string, value: SeenJson): Promise<void>
}

/** A JSON value, as a store keeps it. */
export type SeenJson = string | number | boolean | null | SeenJson[] | { [key: string]: SeenJson }

export type SampleFrame = { file: string; function: string | null; line: number | null }

/** One occurrence's identity, as kept: bounded by `boundSample`. */
export type Sample = { message: string; logger: string | null; frames: SampleFrame[] }

export type SeenRecord = {
  /** Milliseconds since the epoch, of the oldest and the newest occurrence read. */
  firstSeen: number
  lastSeen: number
  count: number
  /** When a person marked it as seen; absent while it is new. */
  markedAt?: number
  /** The newest occurrence's sample. */
  sample: Sample
}

export type SeenRow = SeenRecord & { signature: string }

/** An occurrence to record: its signature, when it happened and its sample. */
export type Occurrence = { signature: string; at: number; sample: Sample }

/** The bounds of what is kept. */
export const LIMITS = {
  /** Signatures kept per environment; past it, the ones seen longest ago go first, seen ones before new ones. */
  signatures: 500,
  message: 300,
  logger: 120,
  frames: 5,
  file: 240,
  function: 120
} as const

function cut(text: unknown, max: number): string {
  return typeof text === 'string' ? text.slice(0, max) : ''
}

/** A sample cut to `LIMITS`, holding only its own fields. */
export function boundSample(sample: Sample): Sample {
  const frames = Array.isArray(sample.frames) ? sample.frames.slice(0, LIMITS.frames) : []
  return {
    message: cut(sample.message, LIMITS.message),
    logger: typeof sample.logger === 'string' ? cut(sample.logger, LIMITS.logger) : null,
    frames: frames.map((frame) => ({
      file: cut(frame.file, LIMITS.file),
      function: typeof frame.function === 'string' ? cut(frame.function, LIMITS.function) : null,
      line: typeof frame.line === 'number' && Number.isInteger(frame.line) && frame.line > 0 ? frame.line : null
    }))
  }
}

type Table = Record<string, SeenRecord>

/** The key a role's list is stored under. */
export function listKey(role: string): string {
  return `seen.${role}`
}

/** New first, then by the newest occurrence. */
function ordered(table: Table): SeenRow[] {
  return Object.entries(table)
    .map(([signature, record]) => ({ signature, ...record }))
    .sort((a, b) => Number(a.markedAt !== undefined) - Number(b.markedAt !== undefined) || b.lastSeen - a.lastSeen || a.signature.localeCompare(b.signature))
}

/** Drops the signatures past `LIMITS.signatures`: seen ones before new ones, the oldest first. */
function trim(table: Table): Table {
  const rows = Object.entries(table)
  if (rows.length <= LIMITS.signatures) return table
  rows.sort(([, a], [, b]) => Number(b.markedAt === undefined) - Number(a.markedAt === undefined) || b.lastSeen - a.lastSeen)
  return Object.fromEntries(rows.slice(0, LIMITS.signatures))
}

export type SeenList = {
  /** The role's signatures, new first, then by the newest occurrence. */
  list(role: string): Promise<SeenRow[]>
  /**
   * Records occurrences: one row per signature, its count raised by each occurrence. Answers the
   * signatures that were not in the list before.
   */
  record(role: string, occurrences: readonly Occurrence[]): Promise<{ added: string[] }>
  /** Marks signatures as seen at `at`; one already marked keeps its first mark. */
  mark(role: string, signatures: readonly string[], at: number): Promise<void>
  /** Drops a signature from the list: its next occurrence is new again. */
  forget(role: string, signature: string): Promise<void>
  /** How many of the role's signatures are new. */
  newCount(role: string): Promise<number>
}

export function createSeenList(store: SeenStore): SeenList {
  // Changes to one role's list run one after the other, so a mark during a read is not lost.
  const queues = new Map<string, Promise<unknown>>()
  function serial<T>(role: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(role) ?? Promise.resolve()
    const next = previous.then(work, work)
    queues.set(
      role,
      next.catch(() => undefined)
    )
    return next
  }
  const load = async (role: string): Promise<Table> => {
    const value = await store.get<SeenJson>(listKey(role), {})
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as unknown as Table) : {}
  }
  const save = (role: string, table: Table) => store.set(listKey(role), table as unknown as SeenJson)

  return {
    list: (role) => serial(role, async () => ordered(await load(role))),
    record: (role, occurrences) =>
      serial(role, async () => {
        const table = await load(role)
        const added: string[] = []
        for (const { signature, at, sample } of occurrences) {
          const known = table[signature]
          if (!known) {
            table[signature] = { firstSeen: at, lastSeen: at, count: 1, sample: boundSample(sample) }
            added.push(signature)
            continue
          }
          known.count += 1
          known.firstSeen = Math.min(known.firstSeen, at)
          if (at >= known.lastSeen) {
            known.lastSeen = at
            known.sample = boundSample(sample)
          }
        }
        const kept = trim(table)
        await save(role, kept)
        return { added: added.filter((signature) => signature in kept) }
      }),
    mark: (role, signatures, at) =>
      serial(role, async () => {
        const table = await load(role)
        for (const signature of signatures) {
          const known = table[signature]
          if (known && known.markedAt === undefined) known.markedAt = at
        }
        await save(role, table)
      }),
    forget: (role, signature) =>
      serial(role, async () => {
        const table = await load(role)
        if (!(signature in table)) return
        delete table[signature]
        await save(role, table)
      }),
    newCount: (role) => serial(role, async () => Object.values(await load(role)).filter((record) => record.markedAt === undefined).length)
  }
}
