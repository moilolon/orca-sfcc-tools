// A resource bundle (`templates/resources/*.properties`) into its keys, each with its position,
// read as Java reads a properties file: `#` and `!` comments, `=`, `:` or white space between key
// and value, a backslash at the end of a line continuing the value, escapes in keys and values.
// Pure: no Node, no Orca.
import { lineAt, lineStarts } from './files'

export type PropertyKey = {
  key: string
  value: string
  /** The range of the key as written. */
  start: number
  end: number
  /** 1-based. */
  line: number
}

function unescape(text: string): string {
  if (!text.includes('\\')) return text
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, body: string) => {
    if (body.length === 5 && body[0] === 'u') return String.fromCharCode(parseInt(body.slice(1), 16))
    return body === 't' ? '\t' : body === 'n' ? '\n' : body === 'r' ? '\r' : body === 'f' ? '\f' : body
  })
}

/** Whether the line ends with an odd number of backslashes: it continues on the next. */
function continues(line: string): boolean {
  let count = 0
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) count++
  return count % 2 === 1
}

export function parseProperties(text: string): PropertyKey[] {
  const keys: PropertyKey[] = []
  const starts = lineStarts(text)
  const lineText = (index: number) => {
    const from = starts[index]
    let to = index + 1 < starts.length ? starts[index + 1] : text.length
    while (to > from && (text[to - 1] === '\n' || text[to - 1] === '\r')) to--
    return { from, line: text.slice(from, to) }
  }
  for (let index = 0; index < starts.length; index++) {
    const { from, line } = lineText(index)
    let i = 0
    while (i < line.length && /[ \t\f]/.test(line[i])) i++
    if (i >= line.length || line[i] === '#' || line[i] === '!') continue
    const keyStart = i
    while (i < line.length) {
      const c = line[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '=' || c === ':' || c === ' ' || c === '\t' || c === '\f') break
      i++
    }
    const keyEnd = Math.min(i, line.length)
    // The separator: white space, then at most one `=` or `:`, then white space.
    while (i < line.length && /[ \t\f]/.test(line[i])) i++
    if (line[i] === '=' || line[i] === ':') i++
    while (i < line.length && /[ \t\f]/.test(line[i])) i++
    let value = line.slice(i)
    // Continuation lines: the backslash is dropped, and the next line's leading white space.
    while (continues(value) && index + 1 < starts.length) {
      value = value.slice(0, -1)
      index++
      value += lineText(index).line.replace(/^[ \t\f]+/, '')
    }
    const rawKey = line.slice(keyStart, keyEnd)
    keys.push({ key: unescape(rawKey), value: unescape(value), start: from + keyStart, end: from + keyEnd, line: lineAt(starts, from + keyStart) })
  }
  return keys
}
