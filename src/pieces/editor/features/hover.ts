// Hover, the editor's one pointer pop-up: what the engine says of the name the pointer rests on
// (`engine.hover`, asked once the pointer has rested `HOVER_DELAY_MS`), or of the one at the caret
// with Mod+I; with the messages of the problems there, which need no request and are drawn at
// once. While a thread is halted in this script (7.3) and the name has a value, the value comes
// first in the same box (`ValueAt`, from debug/attach.ts), the language hover under it; otherwise
// the language hover alone. Each part is drawn as it comes. Worded from the engine's texts
// (words.ts). A `dw.*` description is read by the worker at run time: the hover is asked with
// `describe: 'cached'`, so it answers at once and is drawn; when the description is not read yet
// (`pending`), it is said as being read, asked again with `wait`, and drawn in when it comes, only
// while that hover is still the one asked. It closes when the pointer leaves its range, the text
// changes, the caret moves (one opened by key), the debugger's state changes under a value, or on
// Escape. Pure: no DOM.
import type { EngineHover, Problem } from '../../engine/protocol'
import { plain, queryAt, noteState, type FeatureContext } from './context'
import type { DebugValue, Section, ValueAt } from './ui'
import { hoverLink, hoverSections, problemSections } from './words'

/** How long the pointer rests on a name before it is asked about (the debugger's value too). */
export const HOVER_DELAY_MS = 350

/** One hover asked: where, its range so far, and its parts as they came. */
type Round = {
  offset: number
  byKey: boolean
  version: number
  start: number
  end: number
  value: DebugValue | null
  language: Section[]
  link: string | null
  problems: Section[]
  /** Parts still asked (the value, the language hover): when none is left and nothing came, it closes. */
  waiting: number
}

export class HoverController {
  private readonly ctx: FeatureContext
  private readonly problemsAt: (offset: number) => Problem[]
  /** The debugger's value at a place while halted; none until 7.3 attaches. */
  valueAt: ValueAt | null = null
  private round: Round | null = null
  private shown: Round | null = null

  constructor(ctx: FeatureContext, problemsAt: (offset: number) => Problem[]) {
    this.ctx = ctx
    this.problemsAt = problemsAt
  }

  get isOpen(): boolean {
    return this.shown !== null
  }

  /** The pointer rested on an offset of the text (null: off the text). */
  rest(offset: number | null, startedAt: number): void {
    if (offset === null) return
    const shown = this.shown
    if (shown && !shown.byKey && offset >= shown.start && offset <= shown.end) return
    this.ask(offset, false, startedAt)
  }

  /** The pointer moved: a hover it opened closes once the pointer leaves its range. */
  moved(offset: number | null, overPopup: boolean): void {
    const shown = this.shown
    if (!shown || shown.byKey || overPopup) return
    if (offset === null || offset < shown.start || offset > shown.end) this.close()
  }

  /** Mod+I: the hover of the name at the caret. */
  atCaret(startedAt: number): void {
    this.ask(this.ctx.document.caret(), true, startedAt)
  }

  /** The caret moved: a hover opened by key closes. */
  caretMoved(): void {
    if (this.shown?.byKey && this.ctx.document.caret() !== this.shown.offset) this.close()
  }

  /** The debugger's state changed: a value shown may be gone. */
  debugChanged(): void {
    if (this.shown?.value || this.round?.value) this.close()
  }

  close(): void {
    this.round = null
    if (this.shown) {
      this.shown = null
      this.ctx.ui.hover(null)
    }
  }

  private live(round: Round): boolean {
    return this.round === round && round.version === this.ctx.document.version
  }

  private ask(offset: number, byKey: boolean, startedAt: number): void {
    const problems = this.problemsAt(offset)
    const round: Round = {
      offset,
      byKey,
      version: this.ctx.document.version,
      start: problems.length > 0 ? Math.min(...problems.map((each) => each.start)) : offset,
      end: problems.length > 0 ? Math.max(...problems.map((each) => each.end)) : offset,
      value: null,
      language: [],
      link: null,
      problems: problemSections(this.ctx.locale, problems),
      waiting: 0
    }
    this.round = round
    // The problems' messages need no request: drawn at once, the other parts added when they come.
    if (round.problems.length > 0) this.draw(round, null)
    else if (this.shown) {
      this.shown = null
      this.ctx.ui.hover(null)
    }
    const valueAt = this.valueAt
    if (valueAt) {
      round.waiting++
      valueAt(offset).then(
        (value) => this.valueCame(round, value),
        () => this.valueCame(round, null)
      )
    }
    if (queryAt(this.ctx, offset)) {
      round.waiting++
      void this.language(round, 'cached', startedAt)
    }
    if (round.waiting === 0 && round.problems.length === 0) this.close()
  }

  private valueCame(round: Round, value: DebugValue | null): void {
    if (!this.live(round)) return
    round.waiting--
    if (value) {
      round.value = value
      round.start = Math.min(round.start, value.from)
      round.end = Math.max(round.end, value.to)
    }
    this.settle(round, null)
  }

  /** The language part; `wait`: its description, which the `cached` answer said was being read. */
  private async language(round: Round, describe: 'cached' | 'wait', startedAt: number | null): Promise<void> {
    const query = queryAt(this.ctx, round.offset)
    let answer: EngineHover | null = null
    if (query) {
      try {
        answer = await this.ctx.requests.hover({ ...plain(query), describe })
      } catch {
        answer = null
      }
    }
    if (!this.live(round)) return
    if (describe === 'cached') round.waiting--
    if (answer && query) noteState(this.ctx, answer, query.located)
    const hover = answer?.hover ?? null
    const reading = hover?.descriptionError === 'pending' && describe === 'cached'
    if (hover) {
      if (hover.range) {
        round.start = Math.min(round.start, hover.range.start)
        round.end = Math.max(round.end, hover.range.end)
      }
      round.language = hoverSections(this.ctx.locale, hover, reading)
      round.link = hoverLink(hover)
    }
    this.settle(round, hover ? startedAt : null)
    // The description is being read: asked for again, waited for, and drawn in when it comes.
    if (reading) void this.language(round, 'wait', null)
  }

  /** Draws what the round has; closes when every part came and none had anything. */
  private settle(round: Round, startedAt: number | null): void {
    const empty = !round.value && round.language.length === 0 && round.problems.length === 0
    if (empty) {
      if (round.waiting <= 0) this.close()
      return
    }
    this.draw(round, startedAt)
  }

  /** Draws a round: the value first, then the language hover, then the problems. `startedAt` measures an engine answer. */
  private draw(round: Round, startedAt: number | null): void {
    const sections = [...(round.value?.sections ?? []), ...round.language, ...round.problems]
    this.shown = round
    this.ctx.ui.hover({ anchor: this.ctx.document.posOf(round.start), sections, link: round.link, label: round.value?.label ?? null })
    if (startedAt !== null) this.ctx.measured('hover', this.ctx.now() - startedAt)
  }
}
