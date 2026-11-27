// Underlined warnings: the engine's problems of the text being edited (`engine.problems`), asked
// after a pause in typing, never per key, and only for a file 7.1 identified (S3). Each is drawn
// as a squiggle of its severity; the hover says its message. Between two answers the squiggles
// move with the text: one after an edit shifts with it, one the edit touched is dropped until the
// next answer. Pure: no DOM.
import type { Problem } from '../../engine/protocol'
import type { Change } from '../surface/buffer'
import type { Underline } from '../surface/view'
import { noteState, type FeatureContext } from './context'
import { Latest } from './document'

/** The pause in typing after which the problems of the text are asked. */
export const PROBLEMS_DELAY_MS = 500

export class ProblemsController {
  private readonly ctx: FeatureContext
  private readonly latest: Latest
  private problems: Problem[] = []
  private timer: unknown = null
  private readonly unsubscribe: () => void

  constructor(ctx: FeatureContext) {
    this.ctx = ctx
    this.latest = new Latest(ctx.document)
    this.unsubscribe = ctx.model.buffer.onChange((_from, _old, _new, change) => this.shift(change))
  }

  /** The problems drawn now, in offsets of the text now. */
  get current(): readonly Problem[] {
    return this.problems
  }

  /** The problems whose range holds the offset (an empty range: its place). */
  at(offset: number): Problem[] {
    return this.problems.filter((each) => each.start <= offset && (offset < each.end || (each.start === each.end && offset === each.start)))
  }

  /** The text changed: asked again once typing pauses. */
  changed(startedAt: number): void {
    this.ctx.clearTimer(this.timer)
    this.timer = this.ctx.setTimer(() => void this.run(startedAt), PROBLEMS_DELAY_MS)
  }

  /** The file was named, or is no longer: asked now, or cleared. */
  identityChanged(): void {
    this.ctx.clearTimer(this.timer)
    void this.run(this.ctx.now())
  }

  async run(startedAt: number): Promise<void> {
    const file = this.ctx.file()
    if (!file || !file.problems || this.ctx.model.composition) {
      this.latest.cancel()
      if (!file?.problems) this.draw([])
      return
    }
    const current = this.latest.begin()
    try {
      const answer = await this.ctx.requests.problems({ workspaceId: file.workspaceId, path: file.path, text: this.ctx.document.text() })
      if (!current()) return
      noteState(this.ctx, answer, true)
      this.draw(answer.error ? [] : answer.problems)
      this.ctx.measured('problems', this.ctx.now() - startedAt)
    } catch {
      // The squiggles drawn stay until an answer comes.
    }
  }

  dispose(): void {
    this.ctx.clearTimer(this.timer)
    this.latest.cancel()
    this.unsubscribe()
  }

  /** An edit: problems after it shift by what it added or removed; one it touched is dropped. */
  private shift(change: Change): void {
    if (this.problems.length === 0) return
    const start = this.ctx.document.offsetOf(change.from)
    const removedEnd = start + change.removed.length
    const delta = change.inserted.length - change.removed.length
    const kept: Problem[] = []
    for (const each of this.problems) {
      if (each.end < start || (each.end === start && each.start < start)) kept.push(each)
      else if (each.start > removedEnd || (each.start === removedEnd && each.end > each.start)) kept.push({ ...each, start: each.start + delta, end: each.end + delta })
    }
    this.draw(kept)
  }

  private draw(problems: Problem[]): void {
    const unchanged = problems.length === 0 && this.problems.length === 0
    this.problems = problems
    if (unchanged) return
    const document = this.ctx.document
    const underlines: Underline[] = problems.map((each) => ({ from: document.posOf(each.start), to: document.posOf(each.end), tone: each.severity }))
    this.ctx.ui.underlines(underlines)
  }
}
