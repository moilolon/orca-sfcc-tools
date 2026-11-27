// A strict reader of XML for the files the platform itself parses (form definitions): it reads a
// document into its elements, or says where and why it is not well-formed, the first fault only.
// Unlike the tolerant reader of the checkout index (`checkout/xml.ts`), it refuses what a strict
// parser refuses: an unclosed or mismatched tag, an attribute without quotes or given twice, a
// `<` in a value, an unknown entity (no DTD is read: only the five of XML and character
// references), text or a second element outside the root, an unclosed comment, CDATA section or
// declaration. One pass, an explicit stack: linear in the text, never throws. Pure: no Node, no Orca.

export type XmlFault =
  | 'unclosed_tag'
  | 'mismatched_tag'
  | 'stray_close'
  | 'bad_name'
  | 'bad_attribute'
  | 'unquoted_value'
  | 'duplicate_attribute'
  | 'lt_in_value'
  | 'bad_entity'
  | 'no_root'
  | 'outside_root'
  | 'unclosed_comment'
  | 'unclosed_cdata'
  | 'unclosed_declaration'

export const XML_FAULTS: readonly XmlFault[] = ['unclosed_tag', 'mismatched_tag', 'stray_close', 'bad_name', 'bad_attribute', 'unquoted_value', 'duplicate_attribute', 'lt_in_value', 'bad_entity', 'no_root', 'outside_root', 'unclosed_comment', 'unclosed_cdata', 'unclosed_declaration']

export type XmlAttr = { name: string; nameStart: number; nameEnd: number; value: string; valueStart: number; valueEnd: number }

export type XmlElement = {
  /** As written, prefix included. */
  name: string
  /** The range of the name in its start tag. */
  nameStart: number
  nameEnd: number
  attributes: XmlAttr[]
  children: XmlElement[]
}

export type XmlRead = { root: XmlElement; fault: null } | { root: null; fault: { reason: XmlFault; start: number; end: number } }

const NAME = /[\p{L}_:][\p{L}\p{N}_:.\-·]*/uy
const ENTITY = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/y
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] !== '#') return ENTITIES[body] ?? whole
    const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

/** The offset of the first `&` in `from…to` that starts no known entity; -1 when none. */
function badEntity(text: string, from: number, to: number): number {
  let at = text.indexOf('&', from)
  while (at !== -1 && at < to) {
    ENTITY.lastIndex = at
    const match = ENTITY.exec(text)
    if (!match || at + match[0].length > to) return at
    at = text.indexOf('&', at + match[0].length)
  }
  return -1
}

function nameAt(text: string, at: number): string | null {
  NAME.lastIndex = at
  const match = NAME.exec(text)
  return match ? match[0] : null
}

export function readXml(text: string): XmlRead {
  const n = text.length
  const fail = (reason: XmlFault, start: number, end = start + 1): XmlRead => ({ root: null, fault: { reason, start, end: Math.min(Math.max(end, start), n) } })
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < n) {
    const lt = text.indexOf('<', i)
    const textEnd = lt === -1 ? n : lt
    if (textEnd > i) {
      if (stack.length === 0) {
        const solid = text.slice(i, textEnd).search(/\S/)
        if (solid !== -1) return fail('outside_root', i + solid)
      } else {
        const bad = badEntity(text, i, textEnd)
        if (bad !== -1) return fail('bad_entity', bad)
      }
    }
    if (lt === -1) break
    i = lt
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4)
      if (close === -1) return fail('unclosed_comment', i, i + 4)
      i = close + 3
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) return fail('outside_root', i)
      const close = text.indexOf(']]>', i + 9)
      if (close === -1) return fail('unclosed_cdata', i, i + 9)
      i = close + 3
      continue
    }
    if (text[i + 1] === '?') {
      const close = text.indexOf('?>', i + 2)
      if (close === -1) return fail('unclosed_declaration', i, i + 2)
      i = close + 2
      continue
    }
    if (text[i + 1] === '!') {
      // A doctype: its internal subset, when it has one, ends with `]`.
      const bracket = text.indexOf('[', i)
      const firstClose = text.indexOf('>', i)
      let close = firstClose
      if (bracket !== -1 && (firstClose === -1 || bracket < firstClose)) {
        const end = text.indexOf(']', bracket)
        close = end === -1 ? -1 : text.indexOf('>', end)
      }
      if (close === -1 || stack.length > 0 || root !== null) return fail('unclosed_declaration', i, i + 2)
      i = close + 1
      continue
    }
    if (text[i + 1] === '/') {
      const name = nameAt(text, i + 2)
      if (name === null) return fail('bad_name', i, i + 2)
      let j = i + 2 + name.length
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] !== '>') return fail('unclosed_tag', i, j)
      const open = stack.pop()
      if (!open) return fail('stray_close', i, j + 1)
      if (open.name !== name) return fail('mismatched_tag', i, j + 1)
      i = j + 1
      continue
    }
    // A start tag.
    const name = nameAt(text, i + 1)
    if (name === null) return fail('bad_name', i, i + 1)
    if (stack.length === 0 && root !== null) return fail('outside_root', i, i + 1 + name.length)
    const element: XmlElement = { name, nameStart: i + 1, nameEnd: i + 1 + name.length, attributes: [], children: [] }
    let j = element.nameEnd
    let closed = false
    let selfClosing = false
    while (j < n) {
      const spaced = /\s/.test(text[j])
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] === '>') {
        closed = true
        j++
        break
      }
      if (text[j] === '/' && text[j + 1] === '>') {
        closed = true
        selfClosing = true
        j += 2
        break
      }
      const attribute = nameAt(text, j)
      // An attribute needs a space before it, and a name.
      if (attribute === null || !spaced) return fail('bad_attribute', j)
      const nameStart = j
      j += attribute.length
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] !== '=') return fail('bad_attribute', nameStart, j)
      j++
      while (j < n && /\s/.test(text[j])) j++
      const quote = text[j]
      if (quote !== '"' && quote !== "'") return fail('unquoted_value', j)
      const close = text.indexOf(quote, j + 1)
      if (close === -1) return fail('unclosed_tag', i, n)
      const lessThan = text.indexOf('<', j + 1)
      if (lessThan !== -1 && lessThan < close) return fail('lt_in_value', lessThan)
      const bad = badEntity(text, j + 1, close)
      if (bad !== -1) return fail('bad_entity', bad)
      if (element.attributes.some((each) => each.name === attribute)) return fail('duplicate_attribute', nameStart, nameStart + attribute.length)
      element.attributes.push({ name: attribute, nameStart, nameEnd: nameStart + attribute.length, value: decode(text.slice(j + 1, close)), valueStart: j + 1, valueEnd: close })
      j = close + 1
    }
    if (!closed) return fail('unclosed_tag', i, element.nameEnd)
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(element)
    else root = element
    if (!selfClosing) stack.push(element)
    i = j
  }
  const open = stack[stack.length - 1]
  if (open) return fail('unclosed_tag', open.nameStart - 1, open.nameEnd)
  if (!root) return fail('no_root', 0, 0)
  return { root, fault: null }
}

/** An element's or attribute's name without its namespace prefix. */
export function localName(name: string): string {
  const at = name.indexOf(':')
  return at === -1 ? name : name.slice(at + 1)
}
