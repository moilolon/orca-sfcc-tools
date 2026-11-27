// The name under the pointer while a thread is halted, as the text to evaluate: a plain name, or the
// chain of property reads that ends at the hovered name (`basket.totalGrossPrice` when the pointer
// is on `totalGrossPrice` of `basket.totalGrossPrice.value`). Read with the engine's parser, so a
// name inside a string or a comment is none. Anything else under the pointer (a call's result, a
// computed index, an object key, a keyword) gives nothing. The worker checks the text again with
// its own guard (src/pieces/debugger/inspect.ts) before anything reaches the adapter. Pure: no DOM,
// no Orca.
import type { Expression, Node, Program, Super } from '../../engine/js/ast'
import { nodePathAt } from '../../engine/js/ast'
import { parseScript } from '../../engine/js/parser'

/** A text longer than this is not read for a hover. */
export const MAX_HOVER_TEXT = 1_000_000

/** What to evaluate and the range of the text it covers (offsets of the text given). */
export type HoverTarget = { expression: string; from: number; to: number }

/** Whether a node is a plain read: a name, `this`, or property reads on one, with literal indexes only. */
function plain(node: Expression | Super): boolean {
  let current: Expression | Super = node
  for (let links = 0; links <= 16; links++) {
    if (current.type === 'Identifier' || current.type === 'ThisExpression') return true
    if (current.type !== 'MemberExpression' || current.optional) return false
    if (current.computed && !(current.property.type === 'Literal' && (current.property.kind === 'string' || current.property.kind === 'number'))) return false
    current = current.object
  }
  return false
}

/** Reads a script once per text and finds hover targets in it. */
export class HoverReader {
  private text: string | null = null
  private program: Program | null = null

  private parsed(text: string): Program | null {
    if (text.length > MAX_HOVER_TEXT) return null
    if (this.text !== text) {
      this.text = text
      this.program = parseScript(text).program
    }
    return this.program
  }

  /** The plain read that ends at the name under `offset`, or null. */
  at(text: string, offset: number): HoverTarget | null {
    const program = this.parsed(text)
    if (!program) return null
    const path = nodePathAt(program, offset)
    const node = path.at(-1)
    if (!node || (node.type !== 'Identifier' && node.type !== 'ThisExpression')) return null
    const parent = path.at(-2) as Node | undefined
    let target: Expression = node as Expression
    if (parent?.type === 'MemberExpression' && parent.property === node) {
      // A property: the chain up to it, unless it is read by an expression index (`a[b]` on `b` is `b`).
      if (!parent.computed) target = parent
    } else if (parent?.type === 'Property' && parent.key === node && !parent.shorthand && !parent.computed) return null
    else if (parent?.type === 'LabeledStatement' || parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement') return null
    if (!plain(target)) return null
    return { expression: text.slice(target.start, target.end), from: target.start, to: target.end }
  }
}
