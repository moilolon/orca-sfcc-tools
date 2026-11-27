// `.properties` one line at a time (resource bundles): comments (`#`, `!`), the key up to its
// separator (`=`, `:` or a space, none escaped), the value, escapes (`\uXXXX`, `\n`, …) and the
// `{0}` placeholders `Resource.msgf` fills. A value whose line ends in an odd number of
// backslashes goes on to the next line: the state is `v` there, `k` otherwise.
import { C, push, type LineLexer, type LineTokens } from './tokens'

const PLACEHOLDER = /\{\d+(?:,[^{}]*)?\}/y

function valueRun(text: string, from: number, out: LineTokens): void {
  let i = from
  let plain = from
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '\\') {
      push(out, plain, i, C.string)
      const width = text[i + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)) ? 6 : Math.min(2, n - i)
      push(out, i, i + width, C.escape)
      i += width
      plain = i
      continue
    }
    if (c === '{') {
      PLACEHOLDER.lastIndex = i
      const match = PLACEHOLDER.exec(text)
      if (match) {
        push(out, plain, i, C.string)
        push(out, i, i + match[0].length, C.expr)
        i += match[0].length
        plain = i
        continue
      }
    }
    i++
  }
  push(out, plain, n, C.string)
}

/** Whether a line ends in an odd number of backslashes: its value goes on. */
function continues(text: string): boolean {
  let count = 0
  for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i--) count++
  return count % 2 === 1
}

export function lexPropertiesLine(text: string, state: string): { tokens: LineTokens; state: string } {
  const out: LineTokens = []
  const n = text.length
  let i = 0
  while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\f')) i++
  if (state === 'v') {
    valueRun(text, i, out)
    return { tokens: out, state: continues(text) ? 'v' : 'k' }
  }
  if (i >= n) return { tokens: out, state: 'k' }
  if (text[i] === '#' || text[i] === '!') {
    push(out, i, n, C.comment)
    return { tokens: out, state: 'k' }
  }
  const keyStart = i
  while (i < n) {
    const c = text[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '=' || c === ':' || c === ' ' || c === '\t' || c === '\f') break
    i++
  }
  push(out, keyStart, Math.min(i, n), C.key)
  // The separator: spaces, at most one `=` or `:`, spaces.
  let p = Math.min(i, n)
  while (p < n && (text[p] === ' ' || text[p] === '\t' || text[p] === '\f')) p++
  if (p < n && (text[p] === '=' || text[p] === ':')) {
    push(out, p, p + 1, C.punct)
    p++
    while (p < n && (text[p] === ' ' || text[p] === '\t' || text[p] === '\f')) p++
  }
  valueRun(text, p, out)
  return { tokens: out, state: continues(text) ? 'v' : 'k' }
}

export const properties: LineLexer = {
  initial: 'k',
  line: lexPropertiesLine
}
