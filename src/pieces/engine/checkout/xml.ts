// A small, tolerant XML reader for what the checkout index needs of a file: start and end tags
// with their attributes and positions, and the text between them. Comments, processing
// instructions, doctypes and CDATA are stepped over (CDATA counts as text). It never throws; on
// broken input it reads what it can, in one pass, so its time is linear in the text.
// Pure: no Node, no Orca.

export type XmlAttribute = {
  name: string
  /** The value with entities decoded. */
  value: string
  /** The range of the value, without its quotes. */
  valueStart: number
  valueEnd: number
}

export type XmlTag = {
  /** The tag name as written, namespace prefix included (`xml:lang` stays whole). */
  name: string
  /** The name without its namespace prefix. */
  local: string
  start: number
  end: number
  attributes: XmlAttribute[]
  selfClosing: boolean
}

export type XmlVisitor = {
  open?(tag: XmlTag): void
  close?(name: string, start: number, end: number): void
  /** Text between tags; `start` and `end` are its range in the source. */
  text?(start: number, end: number): void
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** The text with XML's entities and character references decoded; unknown ones are kept. */
export function decodeXml(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

function localName(name: string): string {
  const at = name.indexOf(':')
  return at === -1 ? name : name.slice(at + 1)
}

const NAME_END = /[\s/>=]/

export function scanXml(text: string, visitor: XmlVisitor): void {
  let i = 0
  const n = text.length
  while (i < n) {
    const lt = text.indexOf('<', i)
    const textEnd = lt === -1 ? n : lt
    if (textEnd > i) visitor.text?.(i, textEnd)
    if (lt === -1) return
    i = lt
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4)
      i = close === -1 ? n : close + 3
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      const close = text.indexOf(']]>', i + 9)
      const end = close === -1 ? n : close
      visitor.text?.(i + 9, end)
      i = close === -1 ? n : close + 3
      continue
    }
    if (text[i + 1] === '?' || text[i + 1] === '!') {
      const close = text.indexOf('>', i + 2)
      i = close === -1 ? n : close + 1
      continue
    }
    if (text[i + 1] === '/') {
      let j = i + 2
      while (j < n && !NAME_END.test(text[j])) j++
      const name = text.slice(i + 2, j)
      const close = text.indexOf('>', j)
      const end = close === -1 ? n : close + 1
      visitor.close?.(name, i, end)
      i = end
      continue
    }
    // A start tag.
    let j = i + 1
    while (j < n && !NAME_END.test(text[j]) && text[j] !== '<') j++
    const name = text.slice(i + 1, j)
    if (name === '') {
      visitor.text?.(i, i + 1)
      i++
      continue
    }
    const attributes: XmlAttribute[] = []
    let selfClosing = false
    let end = n
    while (j < n) {
      const c = text[j]
      if (c === '>') {
        end = j + 1
        break
      }
      if (c === '/' && text[j + 1] === '>') {
        selfClosing = true
        end = j + 2
        break
      }
      if (c === '<') {
        // An unclosed tag: it ends where the next one starts.
        end = j
        break
      }
      if (/\s/.test(c) || c === '/') {
        j++
        continue
      }
      const nameStart = j
      while (j < n && !NAME_END.test(text[j]) && text[j] !== '<') j++
      const attributeName = text.slice(nameStart, j)
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] !== '=') {
        if (attributeName) attributes.push({ name: attributeName, value: '', valueStart: j, valueEnd: j })
        if (j === nameStart) j++
        continue
      }
      j++
      while (j < n && /\s/.test(text[j])) j++
      const quote = text[j]
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, j + 1)
        const valueEnd = close === -1 ? n : close
        attributes.push({ name: attributeName, value: decodeXml(text.slice(j + 1, valueEnd)), valueStart: j + 1, valueEnd })
        j = close === -1 ? n : close + 1
      } else {
        const valueStart = j
        while (j < n && !/[\s>]/.test(text[j])) j++
        attributes.push({ name: attributeName, value: decodeXml(text.slice(valueStart, j)), valueStart, valueEnd: j })
      }
    }
    visitor.open?.({ name, local: localName(name), start: i, end, attributes, selfClosing })
    if (selfClosing) visitor.close?.(name, end, end)
    i = end
  }
}

/** The value of an attribute of a tag, by its name as written. */
export function attributeOf(tag: XmlTag, name: string): XmlAttribute | null {
  return tag.attributes.find((attribute) => attribute.name === name) ?? null
}
