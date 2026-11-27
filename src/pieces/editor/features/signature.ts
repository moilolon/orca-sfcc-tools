// Signature help: inside a call's parentheses, `engine.signature` gives the signatures of what it
// reaches and the argument the caret is at; the active signature is drawn over the line with that
// parameter marked. It opens after `(` and `,` are typed and with Ctrl+Shift+Space, follows the
// caret while open (asked again after a short pause, the newest answer only), and closes outside
// the parentheses or on Escape. Pure: no DOM.
import type { EngineSignature, Signature, SignatureHelp } from '../../engine/protocol'
import { hint, plain, queryAt, type FeatureContext } from './context'
import { Latest } from './document'
import type { Section, SignatureView } from './ui'
import { engineWord, MAX_TEXT, word } from './words'

/** How long the caret rests, while the help is shown, before it is asked again. */
export const SIGNATURE_DELAY_MS = 60

/** A signature's label split around its active parameter (found in order after the opening parenthesis). */
export function splitLabel(signature: Pick<Signature, 'label' | 'parameters'>, active: number): { before: string; active: string; after: string } {
  const label = signature.label
  let from = label.indexOf('(') + 1
  for (let i = 0; i < signature.parameters.length; i++) {
    const at = label.indexOf(signature.parameters[i].label, from)
    if (at === -1) break
    const end = at + signature.parameters[i].label.length
    if (i === active) return { before: label.slice(0, at), active: label.slice(at, end), after: label.slice(end) }
    from = end
  }
  return { before: label, active: '', after: '' }
}

export function signatureView(locale: string, help: SignatureHelp, anchor: SignatureView['anchor']): SignatureView | null {
  const signature = help.signatures[help.activeSignature] ?? help.signatures[0]
  if (!signature) return null
  const parts = splitLabel(signature, help.activeParameter)
  const sections: Section[] = []
  if (signature.deprecated) sections.push({ tone: 'warning', text: engineWord(locale, 'deprecated') })
  if (signature.doc) sections.push({ tone: 'text', text: signature.doc.length > MAX_TEXT ? `${signature.doc.slice(0, MAX_TEXT - 1)}…` : signature.doc })
  if (signature.path && signature.line) sections.push({ tone: 'muted', text: engineWord(locale, 'definedIn', { path: signature.path, line: signature.line }) })
  if (signature.storefronts && signature.storefronts.length > 0) sections.push({ tone: 'muted', text: engineWord(locale, 'runsOn', { storefront: signature.storefronts.join(', ') }) })
  const note = help.signatures.length > 1 ? word(locale, 'signatureOf', { active: help.signatures.indexOf(signature) + 1, count: help.signatures.length }) : null
  return { anchor, ...parts, note, sections }
}

export class SignatureController {
  private readonly ctx: FeatureContext
  private readonly latest: Latest
  private shown = false
  private timer: unknown = null

  constructor(ctx: FeatureContext) {
    this.ctx = ctx
    this.latest = new Latest(ctx.document)
  }

  get isOpen(): boolean {
    return this.shown
  }

  /** Ctrl+Shift+Space. */
  explicit(startedAt: number): void {
    void this.ask(true, startedAt)
  }

  /** `(` or `,` typed opens it; `)` may close it. */
  typed(text: string, startedAt: number): void {
    if (text === '(' || text === ',' || (text === ')' && this.shown)) void this.ask(false, startedAt)
  }

  /** The text changed or the caret moved while it is shown: asked again after a short pause. */
  follow(startedAt: number): void {
    if (!this.shown) return
    this.ctx.clearTimer(this.timer)
    this.timer = this.ctx.setTimer(() => void this.ask(false, startedAt), SIGNATURE_DELAY_MS)
  }

  close(): void {
    this.latest.cancel()
    this.ctx.clearTimer(this.timer)
    if (this.shown) {
      this.shown = false
      this.ctx.ui.signature(null)
    }
  }

  private async ask(explicit: boolean, startedAt: number): Promise<void> {
    const offset = this.ctx.document.caret()
    const query = queryAt(this.ctx, offset)
    if (!query) return
    const current = this.latest.begin()
    let answer: EngineSignature
    try {
      answer = await this.ctx.requests.signature(plain(query))
    } catch {
      return
    }
    if (!current() || this.ctx.document.caret() !== offset) return
    const help = answer.signature
    const view = help ? signatureView(this.ctx.locale, help, this.ctx.document.posOf(help.range.start)) : null
    if (!view) {
      this.close()
      if (explicit) hint(this.ctx, 'noSignature')
      return
    }
    this.shown = true
    this.ctx.ui.signature(view)
    this.ctx.measured('signature', this.ctx.now() - startedAt)
  }
}
