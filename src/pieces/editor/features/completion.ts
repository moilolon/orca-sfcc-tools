// Completion: `engine.complete` at the caret, a list under it. It opens by itself after a key
// where the engine may have items (after `.`, `<` and an ISML tag's name in a template, a quote
// opening an argument or an attribute's value, `${`), and with Ctrl+Space anywhere. While it is
// open, every key filters it at once in the frame and asks the engine again (the newest answer
// only), so the list never waits for the worker; arrows and Page keys move, Enter and Tab accept,
// Escape closes. Accepting replaces exactly the range the engine said, moved by what was typed
// since. The selected item's description (`engine.hover` with its id) is asked once the selection
// rests. Pure: no DOM.
import type { Completion, CompletionContext, CompletionItem, EngineCompletion } from '../../engine/protocol'
import { hint, noteState, plain, queryAt, type FeatureContext } from './context'
import { Latest } from './document'
import { listKey, type KeyPress } from './keys'
import type { ListView, Section } from './ui'
import { hoverLink, hoverSections, kindWord } from './words'

/** How long the list waits after a key before asking again while it is open: fast typing asks once. */
export const REASK_DELAY_MS = 40
/** How long the selection rests before its description is asked. */
export const DESCRIBE_DELAY_MS = 120
/** Rows a Page key moves. */
export const PAGE_ROWS = 8

/** Contexts whose range is a name (filtered by name characters); the others are a string's content. */
const NAME_CONTEXTS: ReadonlySet<CompletionContext> = new Set(['member', 'tag', 'tag-attribute', 'custom', 'site-preference'])

/**
 * Whether the list opens by itself after `typed`, with `before` the line up to the caret (the
 * typed text included). Only where the engine answers something: a member, a tag or its attribute,
 * a string that is an argument or an attribute's value, an expression just opened. A name typed
 * after one of those asks too, so a fast typist who outran the first answer still gets a list.
 */
export function opensAfter(before: string, typed: string, template: boolean): boolean {
  if (typed.length !== 1) return false
  if (/^[\w$]$/.test(typed) || typed === '.' || typed === '-' || typed === ':') {
    // A member of a name or of a call's result; never a number's decimal point.
    if (/(?:(?:^|[^\w$])[A-Za-z_$][\w$]*|[)\]])\.[\w$]*$/.test(before)) return true
  }
  if (/[(,=]\s*['"][^'"]*$/.test(before) && /[\w$'"/.-]/.test(typed)) return true
  if (/\$\{\s*[\w$]*$/.test(before) && /[\w${]/.test(typed)) return true
  if (template) {
    if (/<\/?[\w:-]*$/.test(before) && /[\w:<-]/.test(typed)) return true
    if (/<is[\w-]*(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?\s[\w-]*$/.test(before) && /[\s\w-]/.test(typed)) return true
  }
  return false
}

/** The items whose label holds what is typed, those that start with it first; the engine's order kept. */
export function filterItems(items: readonly CompletionItem[], typed: string): CompletionItem[] {
  if (!typed) return [...items]
  const lower = typed.toLowerCase()
  const starting: CompletionItem[] = []
  const holding: CompletionItem[] = []
  for (const item of items) {
    const label = item.label.toLowerCase()
    if (label.startsWith(lower)) starting.push(item)
    else if (label.includes(lower)) holding.push(item)
  }
  return [...starting, ...holding]
}

type Open = {
  /** The answer drawn: its range and context, as the engine said them on the text of `length`. */
  completion: Completion
  length: number
  shown: CompletionItem[]
  selected: number
  description: Section[] | null
}

export class CompletionController {
  private readonly ctx: FeatureContext
  private readonly latest: Latest
  private readonly describing: Latest
  private open: Open | null = null
  private reask: unknown = null
  private describeTimer: unknown = null

  constructor(ctx: FeatureContext) {
    this.ctx = ctx
    this.latest = new Latest(ctx.document)
    this.describing = new Latest(ctx.document)
  }

  get isOpen(): boolean {
    return this.open !== null
  }

  /** Ctrl+Space: ask here, and say so when the engine has nothing. */
  explicit(startedAt: number): void {
    void this.ask(true, startedAt)
  }

  /** A key typed text (after the model took it): open by itself where the engine may answer. */
  typed(text: string, startedAt: number): void {
    if (this.open) return
    const head = this.ctx.model.selection.head
    const before = this.ctx.model.buffer.line(head.line).slice(0, head.col)
    const file = this.ctx.file()
    if (file && opensAfter(before, text, /\.isml$/i.test(file.path))) void this.ask(false, startedAt)
  }

  /** The text changed: the open list is filtered now, and the engine asked again shortly. */
  changed(startedAt: number): void {
    const open = this.open
    if (!open) return
    const typed = this.typedSince(open)
    if (typed === null) {
      this.close()
      return
    }
    open.shown = filterItems(open.completion.items, typed)
    open.selected = 0
    this.draw()
    this.ctx.clearTimer(this.reask)
    this.reask = this.ctx.setTimer(() => void this.ask(false, startedAt, true), REASK_DELAY_MS)
  }

  /** The caret moved without typing: the list closes once it leaves the range. */
  caretMoved(): void {
    if (this.open && this.typedSince(this.open) === null) this.close()
  }

  /** A key while the list is open: true when the list took it. */
  key(press: KeyPress): boolean {
    const open = this.open
    if (!open) return false
    const action = listKey(press, true)
    if (!action) return false
    const count = open.shown.length
    if (action === 'close') {
      this.close()
      return true
    }
    if (count === 0) return action !== 'accept'
    if (action === 'accept') return this.accept()
    const step = action === 'up' ? -1 : action === 'down' ? 1 : action === 'pageUp' ? -PAGE_ROWS : PAGE_ROWS
    const next = action === 'up' || action === 'down' ? (open.selected + step + count) % count : Math.max(0, Math.min(count - 1, open.selected + step))
    this.select(next)
    return true
  }

  /** A row clicked. */
  choose(index: number): void {
    if (!this.open || index < 0 || index >= this.open.shown.length) return
    this.open.selected = index
    this.accept()
  }

  select(index: number): void {
    const open = this.open
    if (!open || index < 0 || index >= open.shown.length || index === open.selected) return
    open.selected = index
    open.description = null
    this.draw()
    this.describeLater()
  }

  /** Replaces the engine's range (moved by what was typed since) with the selected item. */
  accept(): boolean {
    const open = this.open
    if (!open) return false
    const item = open.shown[open.selected]
    if (!item || this.ctx.model.readOnly) {
      this.close()
      return Boolean(item)
    }
    const document = this.ctx.document
    const caret = document.caret()
    const delta = document.length - open.length
    const start = open.completion.range.start
    const end = Math.max(caret, open.completion.range.end + delta)
    this.close()
    this.ctx.model.edit(document.posOf(start), document.posOf(end), item.label, 'insert')
    this.ctx.model.history.seal()
    this.ctx.reveal(this.ctx.model.selection.head)
    return true
  }

  close(): void {
    this.latest.cancel()
    this.describing.cancel()
    this.ctx.clearTimer(this.reask)
    this.ctx.clearTimer(this.describeTimer)
    if (this.open) {
      this.open = null
      this.ctx.ui.list(null)
    }
  }

  /** What was typed in the range since the list's answer; null once the caret left it or typed past a name. */
  private typedSince(open: Open): string | null {
    const document = this.ctx.document
    const caret = document.caret()
    const start = open.completion.range.start
    const end = open.completion.range.end + (document.length - open.length)
    if (caret < start || caret > Math.max(end, start)) return null
    const typed = document.text().slice(start, caret)
    const allowed = NAME_CONTEXTS.has(open.completion.context) ? /^[\w$:-]*$/ : /^[^'"\s<>]*$/
    return allowed.test(typed) ? typed : null
  }

  private async ask(explicit: boolean, startedAt: number, again = false): Promise<void> {
    const query = queryAt(this.ctx, this.ctx.document.caret())
    if (!query) {
      if (explicit) hint(this.ctx, 'noSuggestions')
      return
    }
    const current = this.latest.begin()
    let answer: EngineCompletion
    try {
      answer = await this.ctx.requests.complete(plain(query))
    } catch {
      return
    }
    // An answer for an older text, offset or request is never drawn.
    if (!current() || this.ctx.document.caret() !== query.offset) return
    noteState(this.ctx, answer, query.located)
    const completion = answer.completion
    if (answer.error || completion.items.length === 0 || completion.context === 'none') {
      this.close()
      if (explicit) hint(this.ctx, 'noSuggestions')
      return
    }
    const previous = this.open?.shown[this.open.selected]?.id
    const shown = filterItems(completion.items, query.text.slice(completion.range.start, query.offset))
    const kept = previous ? shown.findIndex((item) => item.id === previous) : -1
    this.open = { completion, length: query.text.length, shown, selected: Math.max(0, kept), description: kept >= 0 ? (this.open?.description ?? null) : null }
    this.draw()
    this.ctx.measured('complete', this.ctx.now() - startedAt)
    if (kept < 0) this.describeLater()
  }

  private describeLater(): void {
    this.ctx.clearTimer(this.describeTimer)
    this.describeTimer = this.ctx.setTimer(() => void this.describe(), DESCRIBE_DELAY_MS)
  }

  private async describe(): Promise<void> {
    const open = this.open
    const item = open?.shown[open.selected]
    if (!open || !item) return
    const query = queryAt(this.ctx, this.ctx.document.caret())
    if (!query) return
    const current = this.describing.begin()
    try {
      const answer = await this.ctx.requests.hover({ ...plain(query), id: item.id })
      if (!current() || this.open !== open || open.shown[open.selected] !== item || !answer.hover) return
      open.description = hoverSections(this.ctx.locale, answer.hover)
      // The item's own label and kind are on its row: the description adds what they do not say.
      if (hoverLink(answer.hover) === null && open.description.length === 0) open.description = null
      this.draw()
    } catch {
      // No description: the row says what the item is.
    }
  }

  private draw(): void {
    const open = this.open
    if (!open) return
    if (open.shown.length === 0) {
      this.ctx.ui.list(null)
      return
    }
    const view: ListView = {
      role: 'completion',
      anchor: this.ctx.document.posOf(open.completion.range.start),
      title: null,
      items: open.shown.map((item) => ({ label: item.label, detail: item.detail, note: kindWord(this.ctx.locale, item.kind), deprecated: item.deprecated === true })),
      selected: open.selected,
      description: open.description
    }
    this.ctx.ui.list(view)
  }
}
