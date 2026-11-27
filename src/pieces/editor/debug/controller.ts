// The editor's side of the debugger (phase 7.3), without the DOM: it asks the worker for the state
// of the file shown (`debugger.file`, again on every `debugger.state` post), draws its breakpoints
// and its stopped line through a surface, sets or removes a breakpoint on a click or F9 through the
// one store (`debugger.breakpoint`, so the debugger's view and the Errors view agree), moves marks
// with edits (marks.ts), writes them where they are seen on the editor's save of the file
// (`debugger.setBreakpoints`), and asks the value of a plain read while a thread is halted in the
// file (`debugger.hover`). Only a located file is asked about: until 7.1 names it, nothing shows.
import type { DebuggerFileInput, DebuggerFileState, DebuggerHoverValue, StoppedLine } from '../../debugger/protocol'
import type { LineHighlight, LineMark } from '../surface/view'
import type { debugMessages } from './i18n'
import type { LineChange } from './line-map'
import { BreakpointMarks, type MarkState } from './marks'

export type DebugRequests = {
  file(input: DebuggerFileInput): Promise<DebuggerFileState>
  breakpoint(input: DebuggerFileInput & { line: number; on: boolean }): Promise<unknown>
  setBreakpoints(input: DebuggerFileInput & { lines: number[] }): Promise<unknown>
  hover(input: DebuggerFileInput & { expression: string; frameId: number }): Promise<DebuggerHoverValue | null>
}

/** What the controller draws on: the editor's surface (surface/view.ts) in the frame, a fake in tests. */
export type DebugSurface = {
  setMarks(marks: Map<number, LineMark>): void
  /** Whether the mark column takes a click. */
  setClickable(clickable: boolean): void
  setHighlight(highlight: LineHighlight | null): void
  /** Puts a line (0-based) in view. */
  reveal(line: number): void
  /** A one-line notice above the text. */
  notify(text: string): void
}

export type DebugWords = (key: keyof (typeof debugMessages)['en'], vars?: Record<string, string>) => string

/** The class each state draws with (`ed-mark-<kind>`) and the words of its tooltip. */
const KINDS: Record<MarkState, { kind: string; title: keyof (typeof debugMessages)['en'] }> = {
  verified: { kind: 'bp', title: 'markVerified' },
  unverified: { kind: 'bp-unverified', title: 'markUnverified' },
  idle: { kind: 'bp-idle', title: 'markIdle' },
  pending: { kind: 'bp-pending', title: 'markPending' }
}

export class DebugController {
  private file: DebuggerFileInput | null = null
  private scriptable = false
  private stoppedLine: StoppedLine | null = null
  private readonly marks: BreakpointMarks
  /** Raised by every request and write: an answer to an older request is dropped. */
  private asked = 0
  /** Writes in flight: while any is, no answer is taken, and one more is asked once they end. */
  private writing = 0
  private revealed = ''
  private readonly stateListeners: (() => void)[] = []

  constructor(
    private readonly requests: DebugRequests,
    private readonly surface: DebugSurface,
    private readonly word: DebugWords,
    private readonly lineCount: () => number
  ) {
    this.marks = new BreakpointMarks(lineCount())
  }

  /** The file shown, as 7.1 named it, or null while it is not named: then nothing shows and the gutter takes no click. */
  setFile(file: DebuggerFileInput | null): void {
    if (file && this.file && file.workspaceId === this.file.workspaceId && file.path === this.file.path) return
    this.file = file ? { workspaceId: file.workspaceId, path: file.path } : null
    this.asked++
    this.scriptable = false
    this.stoppedLine = null
    this.revealed = ''
    this.marks.reset(this.lineCount())
    this.marks.setStored([], 'none')
    this.surface.setClickable(false)
    this.draw()
    if (this.file) void this.refresh()
  }

  /** Where a thread is halted in this file, as the worker last said; null otherwise. */
  get stopped(): StoppedLine | null {
    return this.stoppedLine
  }

  /** Called after each answer that changed what is shown (the hover hides then). */
  onState(listener: () => void): void {
    this.stateListeners.push(listener)
  }

  /** Asks the worker for the file's state; the newest answer wins, and none while a write is in flight. */
  async refresh(): Promise<void> {
    const file = this.file
    if (!file || this.writing > 0) return
    const mine = ++this.asked
    let state: DebuggerFileState
    try {
      state = await this.requests.file(file)
    } catch {
      return
    }
    if (mine !== this.asked || this.writing > 0 || file !== this.file) return
    this.apply(state)
  }

  private apply(state: DebuggerFileState): void {
    this.scriptable = state.scriptable === true
    this.surface.setClickable(this.scriptable)
    this.marks.setStored(Array.isArray(state.lines) ? state.lines : [], state.session)
    const before = this.stoppedLine
    this.stoppedLine = state.stopped ?? null
    this.draw()
    const now = this.stoppedLine
    if (before?.frameId !== now?.frameId || before?.line !== now?.line) for (const listener of this.stateListeners) listener()
  }

  /** A change of the buffer: marks and the stopped line move with the text. */
  bufferChanged(fromLine: number, oldEnd: number, newEnd: number, change: LineChange): void {
    if (this.marks.change(fromLine, oldEnd, newEnd, change)) this.draw()
  }

  /** A click in the mark column or F9 on a line (0-based): sets or removes its breakpoint. */
  async toggle(line: number): Promise<void> {
    const file = this.file
    if (!file || !this.scriptable) return
    const actions = this.marks.toggle(line)
    this.draw()
    if (actions.length === 0) return
    await this.write(async () => {
      for (const action of actions) await this.requests.breakpoint({ ...file, line: action.line, on: action.on })
    })
  }

  /** Orca flushed this editor for a save. */
  flushed(): void {
    this.marks.flushed(this.lineCount())
  }

  /** The save was this editor's, of this file: the store gets every breakpoint where it is seen. */
  async saved(): Promise<void> {
    const file = this.file
    if (!file) return
    const lines = this.marks.saved()
    this.draw()
    if (lines === null || !this.scriptable) return
    await this.write(() => this.requests.setBreakpoints({ ...file, lines }))
  }

  /** The value of a plain read in the frame halted in this file; null when none is, or on any failure. */
  async hoverValue(expression: string): Promise<DebuggerHoverValue | null> {
    const file = this.file
    const stopped = this.stoppedLine
    if (!file || !stopped) return null
    try {
      return await this.requests.hover({ ...file, expression, frameId: stopped.frameId })
    } catch {
      return null
    }
  }

  private async write(work: () => Promise<unknown>): Promise<void> {
    this.writing++
    this.asked++
    try {
      await work()
    } catch (error) {
      this.surface.notify(this.word((error as { code?: unknown } | null)?.code === 'not_script' ? 'notScript' : 'failed'))
    } finally {
      this.writing--
    }
    // What the store holds now, the session's verdict on it included.
    if (this.writing === 0) await this.refresh()
  }

  /** Every mark, and the stopped line, where its text is now. */
  private draw(): void {
    const marks = new Map<number, LineMark>()
    for (const [line, state] of this.marks.shown()) marks.set(line, { kinds: [KINDS[state].kind], title: this.word(KINDS[state].title) })
    const stopped = this.stoppedLine
    const at = stopped ? this.marks.current(stopped.line) : null
    let highlight: LineHighlight | null = null
    if (stopped && at !== null) {
      const name = stopped.name.trim()
      const label = stopped.top ? (name ? this.word('stoppedHere', { name }) : this.word('stoppedHereNoName')) : name ? this.word('calledHere', { name }) : this.word('calledHereNoName')
      const kind = stopped.top ? 'stopped' : 'caller'
      const mark = marks.get(at)
      marks.set(at, mark ? { kinds: [...mark.kinds, kind], title: `${mark.title}. ${label}` } : { kinds: [kind], title: label })
      highlight = { line: at, kind, label }
    }
    this.surface.setMarks(marks)
    this.surface.setHighlight(highlight)
    // A new halt here comes into view once; edits and repeated answers leave the scroll alone.
    const key = stopped && at !== null ? `${stopped.frameId}:${stopped.line}` : ''
    if (key && key !== this.revealed && at !== null) this.surface.reveal(at)
    this.revealed = key
  }
}
