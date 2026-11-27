// JavaScript one line at a time, with the engine's own lexer (src/pieces/engine/js/lexer.ts) for
// every token: the state carried from line to line says only what a line cannot see by itself
// (inside a block comment, inside a template literal, whether a `/` starts a regex, and which
// braces are open inside a template's `${` or an ISML `${`). ISML reads its `${…}` and
// `<isscript>` with `lexJs` too, on a part of a line.
//
// A state is `<mode><slash><stack>`: mode `n` code, `c` block comment, `t` template literal;
// slash `r` (a `/` starts a regex) or `d` (divides); stack, innermost last, `s` a template's `${`,
// `e` an ISML `${`, `b` a brace inside one of those (plain code keeps no braces, so its states
// stay short and a change settles quickly).
import { KEYWORDS, Lexer, type Token } from '../../engine/js/lexer'
import type { Comment, Problem } from '../../engine/js/ast'
import { C, push, type LineLexer, type LineTokens } from './tokens'

export const JS_INITIAL = 'nr'
/** How deep the stack of a state may grow; deeper braces are not tracked. */
const MAX_STACK = 32

const MORE_KEYWORDS = new Set(['let', 'yield', 'async', 'await', 'of', 'static', 'get', 'set'])
const LITERALS = new Set(['true', 'false', 'null', 'this', 'super', 'undefined', 'NaN', 'Infinity'])
const VALUE_KEYWORDS = new Set(['this', 'super', 'null', 'true', 'false'])

/** What one part of a line ended in: the state, and where an ISML `${` closed (just after its `}`), if it did. */
export type JsRun = { state: string; closedAt: number | null }

/** Whether a `/` after this token starts a regex. */
function slashAfter(token: Token): 'r' | 'd' {
  switch (token.type) {
    case 'identifier':
    case 'number':
    case 'string':
    case 'regex':
      return 'd'
    case 'template':
      return token.templateTail ? 'd' : 'r'
    case 'keyword':
      return VALUE_KEYWORDS.has(token.value) ? 'd' : 'r'
    case 'punctuator':
      return token.value === ')' || token.value === ']' || token.value === '}' || token.value === '++' || token.value === '--' ? 'd' : 'r'
    default:
      return 'r'
  }
}

/** Where a template literal's text ends from `from`: at a closing backtick or a `${`, or the end. */
function templateText(text: string, from: number, to: number): { end: number; closed: 'tick' | 'substitution' | null } {
  let p = from
  while (p < to) {
    const c = text.charCodeAt(p)
    if (c === 92) {
      p += 2
      continue
    }
    if (c === 96) return { end: p + 1, closed: 'tick' }
    if (c === 36 && text.charCodeAt(p + 1) === 123 && p + 1 < to) return { end: p + 2, closed: 'substitution' }
    p++
  }
  return { end: to, closed: null }
}

/** How a template token read by the engine's lexer ends: closed by a backtick, by `${`, or not at all. */
function templateEnd(text: string, token: Token): 'tick' | 'substitution' | null {
  if (!token.templateTail) return 'substitution'
  return token.end - 1 > token.start && text.charCodeAt(token.end - 1) === 96 ? 'tick' : null
}

/**
 * Lexes `text` from `from` to `to` as JavaScript from `state`, adding tokens to `out`. Stops early
 * when a `}` closes an ISML `${` (the `e` at the top of the stack): that `}` is an `expr` token and
 * `closedAt` is just after it.
 */
export function lexJs(text: string, from: number, to: number, state: string, out: LineTokens): JsRun {
  let mode = state[0] ?? 'n'
  let slash = state[1] === 'd' ? 'd' : 'r'
  let stack = state.slice(2)
  let at = from
  const push1 = (frame: string) => {
    if (stack.length < MAX_STACK) stack += frame
  }
  const inside = () => stack.length > 0

  if (mode === 'c') {
    const close = text.indexOf('*/', at)
    if (close === -1 || close + 2 > to) {
      push(out, at, to, C.comment)
      return { state: 'c' + slash + stack, closedAt: null }
    }
    push(out, at, close + 2, C.comment)
    at = close + 2
    mode = 'n'
  }
  if (mode === 't') {
    const run = templateText(text, at, to)
    push(out, at, run.end, C.string)
    at = run.end
    if (run.closed === null) return { state: 't' + slash + stack, closedAt: null }
    if (run.closed === 'substitution') {
      push1('s')
      slash = 'r'
    } else slash = 'd'
    mode = 'n'
  }

  const comments: Comment[] = []
  const problems: Problem[] = []
  // The engine's lexer skips a shebang only at offset 0 of its text; a line never is one here.
  const lexer = new Lexer(text, at, to, comments, problems)
  if (at === 0 && text.startsWith('#!')) lexer.pos = 0
  let emitted = 0
  let previousWord = ''
  const flushComments = (before: number) => {
    while (emitted < comments.length && comments[emitted].start < before) {
      const comment = comments[emitted++]
      push(out, comment.start, comment.end, C.comment)
    }
  }
  for (let guard = 0; guard <= to - at + 2; guard++) {
    let token = lexer.next()
    flushComments(token.start)
    if (token.type === 'eof') break
    if (token.type === 'punctuator' && (token.value === '/' || token.value === '/=') && slash === 'r') {
      token = lexer.rescanRegex(token)
    } else if (token.type === 'punctuator' && token.value === '}' && inside()) {
      const top = stack[stack.length - 1]
      stack = stack.slice(0, -1)
      if (top === 'e') {
        push(out, token.start, token.end, C.expr)
        return { state: 'n' + 'd' + stack, closedAt: token.end }
      }
      if (top === 's') {
        token = lexer.rescanTemplate(token)
        const end = templateEnd(text, token)
        push(out, token.start, token.end, C.string)
        if (end === 'substitution') {
          push1('s')
          slash = 'r'
        } else slash = 'd'
        if (end === null) return { state: 't' + slash + stack, closedAt: null }
        continue
      }
    } else if (token.type === 'punctuator' && token.value === '{' && inside()) {
      push1('b')
    }
    switch (token.type) {
      case 'template': {
        push(out, token.start, token.end, C.string)
        const end = templateEnd(text, token)
        if (end === 'substitution') push1('s')
        if (end === null) return { state: 't' + 'd' + stack, closedAt: null }
        break
      }
      case 'keyword':
        push(out, token.start, token.end, LITERALS.has(token.value) ? C.literal : C.keyword)
        break
      case 'identifier': {
        const word = token.value
        const keyword = MORE_KEYWORDS.has(word) || (word === 'each' && previousWord === 'for')
        push(out, token.start, token.end, LITERALS.has(word) ? C.literal : keyword ? C.keyword : C.plain)
        break
      }
      case 'number':
        push(out, token.start, token.end, C.number)
        break
      case 'string':
        push(out, token.start, token.end, C.string)
        break
      case 'regex':
        push(out, token.start, token.end, C.regex)
        break
      case 'punctuator':
        push(out, token.start, token.end, C.punct)
        break
      default:
        push(out, token.start, token.end, C.plain)
    }
    previousWord = token.type === 'keyword' || token.type === 'identifier' ? token.value : ''
    slash = slashAfter(token)
  }
  flushComments(to + 1)
  // A block comment the lexer could not close goes on into the next line.
  const last = comments[comments.length - 1]
  if (last && last.kind !== 'line' && last.end === to && !(last.end - last.start >= 4 && text.startsWith('*/', last.end - 2))) {
    return { state: 'c' + slash + stack, closedAt: null }
  }
  return { state: 'n' + slash + stack, closedAt: null }
}

/** JavaScript files (`.js`, `.ds`). */
export const javascript: LineLexer = {
  initial: JS_INITIAL,
  line(text, state) {
    const tokens: LineTokens = []
    const run = lexJs(text, 0, text.length, state, tokens)
    return { tokens, state: run.state }
  }
}

export { KEYWORDS }
