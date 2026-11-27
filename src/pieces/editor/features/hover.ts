// Hover: what the engine says of the name the pointer rests on (`engine.hover`, asked once the
// pointer has rested `HOVER_DELAY_MS`), or of the one at the caret with Mod+I; with the messages
// of the problems there, which need no request and are drawn at once. Worded from the engine's
// texts (words.ts). A `dw.*` description is read by the worker at run time: when it was not read
// in time, the hover is drawn without it and asked once more a little later (the worker keeps a
// page read late), replacing the hover only while it is still shown. It closes when the pointer
// leaves its range, the text changes, the caret moves (one opened by key), or on Escape. Pure.
import type { EngineHover, Problem } from '../../engine/protocol'
import { plain, queryAt, noteState, type FeatureContext } from './context'
import { Latest } from './document'
import type { Section } from './ui'
import { hoverLink, hoverSections, problemSections } from './words'

/** How long the pointer rests on a name before it is asked about. */
export const HOVER_DELAY_MS = 350
/** When a description was not read in time: how long before the hover asks once more. */
export const DESCRIPTION_RETRY_MS = 1_500

type Shown = { start: number; end: number; byKey: boolean; offset: number }

export class HoverController {
  private readonly ctx: FeatureContext
  private readonly latest: Latest
  private readonly problemsAt: (offset: number) => Problem[]
  private shown: Shown | null = null
  private retry: unknown = null

  constructor(ctx: FeatureContext, problemsAt: (offset: number) => Problem[]) {
    this.ctx = ctx
    this.latest = new Latest(ctx.document)
    this.problemsAt = problemsAt
  }

  get isOpen(): boolean {
    return this.shown !== null
  }

  /** The pointer rested on an offset of the text (null: off the text). */
  rest(offset: number | null, startedAt: number): void {
    if (offset === null) return
    if (this.shown && !this.shown.byKey && offset >= this.shown.start && offset <= this.shown.end) return
    void this.ask(offset, false, startedAt)
  }

  /** The pointer moved: a hover it opened closes once the pointer leaves its range. */
  moved(offset: number | null, overPopup: boolean): void {
    const shown = this.shown
    if (!shown || shown.byKey || overPopup) return
    if (offset === null || offset < shown.start || offset > shown.end) this.close()
  }

  /** Mod+I: the hover of the name at the caret. */
  atCaret(startedAt: number): void {
    void this.ask(this.ctx.document.caret(), true, startedAt)
  }

  /** The caret moved: a hover opened by key closes. */
  caretMoved(): void {
    if (this.shown?.byKey && this.ctx.document.caret() !== this.shown.offset) this.close()
  }

  close(): void {
    this.latest.cancel()
    this.ctx.clearTimer(this.retry)
    if (this.shown) {
      this.shown = null
      this.ctx.ui.hover(null)
    }
  }

  private async ask(offset: number, byKey: boolean, startedAt: number, again = false): Promise<void> {
    const problems = this.problemsAt(offset)
    const problemText = problemSections(this.ctx.locale, problems)
    let start = problems.length > 0 ? Math.min(...problems.map((each) => each.start)) : offset
    let end = problems.length > 0 ? Math.max(...problems.map((each) => each.end)) : offset
    const current = this.latest.begin()
    if (!again) this.ctx.clearTimer(this.retry)
    // The problems' messages need no request: drawn at once, the engine's words added when they come.
    if (problemText.length > 0 && !again) this.draw({ start, end, byKey, offset }, problemText, null, null)
    else if (!again && this.shown) {
      this.shown = null
      this.ctx.ui.hover(null)
    }
    const query = queryAt(this.ctx, offset)
    if (!query) return
    let answer: EngineHover
    try {
      answer = await this.ctx.requests.hover(plain(query))
    } catch {
      return
    }
    if (!current()) return
    noteState(this.ctx, answer, query.located)
    const hover = answer.hover
    if (!hover) {
      if (problemText.length === 0) this.close()
      return
    }
    if (hover.range) {
      start = Math.min(start, hover.range.start)
      end = Math.max(end, hover.range.end)
    }
    const late = hover.descriptionError === 'timeout' && !again
    const sections = [...hoverSections(this.ctx.locale, hover, late), ...problemText]
    this.draw({ start, end, byKey, offset }, sections, hoverLink(hover), again ? null : startedAt)
    // The description came too late for this answer: the worker keeps it for the next.
    if (late) this.retry = this.ctx.setTimer(() => void this.ask(offset, byKey, startedAt, true), DESCRIPTION_RETRY_MS)
  }

  /** Draws a hover; `startedAt` measures the engine's answer (null for what needed no request). */
  private draw(shown: Shown, sections: Section[], link: string | null, startedAt: number | null): void {
    if (sections.length === 0) {
      this.close()
      return
    }
    this.shown = shown
    this.ctx.ui.hover({ anchor: this.ctx.document.posOf(shown.start), sections, link })
    if (startedAt !== null) this.ctx.measured('hover', this.ctx.now() - startedAt)
  }
}
