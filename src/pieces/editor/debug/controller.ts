// The editor's side of the debugger (phase 7.3), without the DOM: it asks the worker for the state
// of the file shown (`debugger.file`, again on every `debugger.state` post), draws its breakpoints
// and its stopped line through a surface where the text now puts them (marks.ts), sets or removes
// a breakpoint on a click or F9 through the one store (`debugger.breakpoint`, so the debugger's
// view and the Errors view agree), and asks the value of a plain read while a thread is halted in
// the file (`debugger.hover`, in a script only). The worker moves the store's lines on every save;
// the editor only follows which text is on disk (`savedOwn`, `rebase`) and sets what it held for
// a line written since. Only a located file is asked about: until 7.1 names it, nothing shows.
import type { DebuggerFileInput, DebuggerFileState, DebuggerHoverValue, StoppedLine } from '../../debugger/protocol'
import type { LineHighlight, LineMark } from '../surface/view'
import type { debugMessages } from './i18n'
import type { LineChange } from './line-map'
import { BreakpointMarks, type MarkState } from './marks'

export type DebugRequests = {
  file(input: DebuggerFileInput): Promise<DebuggerFileState>
  breakpoint(input: DebuggerFileInput & { line: number; on: boolean; text?: string }): Promise<unknown>
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
/** The files whose text is a script: the only ones a value is read in (a template is not one). */
const SCRIPT = /.(js|ds)$/i

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
  /** What was last drawn, so an edit that moves nothing draws nothing. */
  private drawn = ''
  private readonly stateListeners: (() => void)[] = []

  constructor(
    private readonly requests: DebugRequests,
    private readonly surface: DebugSurface,
    private readonly word: DebugWords,
    lines: () => readonly string[]
  ) {
    this.marks = new BreakpointMarks(lines)
  }

  /** The file shown, as 7.1 named it, or null while it is not named: then nothing shows and the gutter takes no click. */
  setFile(file: DebuggerFileInput | null): void {
    if (file && this.file && file.workspaceId === this.file.workspaceId && file.path === this.file.path) return
    this.file = file ? { workspaceId: file.workspaceId, path: file.path } : null
    this.asked++
    this.scriptable = false
    this.stoppedLine = null
    this.revealed = ''
    this.marks.reset()
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
    this.marks.change(fromLine, oldEnd, newEnd, change)
    this.draw()
  }

  /** A click in the mark column or F9 on a line (0-based): sets or removes its breakpoint. */
  async toggle(line: number): Promise<void> {
    const file = this.file
    if (!file || !this.scriptable) return
    const actions = this.marks.toggle(line)
    this.draw()
    if (actions.length === 0) return
    await this.write(async () => {
      for (const action of actions) await this.requests.breakpoint({ ...file, ...action })
    })
  }

  /** Orca flushed this editor for a save. */
  flushed(): void {
    this.marks.flushed()
  }

  /** The save after the flush was this editor's, of this file: the text flushed is on disk now. */
  async savedOwn(): Promise<void> {
    await this.setHeld(this.marks.savedOwn())
  }

  /**
   * The file on disk is now `lines`: a save of the text this editor holds (from any tab), or a
   * write from outside (an agent, Orca's own editor). Marks stay on the store's lines.
   */
  async rebase(lines: readonly string[]): Promise<void> {
    await this.setHeld(this.marks.rebase(lines))
  }

  /** Breakpoints held on written lines that a save made lines of the file: set in the store. */
  private async setHeld(lines: number[]): Promise<void> {
    this.draw()
    const file = this.file
    if (!file) return
    if (lines.length === 0 || !this.scriptable) {
      // The worker may have moved the store's lines with the save: ask what they are now.
      await this.refresh()
      return
    }
    await this.write(async () => {
      for (const line of lines) await this.requests.breakpoint({ ...file, line, on: true })
    })
  }

  /**
   * The value of a plain read in the frame halted in this file (the topmost one in it, as VS Code
   * does: a name in another function of the file is read in that frame's scopes, which may hold
   * another variable of that name); null in a template, when none is halted, or on any failure.
   */
  async hoverValue(expression: string): Promise<DebuggerHoverValue | null> {
    const file = this.file
    const stopped = this.stoppedLine
    if (!file || !stopped || !SCRIPT.test(file.path)) return null
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
      const code = (error as { code?: unknown } | null)?.code
      this.surface.notify(this.word(code === 'not_script' ? 'notScript' : code === 'line_changed' ? 'lineChanged' : 'failed'))
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
    const key = JSON.stringify([[...marks], highlight])
    if (key !== this.drawn) {
      this.drawn = key
      this.surface.setMarks(marks)
      this.surface.setHighlight(highlight)
    }
    // A new halt here comes into view once; edits and repeated answers leave the scroll alone.
    const halt = stopped && at !== null ? `${stopped.frameId}:${stopped.line}` : ''
    if (halt && halt !== this.revealed && at !== null) this.surface.reveal(at)
    this.revealed = halt
  }
}
