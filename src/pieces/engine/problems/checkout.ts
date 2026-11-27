// The problems of a whole checkout, kept per file. A pass (`run`) reads again only the files that
// changed (every file of interest after a build, each file's time compared; after an update, the
// paths it named), then checks every file kept against the checkout as it is now: what a file
// names is read when it changes, but whether it exists can change with any other file. Reading
// pauses now and then (`pause`), so the worker answers requests during a long pass. Pure: no Node,
// no Orca; files are read through `CheckoutFiles`.
import type { CheckoutIndex } from '../checkout/checkout'
import { isUnder, type CheckoutFiles } from '../checkout/files'
import type { DwIndex } from '../dw/index'
import { checkUses, problemFileKind, readUses, type FileUses } from './analyse'
import { Lookup } from './lookup'
import { countProblems, emptyCounts, SEVERITIES, type Problem, type ProblemCounts } from './problem'
import type { StepTypeIds } from './steptypes'

/** How long a pass works before it pauses, so requests waiting on the worker are answered. */
export const SLICE_MS = 25

type FileRecord = { time: number | null; uses: FileUses }

export type ProblemsOptions = {
  /** Hands the worker back for a moment; resolves when it may go on. */
  pause?: () => Promise<void>
  now?: () => number
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export class CheckoutProblems {
  private readonly index: CheckoutIndex
  private readonly files: CheckoutFiles
  private readonly dw: () => DwIndex | null
  private readonly pause: () => Promise<void>
  private readonly now: () => number
  private readonly records = new Map<string, FileRecord>()
  /** The files with problems, each with its problems. */
  private results = new Map<string, Problem[]>()
  private lookupCache: Lookup | null = null

  constructor(index: CheckoutIndex, files: CheckoutFiles, dw: () => DwIndex | null, options: ProblemsOptions = {}) {
    this.index = index
    this.files = files
    this.dw = dw
    this.pause = options.pause ?? (() => Promise.resolve())
    this.now = options.now ?? (() => Date.now())
  }

  /** What the checks read of the index, read again when the index changed. */
  lookup(): Lookup {
    if (!this.lookupCache || this.lookupCache.generation !== this.index.generation) this.lookupCache = new Lookup(this.index)
    return this.lookupCache
  }

  private kindOf(lookup: Lookup, path: string) {
    return problemFileKind(path, lookup.cartridgeOf(path)?.root ?? null)
  }

  private stepTypeIds(): StepTypeIds {
    const ids = new Map<string, { id: string; start: number; end: number; line: number; column: number }[]>()
    for (const [path, record] of this.records) if (record.uses.kind === 'steptypes') ids.set(path, record.uses.ids)
    return ids
  }

  /**
   * One pass: reads again the files of interest among `changed` (every one when null) whose time
   * changed, drops the files the index no longer has, then checks every file kept. Answers each
   * file's problems before the pass, for the files read again (to tell what is new).
   */
  async run(changed: readonly string[] | null): Promise<Map<string, Problem[]>> {
    const lookup = this.lookup()
    const targets = new Set<string>()
    for (const path of this.index.filePaths()) if (this.kindOf(lookup, path)) targets.add(path)
    for (const path of [...this.records.keys()]) if (!targets.has(path)) this.records.delete(path)
    const reading = changed === null ? [...targets] : [...targets].filter((path) => !this.records.has(path) || changed.some((each) => path === each || isUnder(path, each)))
    const before = new Map<string, Problem[]>()
    let slice = this.now()
    const ctx = { index: this.index, dw: this.dw() }
    for (const path of reading) {
      if (this.now() - slice >= SLICE_MS) {
        await this.pause()
        slice = this.now()
      }
      const kind = this.kindOf(lookup, path)
      if (!kind) continue
      const time = await this.files.time(path)
      const known = this.records.get(path)
      if (known && time !== null && known.time === time) continue
      const text = time === null ? null : await this.files.read(path)
      if (text === null) {
        this.records.delete(path)
        continue
      }
      before.set(path, this.results.get(path) ?? [])
      this.records.set(path, { time, uses: readUses(ctx, path, kind, stripBom(text)) })
    }
    await this.check()
    return before
  }

  /** Checks every file kept against the index as it is now. */
  private async check(): Promise<void> {
    const lookup = this.lookup()
    const ids = this.stepTypeIds()
    const results = new Map<string, Problem[]>()
    let slice = this.now()
    for (const [path, record] of this.records) {
      if (this.now() - slice >= SLICE_MS) {
        await this.pause()
        slice = this.now()
      }
      const problems = checkUses(lookup, path, record.uses, ids)
      if (problems.length > 0) results.set(path, problems)
    }
    this.results = results
  }

  /** The problems of a text as the file `path`, now, without keeping them. */
  analyseText(path: string, text: string): Problem[] {
    const lookup = this.lookup()
    const kind = this.kindOf(lookup, path)
    if (!kind) return []
    return checkUses(lookup, path, readUses({ index: this.index, dw: this.dw() }, path, kind, stripBom(text)), this.stepTypeIds())
  }

  /**
   * Takes a text as the file's (a save about to be written): reads and checks it now, keeps it,
   * and answers the file's problems before and after. A pass later reads the file again from disk.
   */
  takeText(path: string, text: string): { before: Problem[]; after: Problem[] } {
    const lookup = this.lookup()
    const kind = this.kindOf(lookup, path)
    const before = this.results.get(path) ?? []
    if (!kind) return { before, after: before }
    const uses = readUses({ index: this.index, dw: this.dw() }, path, kind, stripBom(text))
    this.records.set(path, { time: null, uses })
    const after = checkUses(lookup, path, uses, this.stepTypeIds())
    if (after.length > 0) this.results.set(path, after)
    else this.results.delete(path)
    return { before, after }
  }

  /** A file's problems as last checked. */
  problemsOf(path: string): readonly Problem[] {
    return this.results.get(path) ?? []
  }

  /** Every file with problems, sorted by path. */
  entries(): [string, readonly Problem[]][] {
    return [...this.results].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }

  counts(): ProblemCounts {
    return countProblems(this.results.values())
  }

  /** How many files have problems. */
  fileCount(): number {
    return this.results.size
  }

  /** A short fingerprint of every problem and where it is: two passes that found the same give the same. */
  signature(): string {
    let hash = 0x811c9dc5
    const mix = (text: string) => {
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
    }
    for (const [path, problems] of this.entries()) {
      mix(path)
      for (const each of problems) mix(`${each.code}:${each.start}:${each.end}:${each.line}:${JSON.stringify(each.args)}`)
    }
    return hash.toString(16)
  }
}

export { countProblems, emptyCounts, SEVERITIES, type ProblemCounts }
