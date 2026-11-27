// What a line lexer gives the highlighter: a line's tokens as a flat list of numbers (start, end,
// class index), and the state the next line starts in. A state is a short string, compared with
// `===`: when a line's new end state equals the one it had, the lines after it need no new lexing.

export const CLASSES = [
  'plain',
  'comment',
  'string',
  'keyword',
  'literal',
  'number',
  'punct',
  'regex',
  'tag',
  'istag',
  'attr',
  'expr',
  'key',
  'escape',
  'meta'
] as const

export type TokenClass = (typeof CLASSES)[number]

export const C: { readonly [K in TokenClass]: number } = Object.fromEntries(CLASSES.map((name, index) => [name, index])) as { [K in TokenClass]: number }

/** start, end, class; start, end, class; … in order, never overlapping. */
export type LineTokens = number[]

export type LineResult = { tokens: LineTokens; state: string }

/** Lexes one line (without its break) from the state the line starts in. */
export type LineLexer = {
  readonly initial: string
  line(text: string, state: string): LineResult
}

/** Adds a token, joining it to the previous one when they touch and share a class. */
export function push(out: LineTokens, start: number, end: number, cls: number): void {
  if (end <= start) return
  const n = out.length
  if (n >= 3 && out[n - 2] === start && out[n - 1] === cls) {
    out[n - 2] = end
    return
  }
  out.push(start, end, cls)
}

/** Tokens as readable triples, for tests: `[text, class]`. */
export function describeTokens(text: string, tokens: LineTokens): [string, TokenClass][] {
  const out: [string, TokenClass][] = []
  for (let k = 0; k < tokens.length; k += 3) out.push([text.slice(tokens[k], tokens[k + 1]), CLASSES[tokens[k + 2]]])
  return out
}
