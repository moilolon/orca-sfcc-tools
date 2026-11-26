// The ISML parser: a template into a tree of HTML elements, ISML tags (`<is…>`, custom tags
// declared with `<ismodule>` included), text, `${…}` expressions (in text, inside attribute
// values and among a tag's attributes), comments and `<isscript>` blocks, with positions for
// every node and attribute. It never throws and is tolerant: an unclosed tag, comment, attribute
// value or `${` is reported and never takes the rest of the file.
//
// How `${…}` ends follows the ISML grammar of phase 1 (src/pieces/isml/isml.tmLanguage.json): it
// closes at the `}` that balances it, skipping nested braces, strings, templates and `/* */`;
// unclosed, it stops at the end of its line, and also before `</` or `-->` in text, or before
// the quote of the attribute value it sits in.
//
// Only ISML structure is checked: HTML elements are nested as written, closed implicitly where an
// ISML tag or a parent closes, and an HTML end tag with nothing to close is kept as a `CloseTag`
// node without a problem (ISML branches often open and close HTML on different paths).
// Pure: no Node, no Orca.
import type { Problem, ProblemCode, Range } from '../js/ast'

/** ISML's own tags (the grammar's list). Any other `<is…>` is a custom tag. */
export const ISML_TAGS: ReadonlySet<string> = new Set([
  'isactivedatacontext', 'isactivedatahead', 'isanalyticsoff', 'isbreak', 'iscache', 'iscomment',
  'iscomponent', 'iscontent', 'iscontinue', 'iscookie', 'isdecorate', 'iselseif', 'iselse', 'isif',
  'isinclude', 'isloop', 'ismodule', 'isnext', 'isobject', 'isprint', 'isredirect', 'isremove',
  'isreplace', 'isscript', 'isselect', 'isset', 'isslot', 'isstatus'
])

/** ISML tags that hold content and need their end tag. Every other ISML tag (custom ones included) is empty. */
export const ISML_CONTAINERS: ReadonlySet<string> = new Set(['isif', 'isloop', 'isdecorate', 'isobject'])

/** How deep elements may nest: deeper, an element is kept empty and its content becomes its siblings. */
export const MAX_ELEMENT_DEPTH = 300

/** HTML elements that never have content. */
export const HTML_VOID: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
])

export interface IsmlDocument extends Range {
  type: 'Document'
  children: IsmlNode[]
  /** Every `<ismodule>` of the template: the custom tags it declares. */
  modules: ModuleDeclaration[]
}

export type IsmlNode = Element | Text | IsmlExpression | HtmlComment | IsComment | IsScript | Doctype | CloseTag

export interface Text extends Range {
  type: 'Text'
}

/** A `${…}`. */
export interface IsmlExpression extends Range {
  type: 'Expression'
  /** The JavaScript between `${` and `}` (or where an unclosed one stops). */
  codeStart: number
  codeEnd: number
  closed: boolean
}

export interface Element extends Range {
  type: 'Element'
  /** The tag name in lower case. */
  name: string
  nameStart: number
  nameEnd: number
  /** An `<is…>` tag. */
  isml: boolean
  /** An `<is…>` tag that is not one of ISML's own: one an `<ismodule>` declares. */
  custom: boolean
  attributes: Attribute[]
  /** ISML tags, end tags and `${…}` written among the attributes, outside any value. */
  inTag: (Element | CloseTag | IsmlExpression)[]
  children: IsmlNode[]
  /** Where the start tag ends (after its `>`, or where an unclosed one stops). */
  openEnd: number
  selfClosing: boolean
  /** The end tag, when there is one. */
  close: Range | null
}

export interface Attribute extends Range {
  name: string
  nameStart: number
  nameEnd: number
  /** `null` for an attribute written without `=`. */
  value: AttributeValue | null
}

export interface AttributeValue extends Range {
  quote: '"' | "'" | null
  /** The value without its quotes. */
  contentStart: number
  contentEnd: number
  /** Its text, `${…}` and ISML tags, in order. */
  parts: (Text | IsmlExpression | Element | CloseTag)[]
  /** False for a quoted value whose closing quote is missing (it then stops at the end of its line). */
  closed: boolean
}

/** `<!-- … -->`, where ISML is still parsed. */
export interface HtmlComment extends Range {
  type: 'Comment'
  children: IsmlNode[]
  closed: boolean
}

/** `<iscomment> … </iscomment>`, where nothing is parsed. */
export interface IsComment extends Range {
  type: 'IsComment'
  contentStart: number
  contentEnd: number
  closed: boolean
}

/** `<isscript> … </isscript>`. */
export interface IsScript extends Range {
  type: 'IsScript'
  attributes: Attribute[]
  openEnd: number
  codeStart: number
  codeEnd: number
  close: Range | null
}

export interface Doctype extends Range {
  type: 'Doctype'
}

/** An end tag that closes nothing (or one written among attributes). */
export interface CloseTag extends Range {
  type: 'CloseTag'
  name: string
}

export interface ModuleDeclaration extends Range {
  /** The custom tag's name without `is` (`<ismodule name="price">` declares `<isprice>`). */
  name: string
  /** The `template` attribute's value, when it is plain text. */
  template: string | null
  /** The `attribute` values: the attributes the tag accepts. */
  attributes: string[]
}

export interface TemplateParse {
  document: IsmlDocument
  problems: Problem[]
}

/** Parses a template. Never throws. */
export function parseTemplate(text: string): TemplateParse {
  const parser = new IsmlParser(text)
  let children: IsmlNode[]
  try {
    children = parser.parseNodes(0, text.length, true)
  } catch {
    parser.report('internal_error', 0, 0)
    children = []
  }
  return { document: { type: 'Document', start: 0, end: text.length, children, modules: parser.modules }, problems: parser.problems }
}

const NAME_CHAR = /[\w:.-]/
const isLetter = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'

interface OpenFrame {
  element: Element
}

class IsmlParser {
  readonly text: string
  readonly problems: Problem[] = []
  readonly modules: ModuleDeclaration[] = []

  constructor(text: string) {
    this.text = text
  }

  private tooDeep = false

  /** Reports `too_deep` once per template, at the first element past the limit. */
  private reportTooDeep(element: Element): void {
    if (this.tooDeep) return
    this.tooDeep = true
    this.report('too_deep', element.start, element.openEnd)
  }

  report(code: ProblemCode, start: number, end: number, detail?: string): void {
    this.problems.push(detail === undefined ? { code, start, end } : { code, start, end, detail })
  }

  /** The first match of the global pattern `pattern` from `from` that ends by `limit`. */
  private find(pattern: RegExp, from: number, limit: number): RegExpExecArray | null {
    pattern.lastIndex = from
    const match = pattern.exec(this.text)
    return match && match.index + match[0].length <= limit ? match : null
  }

  private startsWithCI(value: string, at: number): boolean {
    return this.text.slice(at, at + value.length).toLowerCase() === value
  }

  /** At `at` starts `<name` (or `</name` when `close`) for an ISML tag: `is` and a letter. */
  private isIsmlTagAt(at: number, close: boolean): boolean {
    const offset = close ? 2 : 1
    if (this.text[at] !== '<' || (close && this.text[at + 1] !== '/')) return false
    return this.startsWithCI('is', at + offset) && isLetter(this.text[at + offset + 2])
  }

  /** The tag `<word` (no `is`) at `at` begins with `word` followed by a non-name character. */
  private tagWordAt(at: number, word: string): boolean {
    if (!this.startsWithCI(word, at)) return false
    const after = this.text[at + word.length]
    return after === undefined || !NAME_CHAR.test(after)
  }

  /**
   * Parses content from `from` to `limit`. With `html` false (inside a comment or a `<script>`),
   * only ISML is parsed and HTML is text.
   */
  parseNodes(from: number, limit: number, html: boolean): IsmlNode[] {
    const text = this.text
    const root: IsmlNode[] = []
    const stack: OpenFrame[] = []
    const children = () => (stack.length > 0 ? stack[stack.length - 1].element.children : root)
    const addText = (start: number, end: number) => {
      if (end <= start) return
      const list = children()
      const last = list[list.length - 1]
      if (last && last.type === 'Text' && last.end === start) last.end = end
      else list.push({ type: 'Text', start, end })
    }
    /** Closes the frames above `index` (implicitly) at `at`, then frame `index` itself when `close` is given. */
    const popTo = (index: number, at: number) => {
      while (stack.length > index) {
        const frame = stack.pop() as OpenFrame
        frame.element.end = at
        if (frame.element.isml) this.report('unclosed_tag', frame.element.start, frame.element.openEnd, frame.element.name)
      }
    }

    let pos = from
    while (pos < limit) {
      const c = text[pos]
      if (c === '<') {
        const next = text[pos + 1]
        if (this.tagWordAt(pos, '<iscomment')) {
          const node = this.parseIsComment(pos, limit)
          children().push(node)
          pos = node.end
          continue
        }
        if (this.tagWordAt(pos, '<isscript')) {
          const node = this.parseIsScript(pos, limit)
          children().push(node)
          pos = node.end
          continue
        }
        if (html && text.startsWith('<!--', pos)) {
          const node = this.parseHtmlComment(pos, limit)
          children().push(node)
          pos = node.end
          continue
        }
        if (html && this.startsWithCI('<!doctype', pos)) {
          const close = text.indexOf('>', pos)
          const end = close === -1 || close >= limit ? limit : close + 1
          children().push({ type: 'Doctype', start: pos, end })
          pos = end
          continue
        }
        if (next === '/' && isLetter(text[pos + 2]) && (html || this.isIsmlTagAt(pos, true))) {
          const close = this.parseCloseTag(pos, limit)
          pos = close.end
          this.closeElement(close, stack, children(), popTo)
          continue
        }
        if (isLetter(next) && (html || this.isIsmlTagAt(pos, false))) {
          const element = this.parseStartTag(pos, limit)
          pos = element.openEnd
          children().push(element)
          // Past the depth limit an element holds nothing: what follows becomes its sibling.
          const room = stack.length < MAX_ELEMENT_DEPTH
          if (element.isml) {
            if (element.name === 'ismodule') this.addModule(element)
            if (ISML_CONTAINERS.has(element.name) && !element.selfClosing) {
              if (room) stack.push({ element })
              else this.reportTooDeep(element)
            }
          } else if (!element.selfClosing && !HTML_VOID.has(element.name)) {
            if (element.name === 'script' || element.name === 'style') {
              pos = this.parseRawText(element, limit)
            } else if (room) {
              stack.push({ element })
            } else {
              this.reportTooDeep(element)
            }
          }
          continue
        }
        addText(pos, pos + 1)
        pos++
        continue
      }
      if (c === '$' && text[pos + 1] === '{') {
        const expression = this.parseExpression(pos, limit, null)
        children().push(expression)
        pos = expression.end
        continue
      }
      // Text up to the next `<` or `$`.
      let end = pos + 1
      while (end < limit && text[end] !== '<' && text[end] !== '$') end++
      addText(pos, end)
      pos = end
    }
    popTo(0, limit)
    return root
  }

  /** Matches an end tag with an open element; keeps it as a `CloseTag` when it closes nothing. */
  private closeElement(close: CloseTag, stack: OpenFrame[], siblings: IsmlNode[], popTo: (index: number, at: number) => void): void {
    const isml = close.name.startsWith('is')
    for (let i = stack.length - 1; i >= 0; i--) {
      const element = stack[i].element
      if (element.name === close.name) {
        popTo(i + 1, close.start)
        stack.pop()
        element.close = { start: close.start, end: close.end }
        element.end = close.end
        return
      }
      // An HTML end tag never closes past an open ISML tag.
      if (!isml && element.isml) break
    }
    // `<isprint …></isprint>`: an end tag right after an empty tag of the same name closes it.
    for (let i = siblings.length - 1; i >= 0; i--) {
      const sibling = siblings[i]
      if (sibling.type === 'Text' && this.text.slice(sibling.start, sibling.end).trim() === '') continue
      if (sibling.type === 'Element' && sibling.name === close.name && sibling.close === null && !sibling.selfClosing) {
        sibling.close = { start: close.start, end: close.end }
        sibling.end = close.end
        sibling.children = siblings.splice(i + 1)
        return
      }
      break
    }
    if (isml) this.report('unexpected_close_tag', close.start, close.end, close.name)
    siblings.push(close)
  }

  private addModule(element: Element): void {
    const value = (name: string) => {
      const attribute = element.attributes.find((a) => a.name === name)
      if (!attribute || !attribute.value) return null
      return attribute.value.parts.every((part) => part.type === 'Text') ? this.text.slice(attribute.value.contentStart, attribute.value.contentEnd) : null
    }
    const name = value('name')
    if (name === null) return
    const attributes = element.attributes
      .filter((a) => a.name === 'attribute' && a.value)
      .map((a) => this.text.slice((a.value as AttributeValue).contentStart, (a.value as AttributeValue).contentEnd))
    this.modules.push({ name: name.toLowerCase(), template: value('template'), attributes, start: element.start, end: element.end })
  }

  /** `<script>` and `<style>`: their content is text for HTML, but ISML in it is parsed. Answers where parsing resumes. */
  private parseRawText(element: Element, limit: number): number {
    const match = this.find(element.name === 'script' ? /<\/script/gi : /<\/style/gi, element.openEnd, limit)
    if (!match) {
      // No end tag: the rest is parsed as ordinary content.
      this.report('unclosed_raw_text', element.start, element.openEnd, element.name)
      return element.openEnd
    }
    const closeStart = match.index
    element.children = this.parseNodes(element.openEnd, closeStart, false)
    const close = this.parseCloseTag(closeStart, limit)
    element.close = { start: close.start, end: close.end }
    element.end = close.end
    return close.end
  }

  private parseCloseTag(start: number, limit: number): CloseTag {
    const text = this.text
    let p = start + 2
    while (p < limit && NAME_CHAR.test(text[p])) p++
    const name = text.slice(start + 2, p).toLowerCase()
    // Up to its `>`; an end tag missing one stops before the next `<` or the end of its line.
    while (p < limit && text[p] !== '>' && text[p] !== '<' && text[p] !== '\n') p++
    if (p < limit && text[p] === '>') p++
    else this.report('unclosed_start_tag', start, p, name)
    return { type: 'CloseTag', name, start, end: p }
  }

  private parseStartTag(start: number, limit: number): Element {
    const text = this.text
    let p = start + 1
    while (p < limit && NAME_CHAR.test(text[p])) p++
    const name = text.slice(start + 1, p).toLowerCase()
    const isml = name.startsWith('is') && name.length > 2
    const element: Element = {
      type: 'Element',
      name,
      nameStart: start + 1,
      nameEnd: p,
      isml,
      custom: isml && !ISML_TAGS.has(name),
      attributes: [],
      inTag: [],
      children: [],
      openEnd: p,
      selfClosing: false,
      close: null,
      start,
      end: p
    }
    for (;;) {
      while (p < limit && isSpace(text[p])) p++
      if (p >= limit) {
        this.report('unclosed_start_tag', start, p, name)
        break
      }
      const c = text[p]
      if (c === '>') {
        p++
        break
      }
      if (c === '/' && text[p + 1] === '>') {
        element.selfClosing = true
        p += 2
        break
      }
      if (c === '<') {
        if (this.isIsmlTagAt(p, false)) {
          const inner = this.parseStartTag(p, limit)
          element.inTag.push(inner)
          p = inner.openEnd
          continue
        }
        if (this.isIsmlTagAt(p, true)) {
          const close = this.parseCloseTag(p, limit)
          element.inTag.push(close)
          p = close.end
          continue
        }
        // Another tag begins: this one was never closed.
        this.report('unclosed_start_tag', start, p, name)
        break
      }
      if (c === '$' && text[p + 1] === '{') {
        const expression = this.parseExpression(p, limit, null)
        element.inTag.push(expression)
        p = expression.end
        continue
      }
      if (c === '/' || c === '"' || c === "'" || c === '=' || c === '`') {
        // A stray character among the attributes.
        p++
        continue
      }
      const attribute = this.parseAttribute(p, limit)
      element.attributes.push(attribute)
      p = attribute.end
      // A value missing its quote ends the tag too: what follows is parsed as content.
      if (attribute.value && !attribute.value.closed) break
    }
    element.openEnd = p
    element.end = p
    return element
  }

  private parseAttribute(start: number, limit: number): Attribute {
    const text = this.text
    let p = start
    while (p < limit) {
      const c = text[p]
      if (isSpace(c) || c === '"' || c === "'" || c === '<' || c === '>' || c === '/' || c === '=' || (c === '$' && text[p + 1] === '{')) break
      p++
    }
    const attribute: Attribute = { name: text.slice(start, p).toLowerCase(), nameStart: start, nameEnd: p, value: null, start, end: p }
    let q = p
    while (q < limit && isSpace(text[q])) q++
    if (text[q] !== '=') return attribute
    q++
    while (q < limit && isSpace(text[q])) q++
    if (q >= limit) {
      attribute.end = q
      return attribute
    }
    const c = text[q]
    attribute.value = c === '"' || c === "'" ? this.parseQuotedValue(q, limit, c) : this.parseUnquotedValue(q, limit)
    attribute.end = attribute.value.end
    return attribute
  }

  private parseQuotedValue(start: number, limit: number, quote: '"' | "'"): AttributeValue {
    let scan = this.scanValueParts(start + 1, limit, quote)
    if (!scan.closed) {
      // No closing quote: the value stops at the end of its line, and the rest is parsed again.
      let lineEnd = this.text.indexOf('\n', start)
      if (lineEnd === -1 || lineEnd > limit) lineEnd = limit
      scan = this.scanValueParts(start + 1, lineEnd, quote)
      this.report('unclosed_attribute_value', start, scan.end)
      return { quote, contentStart: start + 1, contentEnd: scan.end, parts: scan.parts, closed: false, start, end: scan.end }
    }
    return { quote, contentStart: start + 1, contentEnd: scan.end, parts: scan.parts, closed: true, start, end: scan.end + 1 }
  }

  /**
   * The parts of a quoted value from `from`, up to its quote (`closed`) or `limit`. A value may
   * span lines, but not into a line that starts with a tag: its quote is taken as missing there.
   */
  private scanValueParts(from: number, limit: number, quote: '"' | "'"): { parts: AttributeValue['parts']; end: number; closed: boolean } {
    const text = this.text
    const parts: AttributeValue['parts'] = []
    let p = from
    let textStart = from
    const flush = (end: number) => {
      if (end > textStart) parts.push({ type: 'Text', start: textStart, end })
    }
    while (p < limit) {
      const c = text[p]
      if (c === quote) {
        flush(p)
        return { parts, end: p, closed: true }
      }
      if (c === '\n') {
        let q = p + 1
        while (q < limit && (text[q] === ' ' || text[q] === '\t' || text[q] === '\r')) q++
        if (text[q] === '<' && (isLetter(text[q + 1]) || text[q + 1] === '/' || text[q + 1] === '!')) {
          flush(p)
          return { parts, end: p, closed: false }
        }
      }
      if (c === '$' && text[p + 1] === '{') {
        flush(p)
        const expression = this.parseExpression(p, limit, quote)
        parts.push(expression)
        p = textStart = expression.end
        continue
      }
      if (c === '<' && this.isIsmlTagAt(p, false)) {
        flush(p)
        const element = this.parseStartTag(p, limit)
        parts.push(element)
        p = textStart = element.openEnd
        continue
      }
      if (c === '<' && this.isIsmlTagAt(p, true)) {
        flush(p)
        const close = this.parseCloseTag(p, limit)
        parts.push(close)
        p = textStart = close.end
        continue
      }
      p++
    }
    flush(p)
    return { parts, end: p, closed: false }
  }

  private parseUnquotedValue(start: number, limit: number): AttributeValue {
    const text = this.text
    const parts: AttributeValue['parts'] = []
    let p = start
    let textStart = start
    while (p < limit) {
      const c = text[p]
      if (c === '$' && text[p + 1] === '{') {
        if (p > textStart) parts.push({ type: 'Text', start: textStart, end: p })
        const expression = this.parseExpression(p, limit, null)
        parts.push(expression)
        p = textStart = expression.end
        continue
      }
      if (isSpace(c) || c === '"' || c === "'" || c === '<' || c === '>' || c === '=' || c === '`') break
      p++
    }
    if (p > textStart) parts.push({ type: 'Text', start: textStart, end: p })
    return { quote: null, contentStart: start, contentEnd: p, parts, closed: true, start, end: p }
  }

  /**
   * A `${…}` at `start`. In a quoted value (`quote`), a `${…}` that balances on its line may hold
   * that quote in its strings; one that does not stops before the quote.
   */
  parseExpression(start: number, limit: number, quote: '"' | "'" | null): IsmlExpression {
    const codeStart = start + 2
    let scan = scanExpression(this.text, codeStart, limit, quote, quote !== null)
    if (!scan.closed && quote !== null) scan = scanExpression(this.text, codeStart, limit, quote, false)
    if (scan.closed) return { type: 'Expression', codeStart, codeEnd: scan.end, closed: true, start, end: scan.end + 1 }
    this.report('unclosed_expression', start, scan.end)
    return { type: 'Expression', codeStart, codeEnd: scan.end, closed: false, start, end: scan.end }
  }

  private parseHtmlComment(start: number, limit: number): HtmlComment {
    const close = this.text.indexOf('-->', start + 4)
    if (close === -1 || close + 3 > limit) {
      this.report('unclosed_comment', start, start + 4)
      return { type: 'Comment', children: [], closed: false, start, end: start + 4 }
    }
    const children = this.parseNodes(start + 4, close, false)
    return { type: 'Comment', children, closed: true, start, end: close + 3 }
  }

  private parseIsComment(start: number, limit: number): IsComment {
    const open = this.parseStartTag(start, limit)
    const contentStart = open.openEnd
    if (open.selfClosing) return { type: 'IsComment', contentStart, contentEnd: contentStart, closed: true, start, end: contentStart }
    const match = this.find(/<\/iscomment\s*>/gi, contentStart, limit)
    if (!match) {
      // Unclosed: only the tag itself is the comment; what follows is parsed as usual.
      this.report('unclosed_iscomment', start, contentStart)
      return { type: 'IsComment', contentStart, contentEnd: contentStart, closed: false, start, end: contentStart }
    }
    const contentEnd = match.index
    return { type: 'IsComment', contentStart, contentEnd, closed: true, start, end: contentEnd + match[0].length }
  }

  private parseIsScript(start: number, limit: number): IsScript {
    const open = this.parseStartTag(start, limit)
    const codeStart = open.openEnd
    const node: IsScript = { type: 'IsScript', attributes: open.attributes, openEnd: open.openEnd, codeStart, codeEnd: codeStart, close: null, start, end: codeStart }
    if (open.selfClosing) return node
    const match = this.find(/<\/isscript\s*>/gi, codeStart, limit)
    if (match) {
      node.codeEnd = match.index
      node.close = { start: node.codeEnd, end: node.codeEnd + match[0].length }
      node.end = node.close.end
      return node
    }
    // Unclosed: the script stops before the next line that starts with a tag.
    const tagLine = this.find(/\n[ \t]*<[A-Za-z/!]/g, codeStart, limit)
    node.codeEnd = tagLine ? tagLine.index + 1 : limit
    node.end = node.codeEnd
    this.report('unclosed_isscript', start, codeStart)
    return node
  }
}

/**
 * Where a `${…}` whose code starts at `from` ends: at the `}` that balances it (`closed`), or
 * where an unclosed one stops: the end of the line, `</` or `-->` (outside a quoted value), or
 * `quote` unless `lenient`.
 */
export function scanExpression(text: string, from: number, limit: number, quote: '"' | "'" | null, lenient: boolean): { end: number; closed: boolean } {
  // What is open: ordinary braces, a template literal, a template's `${`.
  const stack: ('brace' | 'template' | 'substitution')[] = []
  let p = from
  const stops = (c: string) => c === '\n' || c === '\r' || (quote !== null && !lenient && c === quote)
  while (p < limit) {
    const c = text[p]
    if (stops(c)) return { end: p, closed: false }
    if (stack[stack.length - 1] === 'template') {
      if (c === '`') stack.pop()
      else if (c === '\\') p++
      else if (c === '$' && text[p + 1] === '{') {
        stack.push('substitution')
        p++
      }
      p++
      continue
    }
    if (quote === null && c === '<' && text[p + 1] === '/') return { end: p, closed: false }
    if (quote === null && c === '-' && text.startsWith('-->', p)) return { end: p, closed: false }
    if (c === '}') {
      if (stack.length === 0) return { end: p, closed: true }
      stack.pop()
      p++
      continue
    }
    if (c === '{') {
      stack.push('brace')
      p++
      continue
    }
    if (c === '`') {
      stack.push('template')
      p++
      continue
    }
    if (c === '"' || c === "'") {
      // A string, to its quote or the end of its line (or the value's quote).
      p++
      while (p < limit) {
        const s = text[p]
        if (s === c) {
          p++
          break
        }
        if (stops(s)) break
        p += s === '\\' ? 2 : 1
      }
      continue
    }
    if (c === '/' && text[p + 1] === '*') {
      const close = text.indexOf('*/', p + 2)
      const lineEnd = text.indexOf('\n', p)
      p = close !== -1 && close < limit && (lineEnd === -1 || close < lineEnd) ? close + 2 : p + 2
      continue
    }
    p++
  }
  return { end: Math.min(p, limit), closed: false }
}

// ---------------------------------------------------------------------------------------------
// Lookups

/** The attribute `name` of an element, if present. */
export function attribute(element: Element | IsScript, name: string): Attribute | null {
  return element.attributes.find((a) => a.name === name) ?? null
}

/** The plain text of an attribute's value, or `null` when it has none or holds `${…}` or tags. */
export function attributeText(text: string, element: Element | IsScript, name: string): string | null {
  const found = attribute(element, name)
  if (!found || !found.value || !found.value.parts.every((part) => part.type === 'Text')) return null
  return text.slice(found.value.contentStart, found.value.contentEnd)
}

/** Calls `visit` on every node of the document, in source order: children, attribute values and tag contents included. */
export function walkTemplate(document: IsmlDocument, visit: (node: IsmlNode) => void): void {
  const walk = (nodes: readonly IsmlNode[]) => {
    for (const node of nodes) {
      visit(node)
      if (node.type === 'Element') {
        const inner: IsmlNode[] = [...node.inTag]
        for (const a of node.attributes) if (a.value) inner.push(...a.value.parts)
        inner.sort((x, y) => x.start - y.start)
        walk(inner)
        walk(node.children)
      } else if (node.type === 'Comment') {
        walk(node.children)
      }
    }
  }
  walk(document.children)
}
