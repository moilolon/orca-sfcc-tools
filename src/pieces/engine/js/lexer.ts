// The JavaScript lexer. It never throws: what it cannot read becomes an `invalid` token or a
// token cut short, with a problem. A `/` is scanned as a punctuator; the parser, which knows when
// an expression may start, asks for `rescanRegex` there, and for `rescanTemplate` when a `}`
// closes a `${…}` of a template. `tokenize` reads a whole text without a parser (for
// highlighting), choosing regex or division from the token before. Pure: no Node, no Orca.
import type { Comment, Problem, ProblemCode } from './ast'

export type TokenType =
  | 'identifier'
  | 'keyword'
  | 'punctuator'
  | 'number'
  | 'string'
  /** A chunk of a template literal: `` `…` ``, `` `…${ ``, `` }…${ `` or `` }…` ``. */
  | 'template'
  | 'regex'
  | 'invalid'
  | 'eof'
  /** Only from `tokenize`: a comment. */
  | 'comment'

export interface Token {
  type: TokenType
  /** Identifiers, keywords, punctuators: their text. Strings: the decoded value. Numbers: the text. */
  value: string
  start: number
  end: number
  /** A line break sits between the previous token and this one. */
  newlineBefore: boolean
  /** The last JSDoc comment among the comments right before this token. */
  doc?: Comment
  /** Template chunks: whether it opens with a backtick, whether it closes with one. */
  templateHead?: boolean
  templateTail?: boolean
  /** Template chunks: the text with escapes decoded. */
  cooked?: string
  /** Regex tokens: pattern and flags. */
  regex?: { pattern: string; flags: string }
}

/** Reserved words that never name a binding. `let`, `of`, `get`, `set`, `static`, `each`, `yield` and `async` stay identifiers. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with'
])

// Punctuators, longest first within each starting character.
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '<<', '>>', '**',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!',
  '~', '?', ':', '=', '.', '@', '#'
]
const PUNCTUATORS_BY_CHAR = new Map<number, string[]>()
for (const p of PUNCTUATORS) {
  const list = PUNCTUATORS_BY_CHAR.get(p.charCodeAt(0)) ?? []
  list.push(p)
  PUNCTUATORS_BY_CHAR.set(p.charCodeAt(0), list)
}

const ID_START = /[\p{ID_Start}$_]/u
const ID_CONTINUE = /[\p{ID_Continue}$_\u200c\u200d]/u
const SPACE = /[\p{Zs}\ufeff]/u

const isLineBreak = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029
const isDigit = (c: number) => c >= 48 && c <= 57
// After digits, what may continue a number: `.`, `_`, a letter (`e`, `x`, `n`, or a mistake), `$`, `\`, or beyond ASCII.
const isNumberPart = (c: number) => c === 46 || c === 95 || (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 92 || c > 127
function isIdStart(c: number, text: string, at: number): boolean {
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95) return true
  if (c < 128) return false
  return ID_START.test(String.fromCodePoint(text.codePointAt(at) ?? c))
}
function isIdPart(c: number, text: string, at: number): boolean {
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || isDigit(c) || c === 36 || c === 95) return true
  if (c < 128) return false
  return ID_CONTINUE.test(String.fromCodePoint(text.codePointAt(at) ?? c))
}

/** Reads tokens of `text` between `start` and `end`, collecting comments and problems. */
export class Lexer {
  readonly text: string
  readonly end: number
  pos: number
  readonly comments: Comment[]
  readonly problems: Problem[]
  private commentsEnd = -1

  constructor(text: string, start = 0, end = text.length, comments: Comment[] = [], problems: Problem[] = []) {
    this.text = text
    this.end = Math.min(end, text.length)
    this.pos = start
    this.comments = comments
    this.problems = problems
    // A shebang line at the very start of a file.
    if (start === 0 && text.startsWith('#!')) {
      while (this.pos < this.end && !isLineBreak(text.charCodeAt(this.pos))) this.pos++
    }
  }

  /** Records a problem, unless one of the last few already sits at `start`: a rescan or a cascade never repeats it. */
  report(code: ProblemCode, start: number, end: number, detail?: string): boolean {
    for (let i = this.problems.length - 1; i >= 0 && i >= this.problems.length - 4; i--) {
      if (this.problems[i].start === start) return false
    }
    this.problems.push(detail === undefined ? { code, start, end } : { code, start, end, detail })
    return true
  }

  // What the last `skipTrivia` crossed: a line break, and the last JSDoc comment.
  private triviaNewline = false
  private triviaDoc: Comment | undefined = undefined

  /** Skips spaces, line breaks and comments, noting whether a line break was crossed and the last JSDoc. */
  private skipTrivia(): void {
    const { text, end } = this
    let newline = false
    let doc: Comment | undefined
    while (this.pos < end) {
      const c = text.charCodeAt(this.pos)
      if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0) {
        this.pos++
      } else if (isLineBreak(c)) {
        newline = true
        this.pos++
      } else if (c === 47 /* / */ && this.pos + 1 < end && text.charCodeAt(this.pos + 1) === 47) {
        const start = this.pos
        this.pos += 2
        while (this.pos < end && !isLineBreak(text.charCodeAt(this.pos))) this.pos++
        this.addComment({ kind: 'line', start, end: this.pos, text: text.slice(start + 2, this.pos) })
      } else if (c === 47 && this.pos + 1 < end && text.charCodeAt(this.pos + 1) === 42 /* * */) {
        const start = this.pos
        const close = text.indexOf('*/', this.pos + 2)
        let bodyEnd: number
        if (close === -1 || close + 2 > end) {
          this.report('unterminated_comment', start, end)
          bodyEnd = end
          this.pos = end
        } else {
          bodyEnd = close
          this.pos = close + 2
        }
        const body = text.slice(start + 2, bodyEnd)
        if (/[\n\r\u2028\u2029]/.test(body)) newline = true
        const isDoc = body.startsWith('*') && body !== '*' && !body.startsWith('**')
        const comment: Comment = { kind: isDoc ? 'doc' : 'block', start, end: this.pos, text: isDoc ? body.slice(1) : body }
        this.addComment(comment)
        if (isDoc) doc = comment
      } else if (c > 127 && SPACE.test(text[this.pos])) {
        this.pos++
      } else {
        break
      }
    }
    this.triviaNewline = newline
    this.triviaDoc = doc
  }

  private addComment(comment: Comment): void {
    if (comment.start < this.commentsEnd) return
    this.commentsEnd = comment.end
    this.comments.push(comment)
  }

  /** The next token; `/` and `/=` come as punctuators. */
  next(): Token {
    this.skipTrivia()
    const token = this.scanToken()
    token.newlineBefore = this.triviaNewline
    token.doc = this.triviaDoc
    return token
  }

  private make(type: TokenType, value: string, start: number): Token {
    // Every field is present from the start, so all tokens share one shape.
    return {
      type,
      value,
      start,
      end: this.pos,
      newlineBefore: false,
      doc: undefined,
      templateHead: undefined,
      templateTail: undefined,
      cooked: undefined,
      regex: undefined
    }
  }

  private scanToken(): Token {
    const { text, end } = this
    const start = this.pos
    if (start >= end) return this.make('eof', '', start)
    const c = text.charCodeAt(start)
    if (isIdStart(c, text, start) || c === 92 /* \ */) return this.scanIdentifier()
    if (isDigit(c) || (c === 46 && start + 1 < end && isDigit(text.charCodeAt(start + 1)))) return this.scanNumber()
    if (c === 34 || c === 39) return this.scanString(c)
    if (c === 96) return this.scanTemplate(start, true)
    const candidates = PUNCTUATORS_BY_CHAR.get(c)
    if (candidates) {
      for (const p of candidates) {
        if (p.length > 1 && (start + p.length > end || !text.startsWith(p, start))) continue
        // `?.` followed by a digit is `?` then a number (`a ?.5 : b`).
        if (p === '?.' && start + 2 < end && isDigit(text.charCodeAt(start + 2))) continue
        this.pos = start + p.length
        return this.make('punctuator', p, start)
      }
    }
    // Anything else: one character (a whole surrogate pair) the language has no use for.
    this.pos = start + (c >= 0xd800 && c <= 0xdbff && start + 1 < end ? 2 : 1)
    this.report('invalid_character', start, this.pos)
    return this.make('invalid', text.slice(start, this.pos), start)
  }

  private scanIdentifier(): Token {
    const { text, end } = this
    const start = this.pos
    let escaped = false
    while (this.pos < end) {
      const c = text.charCodeAt(this.pos)
      if (c === 92 /* \ */) {
        // `\uXXXX` or `\u{…}` inside a name.
        const m = /^\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/.exec(text.slice(this.pos, Math.min(end, this.pos + 12)))
        if (!m) {
          if (this.pos === start) {
            this.pos++
            this.report('invalid_character', start, this.pos)
            return this.make('invalid', '\\', start)
          }
          break
        }
        escaped = true
        this.pos += m[0].length
      } else if (this.pos === start ? isIdStart(c, text, this.pos) : isIdPart(c, text, this.pos)) {
        this.pos += c >= 0xd800 && c <= 0xdbff ? 2 : 1
      } else {
        break
      }
    }
    let value = text.slice(start, this.pos)
    if (escaped) {
      value = value.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (_, braced: string | undefined, four: string | undefined) => {
        const code = parseInt(braced ?? four ?? '0', 16)
        return code <= 0x10ffff ? String.fromCodePoint(code) : ''
      })
      return this.make('identifier', value, start)
    }
    return this.make(KEYWORDS.has(value) ? 'keyword' : 'identifier', value, start)
  }

  private scanNumber(): Token {
    const { text, end } = this
    const start = this.pos
    // The common case first: plain digits, ending on something that is not part of a number.
    let p = start
    while (p < end && isDigit(text.charCodeAt(p))) p++
    if (p > start && (p >= end || !isNumberPart(text.charCodeAt(p)))) {
      this.pos = p
      return this.make('number', text.slice(start, p), start)
    }
    const rest = text.slice(start, Math.min(end, start + 400))
    const m =
      /^0[xX][0-9a-fA-F_]*n?/.exec(rest) ??
      /^0[oO][0-7_]*n?/.exec(rest) ??
      /^0[bB][01_]*n?/.exec(rest) ??
      /^(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]*)?n?/.exec(rest)
    this.pos = start + (m ? m[0].length : 1)
    // A number may not run straight into a name (`3in`, `0x`).
    const raw = text.slice(start, this.pos)
    let bad = /^0[xXoObB]n?$/.test(raw) || /[eE][+-]?n?$/.test(raw)
    if (this.pos < end && isIdStart(text.charCodeAt(this.pos), text, this.pos)) {
      while (this.pos < end && isIdPart(text.charCodeAt(this.pos), text, this.pos)) this.pos++
      bad = true
    }
    if (bad) this.report('invalid_number', start, this.pos)
    return this.make('number', text.slice(start, this.pos), start)
  }

  /** Decodes one escape at `this.pos` (on the backslash); returns its text and moves past it. */
  private readEscape(): string {
    const { text, end } = this
    this.pos++ // the backslash
    if (this.pos >= end) return ''
    const c = text[this.pos]
    this.pos++
    switch (c) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case 'b': return '\b'
      case 'f': return '\f'
      case 'v': return '\v'
      case '0':
        if (this.pos < end && isDigit(text.charCodeAt(this.pos))) break
        return '\0'
      case '\r':
        if (this.pos < end && text[this.pos] === '\n') this.pos++
        return ''
      case '\n':
      case '\u2028':
      case '\u2029':
        return ''
      case 'x': {
        const m = /^[0-9a-fA-F]{2}/.exec(text.slice(this.pos, this.pos + 2))
        if (m) {
          this.pos += 2
          return String.fromCharCode(parseInt(m[0], 16))
        }
        return 'x'
      }
      case 'u': {
        const m = /^(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]{1,6}\})/.exec(text.slice(this.pos, this.pos + 8))
        if (m) {
          this.pos += m[0].length
          const code = parseInt(m[0].replace(/[{}]/g, ''), 16)
          return code <= 0x10ffff ? String.fromCodePoint(code) : ''
        }
        return 'u'
      }
    }
    if (c >= '0' && c <= '7') {
      // A legacy octal escape.
      let digits = c
      while (digits.length < 3 && this.pos < end && text[this.pos] >= '0' && text[this.pos] <= '7') digits += text[this.pos++]
      return String.fromCharCode(parseInt(digits, 8) & 0xff)
    }
    return c
  }

  private scanString(quote: number): Token {
    const { text, end } = this
    const start = this.pos
    this.pos++
    let value = ''
    let chunk = this.pos
    for (;;) {
      if (this.pos >= end) {
        value += text.slice(chunk, this.pos)
        this.report('unterminated_string', start, this.pos)
        break
      }
      const c = text.charCodeAt(this.pos)
      if (c === quote) {
        value += text.slice(chunk, this.pos)
        this.pos++
        break
      }
      if (c === 10 || c === 13) {
        value += text.slice(chunk, this.pos)
        this.report('unterminated_string', start, this.pos)
        break
      }
      if (c === 92) {
        value += text.slice(chunk, this.pos)
        value += this.readEscape()
        chunk = this.pos
        continue
      }
      this.pos++
    }
    return this.make('string', value, start)
  }

  /** A template chunk from `start` (on a backtick when `head`, else on the `}` that closes a substitution). */
  private scanTemplate(start: number, head: boolean): Token {
    const { text, end } = this
    this.pos = start + 1
    let cooked = ''
    let chunk = this.pos
    let tail = false
    for (;;) {
      if (this.pos >= end) {
        cooked += text.slice(chunk, this.pos)
        this.report('unterminated_template', start, this.pos)
        tail = true
        break
      }
      const c = text.charCodeAt(this.pos)
      if (c === 96) {
        cooked += text.slice(chunk, this.pos)
        this.pos++
        tail = true
        break
      }
      if (c === 36 && this.pos + 1 < end && text.charCodeAt(this.pos + 1) === 123) {
        cooked += text.slice(chunk, this.pos)
        this.pos += 2
        break
      }
      if (c === 92) {
        cooked += text.slice(chunk, this.pos)
        cooked += this.readEscape()
        chunk = this.pos
        continue
      }
      this.pos++
    }
    const token = this.make('template', text.slice(start, this.pos), start)
    token.templateHead = head
    token.templateTail = tail
    token.cooked = cooked
    return token
  }

  /** Reads the `/` or `/=` token `token` again as a regular expression literal. */
  rescanRegex(token: Token): Token {
    const { text, end } = this
    const start = token.start
    this.pos = start + 1
    let inClass = false
    let closed = false
    while (this.pos < end) {
      const c = text.charCodeAt(this.pos)
      if (isLineBreak(c)) break
      if (c === 92) {
        this.pos += 2
        continue
      }
      if (c === 91) inClass = true
      else if (c === 93) inClass = false
      else if (c === 47 && !inClass) {
        closed = true
        break
      }
      this.pos++
    }
    if (this.pos > end) this.pos = end
    const pattern = text.slice(start + 1, this.pos)
    if (closed) this.pos++
    else this.report('unterminated_regex', start, this.pos)
    const flagsStart = this.pos
    while (this.pos < end && isIdPart(text.charCodeAt(this.pos), text, this.pos)) this.pos++
    const flags = text.slice(flagsStart, this.pos)
    const result = this.make('regex', text.slice(start, this.pos), start)
    result.newlineBefore = token.newlineBefore
    if (token.doc) result.doc = token.doc
    result.regex = { pattern, flags }
    return result
  }

  /** Reads the `}` token `token` again as the continuation of a template after a substitution. */
  rescanTemplate(token: Token): Token {
    const result = this.scanTemplate(token.start, false)
    result.newlineBefore = token.newlineBefore
    return result
  }
}

// Keywords that are values: a `/` after them divides.
const VALUE_KEYWORDS = new Set(['this', 'super', 'null', 'true', 'false'])

/**
 * Every token of `text`, comments included, in order, without a parser: for highlighting. A `/`
 * is a regex where an operand may start (after an operator, an opening bracket, a keyword such as
 * `return`, or at the start), a division otherwise.
 */
export function tokenize(text: string, start = 0, end = text.length): { tokens: Token[]; problems: Problem[] } {
  const comments: Comment[] = []
  const problems: Problem[] = []
  const lexer = new Lexer(text, start, end, comments, problems)
  const tokens: Token[] = []
  // Open braces: true for a template substitution, false for an ordinary brace.
  const braces: boolean[] = []
  let previous: Token | null = null
  for (let guard = 0; guard <= text.length + 1; guard++) {
    let token = lexer.next()
    if (token.type === 'eof') break
    if (token.type === 'punctuator' && (token.value === '/' || token.value === '/=') && regexAllowedAfter(previous)) {
      token = lexer.rescanRegex(token)
    } else if (token.type === 'punctuator' && token.value === '}' && braces.length > 0 && braces[braces.length - 1]) {
      braces.pop()
      token = lexer.rescanTemplate(token)
      if (!token.templateTail) braces.push(true)
    } else if (token.type === 'punctuator' && token.value === '{') {
      braces.push(false)
    } else if (token.type === 'punctuator' && token.value === '}') {
      braces.pop()
    } else if (token.type === 'template' && !token.templateTail) {
      braces.push(true)
    }
    tokens.push(token)
    previous = token
  }
  if (comments.length === 0) return { tokens, problems }
  // Merge the comments in, by position.
  const merged: Token[] = []
  let i = 0
  for (const comment of comments) {
    while (i < tokens.length && tokens[i].start < comment.start) merged.push(tokens[i++])
    merged.push({ type: 'comment', value: text.slice(comment.start, comment.end), start: comment.start, end: comment.end, newlineBefore: false })
  }
  while (i < tokens.length) merged.push(tokens[i++])
  return { tokens: merged, problems }
}

function regexAllowedAfter(previous: Token | null): boolean {
  if (previous === null) return true
  switch (previous.type) {
    case 'identifier':
    case 'number':
    case 'string':
    case 'regex':
      return false
    case 'template':
      return !previous.templateTail
    case 'keyword':
      return !VALUE_KEYWORDS.has(previous.value)
    case 'punctuator':
      return previous.value !== ')' && previous.value !== ']' && previous.value !== '}' && previous.value !== '++' && previous.value !== '--'
    default:
      return true
  }
}
