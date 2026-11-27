// The breakpoints of the file the editor shows, as the gutter draws them. The store
// (src/pieces/debugger/breakpoints.ts, through the worker) keeps lines of the file as saved, which
// is what the sandbox runs once `code watch` uploads it, and the worker moves them on every save
// with the same line diff (src/pieces/debugger/line-diff.ts). The editor keeps the text it believes
// is on disk (`baseline`) and shows each stored line where the diff from that text to the text now
// puts it: what it shows before a save is what the store holds after it, a line deleted whole hides
// its mark (and undo brings both back), and the stopped line and a click use the store's numbers.
//
// The baseline is the text of the last save of the file this editor saw (its own, or any save
// whose text it holds), or the text of the last write from outside (an agent, Orca's own editor):
// marks never move with an outside write, they stay on the store's lines, which is what runs. A
// click on a line written since (no saved line under it) is held (`pending`, moved with the edits)
// and set once a save makes it a line of the file. Lines are 0-based here, 1-based in the store.
// Pure: no DOM, no Orca.
import type { DebuggerFileState } from '../../debugger/protocol'
import { mapLines } from '../../debugger/line-diff'
import { moveLine, movesLines, type LineChange } from './line-map'

/** How a breakpoint draws: verified by the session, not verified, no session on its workspace, or not saved yet. */
export type MarkState = 'verified' | 'unverified' | 'idle' | 'pending'

export type StoredLine = DebuggerFileState['lines'][number]

/** What a click on a line asks the store: set or remove these saved lines (1-based); nothing when the change stayed here. */
export type ToggleAction = { line: number; on: boolean }[]

type Pending = { line: number }

export class BreakpointMarks {
  private stored: StoredLine[] = []
  private session: DebuggerFileState['session'] = 'none'
  private baseline: string[]
  private pending: Pending[] = []
  /** The map from the baseline to the text now, kept until either changes. */
  private cache: { version: number; map: Int32Array } | null = null
  private version = 0
  /** The text Orca was about to save, and where each pending breakpoint was in it. */
  private flush: { lines: string[]; pending: Map<Pending, number> } | null = null

  /** `lines` gives the editor's lines now (the buffer's own array, read only). */
  constructor(private readonly lines: () => readonly string[]) {
    this.baseline = [...lines()]
  }

  /** A new file: the text shown is taken as the file on disk, and nothing is held. */
  reset(): void {
    this.baseline = [...this.lines()]
    this.pending = []
    this.flush = null
    this.changed()
  }

  /** The store's lines of this file and whether a session runs on its workspace, as the worker answered. */
  setStored(lines: readonly StoredLine[], session: DebuggerFileState['session']): void {
    this.stored = lines.map((each) => ({ ...each }))
    this.session = session
  }

  private changed(): void {
    this.version++
  }

  private map(): Int32Array {
    if (!this.cache || this.cache.version !== this.version) this.cache = { version: this.version, map: mapLines(this.baseline, this.lines()) }
    return this.cache.map
  }

  /** Where a saved line (1-based) is now (0-based); null when it was deleted or is past the file's end. */
  current(savedLine: number): number | null {
    const map = this.map()
    const at = savedLine >= 1 && savedLine <= map.length ? map[savedLine - 1] : -1
    return at >= 0 ? at : null
  }

  /** Follows one change of the buffer: pending breakpoints move with it, the map is drawn again. */
  change(fromLine: number, oldEnd: number, newEnd: number, change: LineChange): void {
    this.changed()
    if (!movesLines(fromLine, oldEnd, newEnd)) return
    for (const each of this.pending) each.line = moveLine(each.line, fromLine, oldEnd, newEnd, change)
    const seen = new Set<number>()
    this.pending = this.pending.filter((each) => (seen.has(each.line) ? false : (seen.add(each.line), true)))
  }

  /** Every breakpoint where it is shown now (0-based), with how it draws. */
  shown(): Map<number, MarkState> {
    const marks = new Map<number, MarkState>()
    for (const each of this.stored) {
      const line = this.current(each.line)
      if (line === null) continue
      const state: MarkState = each.verified === true ? 'verified' : each.verified === false || this.session !== 'none' ? 'unverified' : 'idle'
      const before = marks.get(line)
      marks.set(line, before && before !== 'verified' ? before : state)
    }
    for (const each of this.pending) if (!marks.has(each.line)) marks.set(each.line, 'pending')
    return marks
  }

  /**
   * A click on a line (0-based): removes what is shown there, or sets one. A saved line is asked of
   * the store at once (and shown so already); a line written since the save is held until a save.
   */
  toggle(line: number): ToggleAction {
    const stored = this.stored.filter((each) => this.current(each.line) === line)
    const pending = this.pending.filter((each) => each.line === line)
    if (stored.length > 0 || pending.length > 0) {
      this.stored = this.stored.filter((each) => !stored.includes(each))
      this.pending = this.pending.filter((each) => !pending.includes(each))
      return stored.map((each) => ({ line: each.line, on: false }))
    }
    const map = this.map()
    const saved = map.indexOf(line)
    if (saved < 0) {
      this.pending.push({ line })
      return []
    }
    this.stored = [...this.stored, { line: saved + 1, verified: null }].sort((a, b) => a.line - b.line)
    return [{ line: saved + 1, on: true }]
  }

  /** Orca is about to save this editor's text. */
  flushed(): void {
    this.flush = { lines: [...this.lines()], pending: new Map(this.pending.map((each) => [each, each.line])) }
  }

  /**
   * The save after the flush was this editor's, of this file: the text it flushed is the file now.
   * Answers the held breakpoints that became lines of it (1-based), to set in the store.
   */
  savedOwn(): number[] {
    const flush = this.flush
    if (!flush) return []
    this.flush = null
    this.baseline = flush.lines
    this.changed()
    const written: number[] = []
    for (const [each, line] of flush.pending) {
      if (!this.pending.includes(each)) continue
      this.pending = this.pending.filter((other) => other !== each)
      written.push(line + 1)
    }
    return written
  }

  /**
   * The file on disk is now `lines` (a save of a text this editor holds, or a write from outside).
   * When that is the text shown, the held breakpoints are lines of the file: they are answered
   * (1-based) to set in the store.
   */
  rebase(lines: readonly string[]): number[] {
    this.baseline = [...lines]
    this.changed()
    const now = this.lines()
    if (lines.length !== now.length || lines.some((line, i) => line !== now[i])) return []
    const written = this.pending.map((each) => each.line + 1)
    this.pending = []
    return written
  }
}
