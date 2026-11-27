// ISML one line at a time: HTML and ISML tags (`<is…>`, custom tags included), attributes and
// their values, `${…}` in text, in values and among a tag's attributes, ISML tags inside a value,
// `<!-- -->` and `<iscomment>`, and the bodies of `<isscript>` and `<script>` as JavaScript, read
// by the engine's lexer through `lexJs`. The engine's parser (src/pieces/engine/isml/parser.ts)
// reads a whole template; a highlighter needs a state per line, so this follows its rules where a
// line can: an unclosed `${` ends before a line that starts with a tag.
//
// The state is a stack of frames, outermost first, then `|` and the JavaScript state of the top
// frame when it holds code: `x` text, `h` an HTML comment, `k` an `<iscomment>` body, `g<kind>`
// inside a tag (`h` HTML, `i` ISML, `c` iscomment, `s` isscript, `S` script, `y` style, and `/`
// before the kind for an end tag), `q"` or `q'` a quoted value, `e` a `${…}`, `j` an
// `<isscript>` body, `J` a `<script>` body, `Y` a `<style>` body.
import { lexJs, JS_INITIAL } from './js'
import { C, push, type LineLexer, type LineTokens } from './tokens'

/** Frames deeper than this are not opened (a value inside a tag inside a value, …). */
const MAX_FRAMES = 12

const isLetter = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90)
const isSpace = (c: number) => c === 32 || c === 9 || c === 12 || c === 0xa0 || c === 0xfeff
const NAME = /[A-Za-z][\w:.-]*/y

/** The kind of a tag's frame, from its lower-case name. */
function kindOf(name: string): string {
  if (name === 'iscomment') return 'c'
  if (name === 'isscript') return 's'
  if (name === 'script') return 'S'
  if (name === 'style') return 'y'
  return name.startsWith('is') ? 'i' : 'h'
}

/** Whether the text from `at` starts with `word`, ignoring case. */
function startsWithIgnoringCase(text: string, at: number, word: string): boolean {
  return text.length - at >= word.length && text.slice(at, at + word.length).toLowerCase() === word
}

function indexOfIgnoringCase(text: string, word: string, from: number): number {
  return text.toLowerCase().indexOf(word, from)
}

/** Whether a line starts, after spaces, with a tag: where an unclosed `${` stops. */
function startsWithTag(text: string): boolean {
  let p = 0
  while (p < text.length && isSpace(text.charCodeAt(p))) p++
  if (text.charCodeAt(p) !== 60) return false
  const next = text.charCodeAt(p + 1)
  return isLetter(next) || next === 47 || next === 33
}

export function lexIsmlLine(text: string, state: string): { tokens: LineTokens; state: string } {
  const bar = state.indexOf('|')
  const frames = (bar === -1 ? state : state.slice(0, bar)).split(' ').filter(Boolean)
  if (frames.length === 0) frames.push('x')
  let js = bar === -1 ? '' : state.slice(bar + 1)
  const out: LineTokens = []
  const n = text.length
  let i = 0
  const top = () => frames[frames.length - 1]
  const open = (frame: string, code = '') => {
    if (frames.length >= MAX_FRAMES) return false
    frames.push(frame)
    js = code
    return true
  }
  const close = () => {
    if (frames.length > 1) frames.pop()
    js = ''
  }

  // A `${` left open by the line before ends here when this line starts with a tag.
  if (top() === 'e' && startsWithTag(text)) close()

  /** A tag starting at `i` (on its `<`): its name, and the frame for its attributes. */
  const openTag = (): boolean => {
    const end = text.charCodeAt(i + 1) === 47
    const nameAt = i + (end ? 2 : 1)
    NAME.lastIndex = nameAt
    const match = NAME.exec(text)
    if (!match) return false
    const name = match[0].toLowerCase()
    push(out, i, nameAt, C.punct)
    push(out, nameAt, nameAt + match[0].length, name.startsWith('is') ? C.istag : C.tag)
    i = nameAt + match[0].length
    const kind = kindOf(name)
    open('g' + (end ? '/' + (kind === 'h' ? 'h' : 'i') : kind))
    return true
  }

  for (let guard = 0; i < n && guard <= n * 2 + 8; guard++) {
    const frame = top()
    const mode = frame[0]
    if (mode === 'x') {
      let p = i
      while (p < n) {
        const c = text.charCodeAt(p)
        if (c === 60 /* < */) break
        if (c === 36 /* $ */ && text.charCodeAt(p + 1) === 123) break
        p++
      }
      push(out, i, p, C.plain)
      i = p
      if (i >= n) break
      if (text.charCodeAt(i) === 36) {
        push(out, i, i + 2, C.expr)
        i += 2
        if (!open('e', JS_INITIAL + 'e')) push(out, i, n, C.plain), (i = n)
        continue
      }
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4)
        if (end === -1) {
          push(out, i, n, C.comment)
          open('h')
          i = n
        } else {
          push(out, i, end + 3, C.comment)
          i = end + 3
        }
        continue
      }
      if (text.charCodeAt(i + 1) === 33 /* ! */) {
        // A doctype or a CDATA section: a declaration up to its `>`.
        const end = text.indexOf('>', i)
        push(out, i, end === -1 ? n : end + 1, C.meta)
        i = end === -1 ? n : end + 1
        continue
      }
      if (!openTag()) {
        push(out, i, i + 1, C.plain)
        i++
      }
      continue
    }
    if (mode === 'h' || mode === 'k' || mode === 'j' || mode === 'J' || mode === 'Y') {
      const word = mode === 'h' ? '-->' : mode === 'k' ? '</iscomment' : mode === 'j' ? '</isscript' : mode === 'J' ? '</script' : '</style'
      const stop = mode === 'h' ? text.indexOf(word, i) : indexOfIgnoringCase(text, word, i)
      const until = stop === -1 ? n : stop
      if (mode === 'h' || mode === 'k') push(out, i, mode === 'h' && stop !== -1 ? stop + 3 : until, C.comment)
      else if (mode === 'Y') push(out, i, until, C.plain)
      else js = lexJs(text, i, until, js || JS_INITIAL, out).state
      if (stop === -1) {
        i = n
        break
      }
      i = mode === 'h' ? stop + 3 : stop
      close()
      continue
    }
    if (mode === 'e') {
      const run = lexJs(text, i, n, js || JS_INITIAL + 'e', out)
      if (run.closedAt === null) {
        js = run.state
        i = n
        break
      }
      i = run.closedAt
      close()
      continue
    }
    if (mode === 'q') {
      const quote = frame.charCodeAt(1)
      let p = i
      while (p < n) {
        const c = text.charCodeAt(p)
        if (c === quote) break
        if (c === 36 && text.charCodeAt(p + 1) === 123) break
        if (c === 60 && (startsWithIgnoringCase(text, p + 1, 'is') || startsWithIgnoringCase(text, p + 1, '/is'))) break
        p++
      }
      push(out, i, p, C.string)
      i = p
      if (i >= n) break
      const c = text.charCodeAt(i)
      if (c === quote) {
        push(out, i, i + 1, C.string)
        i++
        close()
      } else if (c === 36) {
        push(out, i, i + 2, C.expr)
        i += 2
        if (!open('e', JS_INITIAL + 'e')) push(out, i, n, C.string), (i = n)
      } else if (!openTag()) {
        push(out, i, i + 1, C.string)
        i++
      }
      continue
    }
    // Inside a tag: attributes, `=`, values, `${…}`, ISML tags, and the end of the tag.
    const c = text.charCodeAt(i)
    if (isSpace(c)) {
      i++
      continue
    }
    if (c === 62 /* > */ || (c === 47 && text.charCodeAt(i + 1) === 62)) {
      const selfClosing = c === 47
      push(out, i, i + (selfClosing ? 2 : 1), C.punct)
      i += selfClosing ? 2 : 1
      const kind = frame.slice(1)
      close()
      if (!selfClosing) {
        if (kind === 'c') open('k')
        else if (kind === 's') open('j', JS_INITIAL)
        else if (kind === 'S') open('J', JS_INITIAL)
        else if (kind === 'y') open('Y')
      }
      continue
    }
    if (c === 36 && text.charCodeAt(i + 1) === 123) {
      push(out, i, i + 2, C.expr)
      i += 2
      open('e', JS_INITIAL + 'e')
      continue
    }
    if (c === 60 && (startsWithIgnoringCase(text, i + 1, 'is') || startsWithIgnoringCase(text, i + 1, '/is')) && openTag()) continue
    if (c === 61 /* = */) {
      push(out, i, i + 1, C.punct)
      i++
      continue
    }
    if (c === 34 || c === 39) {
      push(out, i, i + 1, C.string)
      i++
      open('q' + String.fromCharCode(c))
      continue
    }
    // A name, or an unquoted value right after `=`.
    let p = i
    while (p < n) {
      const d = text.charCodeAt(p)
      if (isSpace(d) || d === 61 || d === 62 || d === 34 || d === 39 || d === 60 || (d === 47 && text.charCodeAt(p + 1) === 62)) break
      if (d === 36 && text.charCodeAt(p + 1) === 123) break
      p++
    }
    if (p === i) p = i + 1
    const afterEquals = out.length >= 3 && out[out.length - 1] === C.punct && text.charCodeAt(out[out.length - 2] - 1) === 61 && out[out.length - 2] === i
    push(out, i, p, afterEquals ? C.string : C.attr)
    i = p
  }
  return { tokens: out, state: frames.join(' ') + '|' + js }
}

export const isml: LineLexer = {
  initial: 'x|',
  line: lexIsmlLine
}
