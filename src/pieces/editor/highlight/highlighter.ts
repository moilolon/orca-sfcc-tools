// Colours a buffer line by line, lazily and incrementally. Each line keeps its tokens, the state
// it was lexed from and the state it ended in. A change drops the lines it touched; `ensure(n)`
// then walks from the first line not known to be right up to line `n`: a line whose cached start
// state equals the state it now starts in keeps its tokens without being lexed again, so a key
// typed re-lexes its own line and, when it changes what follows (a quote, a comment opened), only
// the lines until the state agrees again, never past what is drawn.
import type { TextBuffer } from '../surface/buffer'
import type { LineLexer, LineTokens } from './tokens'

type Line = { start: string; end: string; tokens: LineTokens } | null

export class Highlighter {
  private readonly buffer: TextBuffer
  private lexer: LineLexer
  private cache: Line[]
  /** Every line before it is known to be right. */
  private frontier = 0
  /** Lines lexed since the counter was last read: how much a change cost. */
  lexed = 0

  constructor(buffer: TextBuffer, lexer: LineLexer) {
    this.buffer = buffer
    this.lexer = lexer
    this.cache = new Array<Line>(buffer.lineCount).fill(null)
    buffer.onChange((fromLine, oldEnd, newEnd) => this.edited(fromLine, oldEnd, newEnd))
  }

  /** Another language: everything is lexed again. */
  setLexer(lexer: LineLexer): void {
    if (lexer === this.lexer) return
    this.lexer = lexer
    this.reset()
  }

  /** Forgets every line: after a whole new text. */
  reset(): void {
    this.cache = new Array<Line>(this.buffer.lineCount).fill(null)
    this.frontier = 0
  }

  /** Lines `fromLine..oldEnd` became `fromLine..newEnd`. */
  edited(fromLine: number, oldEnd: number, newEnd: number): void {
    const fresh = new Array<Line>(newEnd - fromLine + 1).fill(null)
    const removed = oldEnd - fromLine + 1
    if (fresh.length < 20_000 && removed < 20_000) this.cache.splice(fromLine, removed, ...fresh)
    else this.cache = this.cache.slice(0, fromLine).concat(fresh, this.cache.slice(oldEnd + 1))
    if (fromLine < this.frontier) this.frontier = fromLine
  }

  /** Makes lines `0..last` right, lexing only the lines that need it. */
  ensure(last: number): void {
    const end = Math.min(last, this.buffer.lineCount - 1)
    if (this.frontier > end) return
    let state = this.frontier === 0 ? this.lexer.initial : (this.cache[this.frontier - 1]?.end ?? this.lexer.initial)
    for (let l = this.frontier; l <= end; l++) {
      const cached = this.cache[l]
      if (cached && cached.start === state) {
        state = cached.end
        continue
      }
      const result = this.lexer.line(this.buffer.line(l), state)
      this.cache[l] = { start: state, end: result.state, tokens: result.tokens }
      this.lexed++
      state = result.state
    }
    this.frontier = end + 1
  }

  /** A line's tokens; lexes up to it first when needed. */
  tokens(line: number): LineTokens {
    this.ensure(line)
    return this.cache[line]?.tokens ?? []
  }

  /** The cached entry of a line, the same object while the line stays right: a view keys its drawn line on it. */
  entry(line: number): object | null {
    this.ensure(line)
    return this.cache[line]
  }

  /** The state a line starts in (after lexing up to it). */
  stateAt(line: number): string {
    this.ensure(line)
    return this.cache[line]?.start ?? this.lexer.initial
  }
}
