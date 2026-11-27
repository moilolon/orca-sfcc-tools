// What the editor may ask the value of while a thread is halted (the value under the cursor, phase
// 7.3): a plain name, `this`, or a chain of property reads on one (`basket.totalGrossPrice`,
// `items[0].id`, `map['key']`), and nothing else. The engine's parser reads the text; any call,
// `new`, assignment, update (`++`, `--`), `delete`, operator, template, function, comma, optional
// chain or index with anything but a literal is refused, and so is a text the parser reports a
// problem in or that holds a comment.
//
// What passes is never evaluated: it is a path of names (`['basket', 'totalGrossPrice']`) that the
// worker walks through the halted frame's scopes and their members, with the same `scopes` and
// `variables` requests the debugger's view makes when a person expands those names in its tree. A
// hover therefore never runs anything that expanding the same names would not: no getter beyond
// those the tree's own listing runs (`BasketMgr.currentOrNewBasket` is read only if the adapter
// lists it among `BasketMgr`'s members, as the tree would show it). Pure: no Node, no Orca.
import type { Expression, Super } from '../engine/js/ast'
import { parseExpression } from '../engine/js/parser'

/** A longer text is refused before it is parsed. */
export const MAX_INSPECT_LENGTH = 200
/** Links of a chain past this are refused. */
export const MAX_INSPECT_LINKS = 16

const NAME = /^[A-Za-z_$][\w$]*$/
/** Names that read nothing: a keyword the parser may take as a name, never a value of the script. */
const NOT_NAMES = new Set(['new', 'delete', 'void', 'typeof', 'function', 'class', 'import', 'super', 'yield', 'await', 'eval'])

/** A plain read: the text shown for it, rebuilt from its tree, and the names to walk, outermost first. */
export type PlainRead = { expression: string; path: string[] }

/** The plain read `text` is, or null for anything else. */
export function plainRead(text: unknown): PlainRead | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_INSPECT_LENGTH) return null
  const parsed = parseExpression(trimmed)
  if (parsed.problems.length > 0 || parsed.comments.length > 0) return null
  return rebuild(parsed.expression)
}

function rebuild(root: Expression | Super): PlainRead | null {
  // From the outermost link inwards, without recursion; the parts are put in order at the end.
  const parts: string[] = []
  const path: string[] = []
  let node: Expression | Super = root
  for (let links = 0; ; links++) {
    if (links > MAX_INSPECT_LINKS) return null
    if (node.type === 'Identifier') {
      if (!NAME.test(node.name) || NOT_NAMES.has(node.name)) return null
      parts.push(node.name)
      path.push(node.name)
      break
    }
    if (node.type === 'ThisExpression') {
      parts.push('this')
      path.push('this')
      break
    }
    if (node.type !== 'MemberExpression' || node.optional) return null
    const property = node.property
    if (!node.computed) {
      if (property.type !== 'Identifier' || !NAME.test(property.name)) return null
      parts.push(`.${property.name}`)
      path.push(property.name)
    } else if (property.type === 'Literal' && property.kind === 'string' && typeof property.value === 'string') {
      parts.push(`[${JSON.stringify(property.value)}]`)
      path.push(property.value)
    } else if (property.type === 'Literal' && property.kind === 'number' && typeof property.value === 'number' && Number.isSafeInteger(property.value) && property.value >= 0) {
      parts.push(`[${property.value}]`)
      path.push(String(property.value))
    } else return null
    node = node.object
  }
  return { expression: parts.reverse().join(''), path: path.reverse() }
}
