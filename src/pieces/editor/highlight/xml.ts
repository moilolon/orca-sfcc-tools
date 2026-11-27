// XML one line at a time (site archives, metadata, `.project`): tags, attributes, quoted values,
// comments, CDATA, processing instructions and declarations, and entities in text. The state is
// one word: `x` text, `t` inside a tag, `q"`/`q'` a quoted value in a tag, `c` a comment, `d` a
// CDATA section, `p` a processing instruction, `!` a declaration.
import { C, push, type LineLexer, type LineTokens } from './tokens'

const NAME = /[A-Za-z_:][\w:.-]*/y
const ENTITY = /&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z]\w*);/y

export function lexXmlLine(text: string, state: string): { tokens: LineTokens; state: string } {
  const out: LineTokens = []
  const n = text.length
  let mode = state || 'x'
  let i = 0
  const until = (word: string, cls: number, next: string) => {
    const at = text.indexOf(word, i)
    if (at === -1) {
      push(out, i, n, cls)
      i = n
      return
    }
    push(out, i, at + word.length, cls)
    i = at + word.length
    mode = next
  }
  for (let guard = 0; i < n && guard <= n * 2 + 4; guard++) {
    if (mode === 'c') until('-->', C.comment, 'x')
    else if (mode === 'd') until(']]>', C.string, 'x')
    else if (mode === 'p') until('?>', C.meta, 'x')
    else if (mode === '!') until('>', C.meta, 'x')
    else if (mode[0] === 'q') {
      const quote = mode[1]
      const at = text.indexOf(quote, i)
      if (at === -1) {
        push(out, i, n, C.string)
        i = n
      } else {
        push(out, i, at + 1, C.string)
        i = at + 1
        mode = 't'
      }
    } else if (mode === 't') {
      const c = text[i]
      if (c === ' ' || c === '\t') i++
      else if (c === '>' || (c === '/' && text[i + 1] === '>') || (c === '?' && text[i + 1] === '>')) {
        const width = c === '>' ? 1 : 2
        push(out, i, i + width, C.punct)
        i += width
        mode = 'x'
      } else if (c === '=') {
        push(out, i, i + 1, C.punct)
        i++
      } else if (c === '"' || c === "'") {
        push(out, i, i + 1, C.string)
        i++
        mode = 'q' + c
      } else {
        NAME.lastIndex = i
        const match = NAME.exec(text)
        const end = match ? i + match[0].length : i + 1
        push(out, i, end, match ? C.attr : C.plain)
        i = end
      }
    } else {
      // Text: up to a tag or an entity.
      let p = i
      while (p < n && text[p] !== '<' && text[p] !== '&') p++
      push(out, i, p, C.plain)
      i = p
      if (i >= n) break
      if (text[i] === '&') {
        ENTITY.lastIndex = i
        const match = ENTITY.exec(text)
        const end = match ? i + match[0].length : i + 1
        push(out, i, end, match ? C.escape : C.plain)
        i = end
        continue
      }
      if (text.startsWith('<!--', i)) {
        mode = 'c'
        push(out, i, i + 4, C.comment)
        i += 4
        continue
      }
      if (text.startsWith('<![CDATA[', i)) {
        push(out, i, i + 9, C.meta)
        i += 9
        mode = 'd'
        continue
      }
      if (text.startsWith('<?', i)) {
        mode = 'p'
        continue
      }
      if (text[i + 1] === '!') {
        mode = '!'
        continue
      }
      const end = text[i + 1] === '/' ? i + 2 : i + 1
      NAME.lastIndex = end
      const match = NAME.exec(text)
      if (!match) {
        push(out, i, i + 1, C.plain)
        i++
        continue
      }
      push(out, i, end, C.punct)
      push(out, end, end + match[0].length, C.tag)
      i = end + match[0].length
      mode = 't'
    }
  }
  return { tokens: out, state: mode }
}

export const xml: LineLexer = {
  initial: 'x',
  line: lexXmlLine
}
