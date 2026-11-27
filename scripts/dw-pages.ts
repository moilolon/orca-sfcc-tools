// Turns the Markdown of a Script API class page, as `b2c docs read <id> --json` hands it over,
// into its entry of the `dw.*` index: inheritance, constants, properties, constructors and
// methods, with types and deprecation, and no description of any kind. Pure: the generator
// (./generate-dw-index.ts) reads the pages, the tests hand it invented ones.
//
// The shape it expects (every rule is checked; a page that breaks one fails with its class and
// section, so a change of the documentation is seen, never half read):
//
//   # Class Widget
//   - [TopLevel.Object](…/TopLevel.Object.md)          the chain from the root, two spaces a step,
//     - [dw.example.Widget](…/dw.example.Widget.md)    the class itself last
//   <description, perhaps **Deprecated:** on a line of its own>
//   ## Constant Summary | Property Summary | Constructor Summary | Method Summary
//   ## Constant Details | Property Details | Constructor Details | Method Details
//   ### <heading>                                       one per member, unique on the page
//   - [~~][static ]<name>: <type>[ = <value>][~~][ `(read-only)`]
//   - [~~][static ]<name>(<param>: <type>, …)[: <type>][~~]
//   ## All Known Subclasses
//   [Name](…/<id>.md), [Name](…/<id>.md)
//
// A type is a link to a class page (`[String](…/TopLevel.String.md)`, `[String\[\]](…)` for an
// array, `[String...](…)` for a rest parameter) or a bare word (`void`). A member is deprecated
// when its line is struck through or its section says `**Deprecated:**`.
import {
  anchorOf,
  callableKey,
  simpleName,
  type DwCallableData,
  type DwClassData,
  type DwConstantData,
  type DwParam,
  type DwPropertyData
} from '../src/pieces/engine/dw/index'

/** A page that does not have the expected shape: which class, which section, what. */
export class PageShapeError extends Error {
  readonly page: string
  readonly section: string
  constructor(page: string, section: string, detail: string) {
    super(`${page}, ${section}: ${detail}`)
    this.name = 'PageShapeError'
    this.page = page
    this.section = section
  }
}

const SUMMARIES = ['Constant Summary', 'Property Summary', 'Constructor Summary', 'Method Summary'] as const
const DETAILS = ['Constant Details', 'Property Details', 'Constructor Details', 'Method Details'] as const
const SUBCLASSES = 'All Known Subclasses'
const KNOWN_SECTIONS: ReadonlySet<string> = new Set([...SUMMARIES, ...DETAILS, SUBCLASSES])
const NO_CONSTRUCTOR = 'This class does not have a constructor, so you cannot create it directly.'
/** The `### ` headings a summary may hold: the lists of inherited members. */
const INHERITED = /^(Constants|Properties|Methods) inherited from class [A-Za-z0-9_$]+$/

/** The class id a link to a page names: `dw.catalog.Product` for `…/dw.catalog.Product.md#x`. */
function idOfUrl(url: string): string | null {
  const match = /(?:^|\/)([A-Za-z][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\.md(?:#[^)\s]*)?$/.exec(url)
  return match ? match[1] : null
}

/** Markdown's escapes removed: `SQRT1\_2` is `SQRT1_2`, `String\[\]` is `String[]`. */
function unescape(text: string): string {
  return text.replace(/\\([^A-Za-z0-9\s])/g, '$1')
}

type Section = { title: string; lines: string[] }

/** The page cut at its `## ` headings; `head` is what comes before the first one. */
function sectionsOf(page: string, lines: string[]): { head: string[]; sections: Section[] } {
  const head: string[] = []
  const sections: Section[] = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim()
      if (!KNOWN_SECTIONS.has(title)) throw new PageShapeError(page, title, 'unknown section')
      if (sections.some((each) => each.title === title)) throw new PageShapeError(page, title, 'section given twice')
      sections.push({ title, lines: [] })
    } else if (sections.length) sections[sections.length - 1].lines.push(line)
    else head.push(line)
  }
  return { head, sections }
}

/** The title, the inheritance chain (root first, the class last) and the class's deprecation. */
function parseHead(page: string, head: string[]): { chain: string[]; deprecated: boolean } {
  const name = page.slice(page.lastIndexOf('.') + 1)
  if (head[0] !== `# Class ${name}`) throw new PageShapeError(page, 'title', `expected "# Class ${name}"`)
  let at = 1
  while (head[at] === '') at++
  const chain: string[] = []
  for (; at < head.length && /^\s*- /.test(head[at]); at++) {
    const match = /^( *)- \[([^\]]+)\]\(([^)]+)\)$/.exec(head[at])
    if (!match || match[1].length !== chain.length * 2) throw new PageShapeError(page, 'inheritance', `unexpected line "${head[at]}"`)
    const id = idOfUrl(match[3])
    if (!id || unescape(match[2]) !== id) throw new PageShapeError(page, 'inheritance', `the link "${match[2]}" does not name its page`)
    chain.push(id)
  }
  if (!chain.length) throw new PageShapeError(page, 'inheritance', 'no inheritance list')
  if (chain[chain.length - 1] !== page) throw new PageShapeError(page, 'inheritance', 'the list does not end with the class itself')
  return { chain, deprecated: head.slice(at).some((line) => line.trim() === '**Deprecated:**') }
}

/** Reads one member line, left to right; `fail` names what did not match. */
class Cursor {
  private at = 0
  readonly text: string
  private readonly fail: (detail: string) => never
  constructor(text: string, fail: (detail: string) => never) {
    this.text = text
    this.fail = fail
  }
  get done(): boolean {
    return this.at >= this.text.length
  }
  rest(): string {
    return this.text.slice(this.at)
  }
  take(literal: string): boolean {
    if (!this.text.startsWith(literal, this.at)) return false
    this.at += literal.length
    return true
  }
  expect(literal: string): void {
    if (!this.take(literal)) this.fail(`expected "${literal}" at "${this.rest()}"`)
  }
  name(): string {
    const match = /^(?:[A-Za-z_$]|\\_)(?:[\w$]|\\_)*/.exec(this.rest())
    if (!match) this.fail(`expected a name at "${this.rest()}"`)
    this.at += match[0].length
    return unescape(match[0])
  }
  /** A type: a link to a class page, or a bare word. */
  type(): { type: string; rest: boolean } {
    const link = /^\[((?:[^\]\\]|\\.)+)\]\(([^)\s]+)\)/.exec(this.rest())
    if (!link) return { type: this.name(), rest: false }
    this.at += link[0].length
    const label = unescape(link[1])
    const id = idOfUrl(link[2])
    const shape = /^([A-Za-z_$][\w$]*)(\[\]|\.\.\.)?$/.exec(label)
    if (!id || !shape || simpleName(id) !== shape[1]) this.fail(`the type "${label}" does not name its page`)
    return { type: shape[2] === '[]' ? `${id}[]` : id, rest: shape[2] === '...' }
  }
}

type Parsed = {
  name: string
  static: boolean
  deprecated: boolean
  readOnly: boolean
  type?: string
  value?: string | number
  params?: DwParam[]
  returns?: string
}

/** One member line, without its leading `- `. */
function parseMemberLine(line: string, kind: 'constant' | 'property' | 'constructor' | 'method', fail: (detail: string) => never): Parsed {
  let body = line
  let readOnly = false
  if (body.endsWith(' `(read-only)`')) {
    readOnly = true
    body = body.slice(0, -' `(read-only)`'.length)
  }
  let deprecated = false
  if (body.startsWith('~~') && body.endsWith('~~') && body.length > 4) {
    deprecated = true
    body = body.slice(2, -2)
  }
  const cursor = new Cursor(body, fail)
  const isStatic = cursor.take('static ')
  const name = cursor.name()
  const out: Parsed = { name, static: isStatic, deprecated, readOnly }
  if (kind === 'constructor' || kind === 'method') {
    cursor.expect('(')
    out.params = []
    while (!cursor.take(')')) {
      if (out.params.length) cursor.expect(', ')
      const param = cursor.name()
      cursor.expect(': ')
      const { type, rest } = cursor.type()
      out.params.push({ name: param, type, ...(rest ? { rest: true as const } : {}) })
      if (cursor.done) fail('unclosed parameter list')
    }
    if (kind === 'method') {
      cursor.expect(': ')
      out.returns = cursor.type().type
    }
  } else {
    cursor.expect(': ')
    out.type = cursor.type().type
    if (kind === 'constant' && cursor.take(' = ')) {
      const value = cursor.rest()
      if (/^"[^"]*"$/.test(value)) out.value = unescape(value.slice(1, -1))
      else if (/^-?\d+$/.test(value)) out.value = Number(value)
      else fail(`unexpected value "${value}"`)
      cursor.take(value)
    }
  }
  if (!cursor.done) fail(`unexpected "${cursor.rest()}"`)
  if (readOnly && kind !== 'property') fail('read-only on a member that is not a property')
  return out
}

/** The members of one `… Details` section, in page order, each with its heading. */
function parseDetails(page: string, section: Section, linked: ReadonlySet<string>): Array<Parsed & { heading: string }> {
  const kind = ({ 'Constant Details': 'constant', 'Property Details': 'property', 'Constructor Details': 'constructor', 'Method Details': 'method' } as const)[
    section.title as (typeof DETAILS)[number]
  ]
  const out: Array<Parsed & { heading: string }> = []
  const lines = section.lines
  for (let at = 0; at < lines.length; at++) {
    if (!lines[at].startsWith('### ')) {
      if (!out.length && lines[at].trim() && lines[at].trim() !== '***') throw new PageShapeError(page, section.title, `text before the first member: "${lines[at]}"`)
      continue
    }
    const heading = unescape(lines[at].slice(4).trim())
    const fail = (detail: string): never => {
      throw new PageShapeError(page, `${section.title} > ${heading}`, detail)
    }
    let next = at + 1
    while (next < lines.length && lines[next] === '') next++
    if (!lines[next]?.startsWith('- ')) fail('no member line under the heading')
    const member = parseMemberLine(lines[next].slice(2), kind, fail)
    let end = next + 1
    while (end < lines.length && !lines[end].startsWith('### ')) end++
    if (lines.slice(next + 1, end).some((line) => line.trim() === '**Deprecated:**')) member.deprecated = true
    if (kind === 'constructor' && member.name !== page.slice(page.lastIndexOf('.') + 1)) fail('a constructor not named after its class')
    if ((kind === 'constant' || kind === 'property') && heading !== member.name) fail(`the heading does not name the member "${member.name}"`)
    if (kind === 'constructor' || kind === 'method') {
      const key = callableKey({ name: member.name, params: member.params ?? [] })
      // `name(Type, Type)`, or the same followed by ` - Variant 1` for an overload told apart.
      const matches = heading === key || (heading.startsWith(key) && /^ - Variant \d+$/.test(heading.slice(key.length)))
      if (!matches) fail('the heading does not match the member line')
    }
    // The summaries link every member to its section: an anchor no link uses means the
    // documentation's anchors changed, and the index's links would break.
    if (!linked.has(anchorOf(heading))) fail(`no link on the page reaches its anchor "${anchorOf(heading)}"`)
    if (out.some((each) => each.heading === heading)) fail('heading given twice')
    out.push({ ...member, heading })
  }
  return out
}

/** The rows of a summary table, or 0 when the section says the class has no constructor. */
function summaryRows(page: string, section: Section): number {
  const inherited = section.lines.findIndex((line) => line.startsWith('### '))
  const body = (inherited === -1 ? section.lines : section.lines.slice(0, inherited)).filter((line) => line.trim())
  if (section.title === 'Constructor Summary' && body.length === 1 && body[0].trim() === NO_CONSTRUCTOR) return 0
  for (const line of section.lines) {
    if (line.startsWith('### ') && !INHERITED.test(line.slice(4).trim())) throw new PageShapeError(page, section.title, `unexpected heading "${line}"`)
  }
  if (!body.length) return 0
  if (!body.every((line) => line.startsWith('|'))) throw new PageShapeError(page, section.title, 'not a table')
  if (body.length < 2 || !/^\|[\s|-]+\|$/.test(body[1])) throw new PageShapeError(page, section.title, 'a table without its header')
  return body.length - 2
}

function parseSubclasses(page: string, section: Section): string[] {
  const text = section.lines.join(' ').trim()
  const ids: string[] = []
  for (const part of text.split(/,\s*/)) {
    const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part.trim())
    const id = match && idOfUrl(match[2])
    if (!match || !id || simpleName(id) !== unescape(match[1])) throw new PageShapeError(page, SUBCLASSES, `unexpected entry "${part}"`)
    ids.push(id)
  }
  return [...new Set(ids)].sort()
}

function clean<T extends object>(entry: T): T {
  for (const key of Object.keys(entry) as (keyof T)[]) if (entry[key] === undefined || entry[key] === false) delete entry[key]
  return entry
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * One class page as its entry in the index, its members sorted by their heading. Throws a
 * PageShapeError when the page does not have the expected shape.
 */
export function parseClassPage(page: string, markdown: string): DwClassData {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const { head, sections } = sectionsOf(page, lines)
  const { chain, deprecated } = parseHead(page, head)
  const section = (title: string) => sections.find((each) => each.title === title)
  for (const required of ['Constructor Summary', 'Method Summary']) {
    if (!section(required)) throw new PageShapeError(page, required, 'missing')
  }
  // Every anchor some link on the page points at: its own (`#x`) or the page's own `.md#x`.
  const linked = new Set<string>()
  for (const match of markdown.matchAll(/\]\(([^)\s]*)#([^)\s]+)\)/g)) {
    if (match[1] === '' || idOfUrl(`${match[1]}#${match[2]}`) === page) linked.add(match[2])
  }

  const entry: DwClassData = {}
  if (chain.length > 1) entry.super = chain[chain.length - 2]
  const subclasses = section(SUBCLASSES)
  if (subclasses) entry.subclasses = parseSubclasses(page, subclasses)
  if (deprecated) entry.deprecated = true

  const byHeading = (a: { heading: string }, b: { heading: string }) => compare(a.heading, b.heading)
  SUMMARIES.forEach((summaryTitle, at) => {
    const detailsTitle = DETAILS[at]
    const summary = section(summaryTitle)
    const details = section(detailsTitle)
    const rows = summary ? summaryRows(page, summary) : 0
    const members = details ? parseDetails(page, details, linked).sort(byHeading) : []
    if (rows !== members.length) throw new PageShapeError(page, detailsTitle, `${members.length} members for ${rows} rows of ${summaryTitle}`)
    if (!members.length) return
    if (detailsTitle === 'Constant Details') {
      entry.constants = members.map((m) => clean<DwConstantData>({ name: m.name, type: m.type as string, value: m.value, deprecated: m.deprecated || undefined }))
    } else if (detailsTitle === 'Property Details') {
      entry.properties = members.map((m) =>
        clean<DwPropertyData>({ name: m.name, type: m.type as string, static: m.static || undefined, readOnly: m.readOnly || undefined, deprecated: m.deprecated || undefined })
      )
    } else {
      const callables = members.map((m) => {
        const params = m.params as DwParam[]
        return clean<DwCallableData>({
          name: m.name,
          key: m.heading === callableKey({ name: m.name, params }) ? undefined : m.heading,
          params,
          returns: m.returns,
          static: m.static || undefined,
          deprecated: m.deprecated || undefined
        })
      })
      if (detailsTitle === 'Constructor Details') entry.constructors = callables
      else entry.methods = callables
    }
  })
  return entry
}

/** The documentation's version, from the title of its index entry (`B2C Commerce Script API 26.10`). */
export function versionOf(title: string): string {
  const match = /^B2C Commerce Script API (\d+(?:\.\d+)+)$/.exec(title.trim())
  if (!match) throw new PageShapeError('index', 'title', `unexpected title "${title}"`)
  return match[1]
}
