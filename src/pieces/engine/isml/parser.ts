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
import { countWork } from '../work'

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

/** How many tags may be read inside one another (ISML tags inside a tag or a value): deeper, the tag ends there. */
export const MAX_TAG_NESTING = 32

/**
 * How far a `${…}` that spans lines may run looking for its `}`: past this many lines or
 * characters, or at a line that starts with a tag, it is unclosed and ends with its first line.
 */
export const EXPRESSION_LINES = 20
export const EXPRESSION_CHARACTERS = 4000

// What the parser searches for. Module constants: `find` remembers its last search per pattern.
const COMMENT_END = /-->/g
const ISCOMMENT_END = /<\/iscomment\s*>/gi
const ISSCRIPT_END = /<\/isscript\s*>/gi
const SCRIPT_END = /<\/script/gi
const STYLE_END = /<\/style/gi
const TAG_LINE = /(?:\r\n?|\n)[ \t]*<[A-Za-z/!]/g

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
  countWork(parser.scanned)
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
    this.rescanBudget = 2 * text.length + EXPRESSION_CHARACTERS
  }

  private tooDeep = false

  /** Reports `too_deep` once per template, at the first element or tag past a limit. */
  private reportTooDeep(start: number, end: number): void {
    if (this.tooDeep) return
    this.tooDeep = true
    this.report('too_deep', start, end)
  }

  report(code: ProblemCode, start: number, end: number, detail?: string): void {
    this.problems.push(detail === undefined ? { code, start, end } : { code, start, end, detail })
  }

  /**
   * The characters this parse read (../work.ts): each construct's span, each search for an end,
   * each scan thrown away. A span nested in another is counted in both: nesting is bounded, so
   * the count stays within a fixed multiple of the work.
   */
  scanned = 0

  /** The last search of each pattern: from where, and its first match in the whole text (or none). */
  private readonly searches = new Map<RegExp, { from: number; match: RegExpExecArray | null }>()

  /**
   * The first match of the global pattern `pattern` from `from` that ends by `limit`. The last
   * search of each pattern is remembered, so a run of unclosed constructs that each look for
   * their end (`-->`, `</iscomment>`) reads the text once, not once per construct.
   */
  private find(pattern: RegExp, from: number, limit: number): RegExpExecArray | null {
    const known = this.searches.get(pattern)
    let match: RegExpExecArray | null
    if (known && known.from <= from && (known.match === null || from <= known.match.index)) {
      match = known.match
    } else {
      pattern.lastIndex = from
      match = pattern.exec(this.text)
      this.scanned += (match ? match.index + match[0].length : this.text.length) - from
      this.searches.set(pattern, { from, match })
    }
    return match && match.index + match[0].length <= limit ? match : null
  }

  /** At `at` (a line break) the next line starts with a tag; ISML tags count unless `html` only. */
  private tagLineAfter(at: number, limit: number, htmlOnly: boolean): boolean {
    const text = this.text
    let q = at + (text[at] === '\r' && text[at + 1] === '\n' ? 2 : 1)
    while (q < limit && (text[q] === ' ' || text[q] === '\t')) q++
    this.scanned += q - at + 1
    if (text[q] !== '<' || !(isLetter(text[q + 1]) || text[q + 1] === '/' || text[q + 1] === '!')) return false
    return !htmlOnly || !(this.isIsmlTagAt(q, false) || this.isIsmlTagAt(q, true))
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
    // Its position only moves forward, to `limit`.
    this.scanned += limit - from
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
          // To its `>`; one missing it stops before the next `<` or the end of its line.
          let end = pos + 2
          while (end < limit && text[end] !== '>' && text[end] !== '<' && text[end] !== '\n' && text[end] !== '\r') end++
          if (end < limit && text[end] === '>') end++
          this.scanned += end - pos
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
              else this.reportTooDeep(element.start, element.openEnd)
            }
          } else if (!element.selfClosing && !HTML_VOID.has(element.name)) {
            if (element.name === 'script' || element.name === 'style') {
              pos = this.parseRawText(element, limit)
            } else if (room) {
              stack.push({ element })
            } else {
              this.reportTooDeep(element.start, element.openEnd)
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
      this.scanned++
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
      this.scanned += 1 + (sibling.type === 'Text' ? sibling.end - sibling.start : 0)
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
    const match = this.find(element.name === 'script' ? SCRIPT_END : STYLE_END, element.openEnd, limit)
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
    while (p < limit && text[p] !== '>' && text[p] !== '<' && text[p] !== '\n' && text[p] !== '\r') p++
    if (p < limit && text[p] === '>') p++
    else this.report('unclosed_start_tag', start, p, name)
    this.scanned += p - start
    return { type: 'CloseTag', name, start, end: p }
  }

  /** How many start tags are being read inside one another (ISML tags inside a tag or a value). */
  private tagDepth = 0

  /**
   * How many characters may still be read and then thrown away: by a lenient `${…}` pass that
   * fails, and by an unclosed value read past the end of its line. What is thrown away is read
   * again, so without a bound a long line of such constructs costs quadratic time; with one, the
   * whole parse reads at most about three times the text. Real templates never spend it.
   */
  private rescanBudget: number

  private parseStartTag(start: number, limit: number): Element {
    this.tagDepth++
    try {
      return this.parseStartTagInner(start, limit)
    } finally {
      this.tagDepth--
    }
  }

  /** Whether one more tag may be read inside the current one; past the bound it reports `too_deep` once. */
  private roomForTag(at: number): boolean {
    if (this.tagDepth < MAX_TAG_NESTING) return true
    this.reportTooDeep(at, at + 1)
    return false
  }

  private parseStartTagInner(start: number, limit: number): Element {
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
        const ismlOpen = this.isIsmlTagAt(p, false)
        if (ismlOpen && !this.roomForTag(p)) {
          // Too many tags inside one another: this one ends here, and the rest is read as content.
          break
        }
        if (ismlOpen) {
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
    this.scanned += p - start
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
    this.scanned += q - start + 1
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
    const mark = this.problems.length
    // Past the rescan budget a value no longer looks beyond its line for its quote.
    const scan = this.scanValueParts(start + 1, limit, quote, this.rescanBudget <= 0)
    if (scan.closed) return { quote, contentStart: start + 1, contentEnd: scan.end, parts: scan.parts, closed: true, start, end: scan.end + 1 }
    // No closing quote: the value stops at the end of its line, and the rest is parsed again as
    // content. The scan is cut there, never run twice (tags nested in values would make that
    // exponential): a part that crosses the cut moves it back to where the part starts.
    let cut = start
    while (cut < scan.end && this.text[cut] !== '\n' && this.text[cut] !== '\r') cut++
    this.scanned += cut - start + (this.problems.length - mark)
    const parts: AttributeValue['parts'] = []
    for (const part of scan.parts) {
      if (part.end <= cut) {
        parts.push(part)
        continue
      }
      if (part.type === 'Text' && part.start < cut) parts.push({ type: 'Text', start: part.start, end: cut })
      else if (part.start < cut) cut = part.start
      break
    }
    this.rescanBudget -= scan.end - cut
    // What was read past the cut is read again: its problems go with it.
    for (let i = this.problems.length - 1; i >= mark; i--) if (this.problems[i].start >= cut) this.problems.splice(i, 1)
    this.report('unclosed_attribute_value', start, cut)
    return { quote, contentStart: start + 1, contentEnd: cut, parts, closed: false, start, end: cut }
  }

  /**
   * The parts of a quoted value from `from`, up to its quote (`closed`) or `limit`. A value may
   * span lines, but not into a line that starts with an HTML tag: its quote is taken as missing
   * there. An ISML tag belongs in a value, at the start of a line too (`class="a\n<isif …>b</isif>"`).
   */
  private scanValueParts(from: number, limit: number, quote: '"' | "'", oneLine = false): { parts: AttributeValue['parts']; end: number; closed: boolean } {
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
        this.scanned += p - from
        return { parts, end: p, closed: true }
      }
      if ((c === '\n' || c === '\r') && (oneLine || this.tagLineAfter(p, limit, true))) {
        flush(p)
        this.scanned += p - from
        return { parts, end: p, closed: false }
      }
      if (c === '$' && text[p + 1] === '{') {
        flush(p)
        const expression = this.parseExpression(p, limit, quote)
        parts.push(expression)
        p = textStart = expression.end
        continue
      }
      if (c === '<' && this.isIsmlTagAt(p, false) && this.roomForTag(p)) {
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
    this.scanned += p - from
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
    this.scanned += p - start
    return { quote: null, contentStart: start, contentEnd: p, parts, closed: true, start, end: p }
  }

  /**
   * A `${…}` at `start`. In a quoted value (`quote`), a `${…}` that balances on its line may hold
   * that quote in its strings; one that does not stops before the quote.
   */
  parseExpression(start: number, limit: number, quote: '"' | "'" | null): IsmlExpression {
    const codeStart = start + 2
    let scan: ExpressionScan = { end: codeStart, closed: false, scanned: 0 }
    // The lenient pass may read past the value's quote; when it fails, what it read is read again
    // by what follows, so its work is charged to the rescan budget, and once that is spent only
    // the strict pass runs.
    if (quote !== null && this.rescanBudget > 0) {
      scan = scanExpression(this.text, codeStart, limit, quote, true, this.rescanBudget)
      this.scanned += scan.scanned
      if (!scan.closed) this.rescanBudget -= scan.scanned
    }
    if (!scan.closed) {
      scan = scanExpression(this.text, codeStart, limit, quote, false)
      this.scanned += scan.scanned
    }
    if (scan.closed) return { type: 'Expression', codeStart, codeEnd: scan.end, closed: true, start, end: scan.end + 1 }
    this.report('unclosed_expression', start, scan.end)
    return { type: 'Expression', codeStart, codeEnd: scan.end, closed: false, start, end: scan.end }
  }

  private parseHtmlComment(start: number, limit: number): HtmlComment {
    const match = this.find(COMMENT_END, start + 4, limit)
    if (!match) {
      this.report('unclosed_comment', start, start + 4)
      return { type: 'Comment', children: [], closed: false, start, end: start + 4 }
    }
    const close = match.index
    const children = this.parseNodes(start + 4, close, false)
    return { type: 'Comment', children, closed: true, start, end: close + 3 }
  }

  private parseIsComment(start: number, limit: number): IsComment {
    const open = this.parseStartTag(start, limit)
    const contentStart = open.openEnd
    if (open.selfClosing) return { type: 'IsComment', contentStart, contentEnd: contentStart, closed: true, start, end: contentStart }
    const match = this.find(ISCOMMENT_END, contentStart, limit)
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
    const match = this.find(ISSCRIPT_END, codeStart, limit)
    if (match) {
      node.codeEnd = match.index
      node.close = { start: node.codeEnd, end: node.codeEnd + match[0].length }
      node.end = node.close.end
      return node
    }
    // Unclosed: the script stops before the next line that starts with a tag.
    const tagLine = this.find(TAG_LINE, codeStart, limit)
    node.codeEnd = tagLine ? tagLine.index + (tagLine[0].startsWith('\r\n') ? 2 : 1) : limit
    node.end = node.codeEnd
    this.report('unclosed_isscript', start, codeStart)
    return node
  }
}

/**
 * Where a `${…}` whose code starts at `from` ends: at the `}` that balances it (`closed`), over
 * nested braces, strings, template literals, regex literals and `/* *\/` comments, across lines
 * too. One that does not balance is unclosed and ends at the first of: the end of its first line,
 * `</` or `-->` (outside a quoted value), or `quote` unless `lenient`. Looking for the balance
 * past its first line stops at a line that starts with a tag, or past `EXPRESSION_LINES` or
 * `EXPRESSION_CHARACTERS` (checked on every character), and the whole scan stops past `budget`
 * characters. `scanned` says how far it read: the parser charges a failed lenient scan to its
 * rescan budget, which keeps a whole template linear.
 */
export function scanExpression(
  text: string,
  from: number,
  limit: number,
  quote: '"' | "'" | null,
  lenient: boolean,
  budget = Infinity
): ExpressionScan {
  // What is open: ordinary braces, a template literal, a template's `${`.
  const stack: ('brace' | 'template' | 'substitution')[] = []
  let p = from
  let firstLineEnd = -1
  let lines = 0
  // The last character of code that is not a space: whether a `/` starts a regex or divides.
  let previous = ''
  const unclosed = (at: number): ExpressionScan => ({
    end: firstLineEnd === -1 ? Math.min(at, limit) : Math.min(at, firstLineEnd),
    closed: false,
    scanned: Math.min(at, limit) - from
  })
  const stopsAt = (c: string) => quote !== null && !lenient && c === quote
  while (p < limit) {
    // Checked on every character, not only at line breaks: a long line is bounded too.
    if (p - from > budget || (firstLineEnd !== -1 && p - from > EXPRESSION_CHARACTERS)) return unclosed(p)
    const c = text[p]
    if (c === '\n' || c === '\r') {
      if (firstLineEnd === -1) firstLineEnd = p
      const next = p + (c === '\r' && text[p + 1] === '\n' ? 2 : 1)
      lines++
      if (lines > EXPRESSION_LINES || next - from > EXPRESSION_CHARACTERS || startsTag(text, next, limit)) return unclosed(p)
      p = next
      continue
    }
    if (stopsAt(c)) return unclosed(p)
    if (stack[stack.length - 1] === 'template') {
      if (c === '`') stack.pop()
      else if (c === '\\') p++
      else if (c === '$' && text[p + 1] === '{') {
        stack.push('substitution')
        p++
      }
      p++
      previous = 'a'
      continue
    }
    if (quote === null && c === '<' && text[p + 1] === '/') return unclosed(p)
    if (quote === null && c === '-' && text.startsWith('-->', p)) return unclosed(p)
    if (c === '}') {
      if (stack.length === 0) return { end: p, closed: true, scanned: p - from }
      stack.pop()
      p++
      previous = '}'
      continue
    }
    if (c === '{') {
      stack.push('brace')
      p++
      previous = '{'
      continue
    }
    if (c === '`') {
      stack.push('template')
      p++
      continue
    }
    if (c === '"' || c === "'") {
      // A string: to its quote, or it ends at its line (or at the value's quote).
      p++
      while (p < limit) {
        const s = text[p]
        if (s === c) {
          p++
          break
        }
        if (s === '\n' || s === '\r' || stopsAt(s)) break
        p += s === '\\' ? 2 : 1
      }
      previous = 'a'
      continue
    }
    if (c === '/' && text[p + 1] === '*') {
      // A comment, to its `*/` on the same line.
      p += 2
      while (p < limit && text[p] !== '\n' && text[p] !== '\r' && !(text[p] === '*' && text[p + 1] === '/')) p++
      if (p < limit && text[p] === '*') p += 2
      continue
    }
    if (c === '/' && REGEX_BEFORE.includes(previous)) {
      // A regex literal: its quotes and braces are not code.
      p++
      let inClass = false
      while (p < limit) {
        const r = text[p]
        if (r === '\n' || r === '\r' || stopsAt(r)) break
        if (r === '\\') {
          p += 2
          continue
        }
        p++
        if (r === '[') inClass = true
        else if (r === ']') inClass = false
        else if (r === '/' && !inClass) break
      }
      previous = 'a'
      continue
    }
    if ((c === '+' || c === '-') && text[p + 1] === c) {
      // `++` and `--` end an operand (`count++ / 2` divides): after them a `/` divides.
      previous = 'a'
      p += 2
      continue
    }
    if (c !== ' ' && c !== '\t') previous = c
    p++
  }
  return unclosed(limit)
}

/** Where a scan of a `${…}` ended, whether it balanced, and how many characters it read. */
export interface ExpressionScan {
  end: number
  closed: boolean
  scanned: number
}

// After these (or at the start), a `/` begins a regex literal; after anything else it divides.
const REGEX_BEFORE = ['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '<', '>', '~', '^']

/** At `at` starts a line whose first character, after spaces, opens a tag. */
function startsTag(text: string, at: number, limit: number): boolean {
  let q = at
  while (q < limit && (text[q] === ' ' || text[q] === '\t')) q++
  return text[q] === '<' && (isLetter(text[q + 1]) || text[q + 1] === '/' || text[q + 1] === '!')
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
  // An explicit stack, not recursion: nodes are pushed in reverse so they come off in order.
  const stack: IsmlNode[] = []
  const pushAll = (nodes: readonly IsmlNode[]) => {
    for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i])
  }
  pushAll(document.children)
  while (stack.length > 0) {
    const node = stack.pop() as IsmlNode
    visit(node)
    if (node.type === 'Element') {
      const inner: IsmlNode[] = [...node.inTag]
      for (const a of node.attributes) if (a.value) for (const part of a.value.parts) inner.push(part)
      inner.sort((x, y) => x.start - y.start)
      pushAll(node.children)
      pushAll(inner)
    } else if (node.type === 'Comment') {
      pushAll(node.children)
    }
  }
}
