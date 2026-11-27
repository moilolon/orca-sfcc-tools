// The breakpoints of the file the editor shows, as the gutter draws them. The store
// (src/pieces/debugger/breakpoints.ts, through the worker) keeps lines of the file as saved, which
// is what the sandbox runs once `code watch` uploads it; the editor shows them where their text is
// now (line-map.ts). A breakpoint set on a line written since the save has no saved line yet: it
// is held here (`pending`) and written with the others on the editor's next save of the file, when
// every line the person sees becomes the line the store holds. Lines are 0-based here, 1-based in
// the store. Pure: no DOM, no Orca.
import type { DebuggerFileState } from '../../debugger/protocol'
import { LineMap, moveLine, movesLines, type LineChange } from './line-map'

/** How a breakpoint draws: verified by the session, not verified, no session on its workspace, or not saved yet. */
export type MarkState = 'verified' | 'unverified' | 'idle' | 'pending'

export type StoredLine = DebuggerFileState['lines'][number]

/** What a click on a line asks the store: set or remove these saved lines (1-based); nothing when the change stayed here. */
export type ToggleAction = { line: number; on: boolean }[]

type Pending = { line: number }

export class BreakpointMarks {
  private stored: StoredLine[] = []
  private session: DebuggerFileState['session'] = 'none'
  private map: LineMap
  private pending: Pending[] = []
  /** What was shown when Orca flushed the editor for a save, and the edits since. */
  private flush: { lines: number[]; included: Set<Pending>; since: LineMap } | null = null

  constructor(lineCount: number) {
    this.map = new LineMap(lineCount)
  }

  /** A new file, or the text read again as saved: lines are where the store says. */
  reset(lineCount: number): void {
    this.map = new LineMap(lineCount)
    this.pending = []
    this.flush = null
  }

  /** The store's lines of this file and whether a session runs on its workspace, as the worker answered. */
  setStored(lines: readonly StoredLine[], session: DebuggerFileState['session']): void {
    this.stored = lines.map((each) => ({ ...each }))
    this.session = session
  }

  /** Where a saved line (1-based) is now (0-based); null past the saved file's end. */
  current(savedLine: number): number | null {
    return this.map.current(savedLine - 1)
  }

  /** Follows one change of the buffer; false when it moved nothing. */
  change(fromLine: number, oldEnd: number, newEnd: number, change: LineChange): boolean {
    if (!movesLines(fromLine, oldEnd, newEnd)) return false
    this.map.apply(fromLine, oldEnd, newEnd, change)
    this.flush?.since.apply(fromLine, oldEnd, newEnd, change)
    for (const each of this.pending) each.line = moveLine(each.line, fromLine, oldEnd, newEnd, change)
    // Two pending breakpoints joined on one line are one.
    const seen = new Set<number>()
    this.pending = this.pending.filter((each) => (seen.has(each.line) ? false : (seen.add(each.line), true)))
    return true
  }

  /** Every breakpoint where it is shown now (0-based), with how it draws. */
  shown(): Map<number, MarkState> {
    const marks = new Map<number, MarkState>()
    for (const each of this.stored) {
      const line = this.map.current(each.line - 1)
      if (line === null) continue
      const state: MarkState = each.verified === true ? 'verified' : each.verified === false || this.session !== 'none' ? 'unverified' : 'idle'
      // Joined lines show once: verified only when every one of them is.
      const before = marks.get(line)
      marks.set(line, before && before !== 'verified' ? before : state)
    }
    for (const each of this.pending) if (!marks.has(each.line)) marks.set(each.line, 'pending')
    return marks
  }

  /**
   * A click on a line (0-based): removes what is shown there, or sets one. A saved line is asked of
   * the store at once (and shown so already); a line written since the save is held until the save.
   */
  toggle(line: number): ToggleAction {
    const stored = this.stored.filter((each) => this.map.current(each.line - 1) === line)
    const pending = this.pending.filter((each) => each.line === line)
    if (stored.length > 0 || pending.length > 0) {
      this.stored = this.stored.filter((each) => !stored.includes(each))
      this.pending = this.pending.filter((each) => !pending.includes(each))
      return stored.map((each) => ({ line: each.line, on: false }))
    }
    // The text now on this line: the last saved line joined into it (its tail is what is here).
    const saved = this.map.savedAt(line).at(-1)
    if (saved === undefined) {
      this.pending.push({ line })
      return []
    }
    this.stored = [...this.stored, { line: saved + 1, verified: null }].sort((a, b) => a.line - b.line)
    return [{ line: saved + 1, on: true }]
  }

  /** Orca is about to save this editor's text: what it shows now is what the store gets if the save is this file's. */
  flushed(lineCount: number): void {
    this.flush = { lines: [...this.shown().keys()].sort((a, b) => a - b), included: new Set(this.pending), since: new LineMap(lineCount) }
  }

  /**
   * The editor's save of this file happened: the lines to write (1-based, where they were shown
   * when it was flushed), or null when nothing changed or no flush preceded it. From now on the
   * saved file is that text.
   */
  saved(): number[] | null {
    const flush = this.flush
    if (!flush) return null
    this.flush = null
    const lines = flush.lines.map((line) => line + 1)
    const before = this.stored.map((each) => each.line)
    this.map = flush.since
    this.pending = this.pending.filter((each) => !flush.included.has(each))
    if (sameLines(before, lines)) return null
    // Whether the session verified a moved line is asked again once the store has it.
    this.stored = lines.map((line) => ({ line, verified: null }))
    return lines
  }
}

function sameLines(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}
