// The language features of phase 7.2 together: completion, hover, underlined warnings, go to
// definition, signature help and references, each asked of the engine through the worker. This
// routes what the surface hears (a key before the editor takes it, text typed, a change, a caret
// move, the pointer) to them. No DOM: dom.ts turns the frame's events into these calls and draws
// what they decide, so every feature, its keys and its stale answers are tested in Node.
//
// Typing never waits for an answer: every request is fired and forgotten, and an answer for a text,
// an offset or a request older than the newest is dropped (`Latest` in document.ts).
//
// Every pop-up goes through one tracked UI, so Escape closes the one opened last, one per press,
// and is taken only when it closed one; with none open the key goes on as before.
import type { FeatureContext } from './context'
import type { FeatureUi, ValueAt } from './ui'
import { CompletionController } from './completion'
import { HoverController } from './hover'
import { featureKey, type KeyPress } from './keys'
import { NavigationController } from './navigation'
import { ProblemsController } from './problems'
import { SignatureController } from './signature'

type Popup = 'list' | 'hover' | 'signature' | 'hint'

export class Features {
  readonly completion: CompletionController
  readonly hover: HoverController
  readonly problems: ProblemsController
  readonly navigation: NavigationController
  readonly signature: SignatureController
  private readonly ctx: FeatureContext
  private readonly isMac: boolean
  /** The pop-ups shown, the one opened last at the end. */
  private readonly order: Popup[] = []
  /** What was said once per state (the index, a file too large), forgotten when the file changes name. */
  private readonly told = new Set<string>()

  constructor(context: Omit<FeatureContext, 'tellOnce'>, options: { isMac?: boolean } = {}) {
    const ui = this.tracked(context.ui)
    const ctx: FeatureContext = {
      ...context,
      ui,
      tellOnce: (key, text) => {
        if (this.told.has(key)) return
        this.told.add(key)
        ui.hint({ anchor: context.model.selection.head, text })
      }
    }
    this.ctx = ctx
    this.isMac = options.isMac ?? false
    this.problems = new ProblemsController(ctx)
    this.completion = new CompletionController(ctx)
    this.hover = new HoverController(ctx, (offset) => this.problems.at(offset))
    this.navigation = new NavigationController(ctx)
    this.signature = new SignatureController(ctx)
  }

  /** Records which pop-up is shown, so Escape closes the one opened last. */
  private tracked(inner: FeatureUi): FeatureUi {
    const mark = (popup: Popup, shown: boolean) => {
      const at = this.order.indexOf(popup)
      if (at !== -1) this.order.splice(at, 1)
      if (shown) this.order.push(popup)
    }
    return {
      list: (view) => (mark('list', view !== null), inner.list(view)),
      hover: (view) => (mark('hover', view !== null), inner.hover(view)),
      signature: (view) => (mark('signature', view !== null), inner.signature(view)),
      hint: (view) => (mark('hint', view !== null), inner.hint(view)),
      underlines: (list) => inner.underlines(list)
    }
  }

  /** Escape: the pop-up opened last closes; false when none is open. */
  private closeTopmost(): boolean {
    const popup = this.order[this.order.length - 1]
    if (!popup) return false
    if (popup === 'list') {
      this.completion.close()
      this.navigation.close()
    } else if (popup === 'hover') this.hover.close()
    else if (popup === 'signature') this.signature.close()
    else this.ctx.ui.hint(null)
    // Whatever drew it is closed: it is no longer the one opened last.
    const at = this.order.indexOf(popup)
    if (at !== -1) this.order.splice(at, 1)
    return true
  }

  /** The debugger's value under a place while halted (7.3), shown first in the pointer pop-up. */
  setValueSource(valueAt: ValueAt | null): void {
    this.hover.valueAt = valueAt
  }

  /** The debugger's state changed: a value shown may be gone. */
  debugChanged(): void {
    this.hover.debugChanged()
  }

  /** A key before the editor takes it: true when a feature took it (the editor then does nothing). */
  keyDown(press: KeyPress, startedAt = this.ctx.now()): boolean {
    if (press.key === 'Escape' && !press.ctrl && !press.meta && !press.alt && !press.shift) return this.closeTopmost()
    this.ctx.ui.hint(null)
    const asked = featureKey(press, this.isMac)
    if (asked) {
      const offset = this.ctx.document.caret()
      if (asked === 'complete') {
        this.navigation.close()
        this.completion.explicit(startedAt)
      } else if (asked === 'signature') this.signature.explicit(startedAt)
      else if (asked === 'hover') this.hover.atCaret(startedAt)
      else if (asked === 'definition') {
        this.completion.close()
        void this.navigation.definition(offset, startedAt)
      } else {
        this.completion.close()
        void this.navigation.references(offset, startedAt)
      }
      return true
    }
    if (this.completion.key(press)) return true
    if (this.navigation.key(press)) return true
    return false
  }

  /** Text a key typed, after the model took it. */
  typed(text: string, startedAt = this.ctx.now()): void {
    this.completion.typed(text, startedAt)
    this.signature.typed(text, startedAt)
  }

  /** The text changed (typing, a paste, undo, an outside write). */
  changed(startedAt = this.ctx.now()): void {
    this.hover.close()
    this.navigation.close()
    this.completion.changed(startedAt)
    this.signature.follow(startedAt)
    this.problems.changed(startedAt)
  }

  /** The caret moved with no change of the text. */
  caretMoved(startedAt = this.ctx.now()): void {
    this.completion.caretMoved()
    this.hover.caretMoved()
    this.signature.follow(startedAt)
  }

  /** The pointer rested on an offset of the text (null: off the text). */
  pointerRest(offset: number | null, startedAt = this.ctx.now()): void {
    if (this.completion.isOpen || this.navigation.isOpen) return
    this.hover.rest(offset, startedAt)
  }

  pointerMoved(offset: number | null, overPopup: boolean): void {
    this.hover.moved(offset, overPopup)
  }

  /** Mod+click on an offset: go to its definition. */
  definitionAt(offset: number, startedAt = this.ctx.now()): void {
    this.dismiss()
    void this.navigation.definition(offset, startedAt)
  }

  /** The file was named (or no longer is): problems asked again, pop-ups of the old name closed. */
  identityChanged(): void {
    this.told.clear()
    this.dismiss()
    this.problems.identityChanged()
  }

  /** A click elsewhere, or the editor lost focus: every pop-up closes. */
  dismiss(): void {
    this.completion.close()
    this.navigation.close()
    this.hover.close()
    this.signature.close()
    this.ctx.ui.hint(null)
  }

  dispose(): void {
    this.dismiss()
    this.problems.dispose()
  }
}
