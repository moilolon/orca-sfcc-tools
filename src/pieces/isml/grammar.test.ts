// The ISML grammar, checked two ways. First its shape: every include resolves inside the grammar
// itself (it borrows no other language's scopes), every pattern compiles, and none uses syntax
// that only one of Oniguruma (what Orca's editor runs) and JavaScript accepts. Then what it does:
// a small TextMate tokenizer, written below for these tests, walks the grammar's own rules over
// the invented fixtures and each construct is checked for the scope a theme colours it by.
//
// Orca hands its editor only the deepest scope of each token, so most checks look at that one:
// it is what decides the colour.
import { assert, test } from 'orca/testing'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type Captures = Record<string, Rule>
type Rule = {
  name?: string
  contentName?: string
  match?: string
  begin?: string
  end?: string
  captures?: Captures
  beginCaptures?: Captures
  endCaptures?: Captures
  patterns?: Rule[]
  include?: string
}
type Grammar = { name: string; scopeName: string; patterns: Rule[]; repository: Record<string, Rule> }

const HERE = new URL('./', import.meta.url)
const ROOT = new URL('../../../', import.meta.url)
const readJson = (url: URL) => JSON.parse(readFileSync(url, 'utf8'))
const grammar: Grammar = readJson(new URL('isml.tmLanguage.json', HERE))

// ---------------------------------------------------------------------------------------------
// The tokenizer: TextMate's rules as vscode-textmate applies them. At each position the earliest
// match wins; on a tie the open rule's `end` wins, then the pattern listed first. A begin/end
// rule paints `name` over its whole span and `contentName` between its delimiters; captures paint
// their groups, and a capture with `patterns` is tokenized again on its own text.

type Frame = { rule: Rule | null; nameScopes: string[]; scopes: string[] }
type Document = { lines: string[]; scopes: string[][][]; depthAfter: number[] }

const compiled = new Map<string, RegExp>()
function search(source: string, text: string, from: number): RegExpExecArray | null {
  let re = compiled.get(source)
  if (!re) compiled.set(source, (re = new RegExp(source, 'dg')))
  re.lastIndex = from
  return re.exec(text)
}

const expanded = new Map<Rule[], Rule[]>()
/** The rules a list of patterns stands for, includes and plain containers followed. */
function expand(patterns: Rule[]): Rule[] {
  const known = expanded.get(patterns)
  if (known) return known
  const out: Rule[] = []
  const walk = (list: Rule[]) => {
    for (const pattern of list) {
      const rule = pattern.include === undefined ? pattern : resolve(pattern.include)
      if (rule.match !== undefined || rule.begin !== undefined) {
        if (!out.includes(rule)) out.push(rule)
      } else walk(rule.patterns ?? [])
    }
  }
  walk(patterns)
  expanded.set(patterns, out)
  return out
}

function resolve(include: string): Rule {
  if (include === '$self') return { patterns: grammar.patterns }
  const rule = include.startsWith('#') ? grammar.repository[include.slice(1)] : undefined
  if (!rule) throw new Error(`unresolved include ${include}`)
  return rule
}

function paint(scopes: string[][], text: string, match: RegExpExecArray, base: string[], captures?: Captures): void {
  for (let i = match.index; i < match.index + match[0].length; i++) scopes[i] = base
  if (!captures) return
  for (const key of Object.keys(captures).sort((a, b) => Number(a) - Number(b))) {
    const range = match.indices?.[Number(key)]
    if (!range || range[0] === range[1]) continue
    const capture = captures[key]
    const own = capture.name ? [...base, capture.name] : base
    for (let i = range[0]; i < range[1]; i++) scopes[i] = own
    if (capture.patterns) {
      const inner = tokenizeLine(text.slice(range[0], range[1]), [{ rule: { patterns: capture.patterns }, nameScopes: own, scopes: own }])
      inner.scopes.forEach((value, i) => (scopes[range[0] + i] = value))
    }
  }
}

function tokenizeLine(text: string, initial: Frame[]): { scopes: string[][]; stack: Frame[] } {
  const scopes: string[][] = new Array(text.length)
  const stack = [...initial]
  let pos = 0
  for (let steps = 0; pos <= text.length; steps++) {
    if (steps > 10 * (text.length + 10)) throw new Error(`no progress at ${pos} of ${JSON.stringify(text)}`)
    const frame = stack[stack.length - 1]
    let best: { match: RegExpExecArray; rule: Rule | null } | null = null
    if (frame.rule?.end !== undefined) {
      const match = search(frame.rule.end, text, pos)
      if (match) best = { match, rule: null }
    }
    for (const rule of expand(frame.rule ? (frame.rule.patterns ?? []) : grammar.patterns)) {
      const match = search((rule.match ?? rule.begin) as string, text, pos)
      if (match && (!best || match.index < best.match.index)) best = { match, rule }
    }
    if (!best) {
      for (let i = pos; i < text.length; i++) scopes[i] = frame.scopes
      break
    }
    const { match, rule } = best
    const end = match.index + match[0].length
    for (let i = pos; i < match.index; i++) scopes[i] = frame.scopes
    if (rule === null) {
      const closing = frame.rule as Rule
      paint(scopes, text, match, frame.nameScopes, closing.endCaptures ?? closing.captures)
      stack.pop()
      pos = end
    } else if (rule.match !== undefined) {
      paint(scopes, text, match, rule.name ? [...frame.scopes, rule.name] : frame.scopes, rule.captures)
      pos = end > match.index ? end : match.index + 1
    } else {
      const nameScopes = rule.name ? [...frame.scopes, rule.name] : frame.scopes
      paint(scopes, text, match, nameScopes, rule.beginCaptures ?? rule.captures)
      stack.push({ rule, nameScopes, scopes: rule.contentName ? [...nameScopes, rule.contentName] : nameScopes })
      pos = end
    }
  }
  return { scopes, stack }
}

function tokenize(source: string): Document {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let stack: Frame[] = [{ rule: null, nameScopes: [grammar.scopeName], scopes: [grammar.scopeName] }]
  const scopes: string[][][] = []
  const depthAfter: number[] = []
  for (const line of lines) {
    const result = tokenizeLine(line, stack)
    stack = result.stack
    scopes.push(result.scopes)
    depthAfter.push(stack.length - 1)
  }
  return { lines, scopes, depthAfter }
}

const fixture = (name: string) => tokenize(readFileSync(new URL(`fixtures/${name}`, HERE), 'utf8'))

/** Where `needle` stands on a line (1-based), its `nth` occurrence. */
function find(doc: Document, line: number, needle: string, nth = 1): { stacks: string[][]; where: string } {
  const text = doc.lines[line - 1]
  let start = -1
  for (let i = 0; i < nth; i++) start = text.indexOf(needle, start + 1)
  assert.ok(start >= 0, `line ${line} holds ${JSON.stringify(needle)} ${nth} time(s): ${JSON.stringify(text)}`)
  return { stacks: doc.scopes[line - 1].slice(start, start + needle.length), where: `${JSON.stringify(needle)} on line ${line}` }
}

/** Every character of `needle` has `scope` as its deepest scope: the one its colour comes from. */
function token(doc: Document, line: number, needle: string, scope: string, nth = 1): void {
  const { stacks, where } = find(doc, line, needle, nth)
  for (const stack of stacks) assert.equal(stack[stack.length - 1], scope, `${where}: ${stack.join(' ')}`)
}

/** Every character of `needle` lies inside `scope`, at any depth. */
function inside(doc: Document, line: number, needle: string, scope: string, nth = 1): void {
  const { stacks, where } = find(doc, line, needle, nth)
  for (const stack of stacks) assert.ok(stack.includes(scope), `${where} is inside ${scope}: ${stack.join(' ')}`)
}

/** No character of `needle` lies inside `scope`. */
function outside(doc: Document, line: number, needle: string, scope: string, nth = 1): void {
  const { stacks, where } = find(doc, line, needle, nth)
  for (const stack of stacks) assert.ok(!stack.includes(scope), `${where} is outside ${scope}: ${stack.join(' ')}`)
}

// ---------------------------------------------------------------------------------------------
// The grammar's shape

/** Every rule object of the grammar, captures included, with where it sits. */
function allRules(): { rule: Rule; at: string }[] {
  const out: { rule: Rule; at: string }[] = []
  const visit = (rule: Rule, at: string) => {
    out.push({ rule, at })
    rule.patterns?.forEach((child, i) => visit(child, `${at}.patterns[${i}]`))
    for (const kind of ['captures', 'beginCaptures', 'endCaptures'] as const) {
      for (const [key, capture] of Object.entries(rule[kind] ?? {})) visit(capture, `${at}.${kind}[${key}]`)
    }
  }
  grammar.patterns.forEach((rule, i) => visit(rule, `patterns[${i}]`))
  for (const [key, rule] of Object.entries(grammar.repository)) visit(rule, `repository.${key}`)
  return out
}

/** The bodies of the lookbehinds of a pattern, nested groups included. */
function lookbehinds(source: string): string[] {
  const bodies: string[] = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') {
      i++
      continue
    }
    if (!source.startsWith('(?<=', i) && !source.startsWith('(?<!', i)) continue
    let depth = 0
    for (let j = i; j < source.length; j++) {
      if (source[j] === '\\') j++
      else if (source[j] === '(') depth++
      else if (source[j] === ')' && --depth === 0) {
        bodies.push(source.slice(i + 4, j))
        break
      }
    }
  }
  return bodies
}

/** Syntax one of the two engines lacks or reads differently. */
const ONE_ENGINE_ONLY: [RegExp, string][] = [
  [/\\[AGZzhHKRX]/, 'an Oniguruma-only escape'],
  [/\\[pP]\{/, 'a Unicode property'],
  [/\(\?[imx-]+[:)]/, 'an inline flag'],
  [/\(\?>|\(\?~/, 'an atomic or absent group'],
  [/[*+?}]\+/, 'a possessive quantifier'],
  [/\\[kg]</, 'a named reference or call'],
  [/\\[1-9]/, 'a back-reference']
]

test('the grammar is self-contained: every include is a rule of its own repository', () => {
  assert.equal(grammar.scopeName, 'text.html.isml')
  const reached = new Set<string>()
  for (const { rule, at } of allRules()) {
    if (rule.include === undefined) continue
    assert.match(rule.include, /^#/, `${at} includes ${rule.include}, which is not a rule of this grammar`)
    const key = rule.include.slice(1)
    assert.ok(key in grammar.repository, `${at} includes ${rule.include}, which the repository lacks`)
    reached.add(key)
  }
  assert.deepEqual(Object.keys(grammar.repository).filter((key) => !reached.has(key)), [], 'repository rules nothing includes')
})

test('every match, begin and end compiles, in syntax both Oniguruma and JavaScript read alike', () => {
  let count = 0
  for (const { rule, at } of allRules()) {
    for (const field of ['match', 'begin', 'end'] as const) {
      const source = rule[field]
      if (source === undefined) continue
      count++
      try {
        new RegExp(source, 'd')
      } catch (error) {
        assert.fail(`${at}.${field} does not compile: ${(error as Error).message}`)
      }
      for (const [shape, what] of ONE_ENGINE_ONLY) assert.ok(!shape.test(source), `${at}.${field} uses ${what}: ${source}`)
      for (const body of lookbehinds(source)) assert.ok(!/[*+]|\{\d*,\}/.test(body), `${at}.${field} has a lookbehind of unbounded length: ${source}`)
    }
    if (rule.begin !== undefined) assert.ok(rule.end !== undefined, `${at} has a begin and no end`)
    if (rule.begin !== undefined) assert.equal(new RegExp(rule.begin).test(''), false, `${at}.begin matches nothing`)
  }
  assert.ok(count > 50, `${count} patterns`)
})

test('the manifest declares the language, its grammar and its configuration', () => {
  const { contributes } = readJson(new URL('manifest.json', HERE))
  assert.deepEqual(contributes.syntaxes, [
    {
      id: 'isml',
      title: 'ISML',
      scopeName: 'text.html.isml',
      path: 'src/pieces/isml/isml.tmLanguage.json',
      configuration: 'src/pieces/isml/language-configuration.json',
      extensions: ['.isml']
    }
  ])
  const [syntax] = contributes.syntaxes
  assert.ok(existsSync(fileURLToPath(new URL(syntax.path, ROOT))), syntax.path)
  const configuration = readJson(new URL(syntax.configuration, ROOT))
  assert.deepEqual(configuration.comments, { blockComment: ['<iscomment>', '</iscomment>'] })
  for (const key of ['brackets', 'autoClosingPairs', 'surroundingPairs']) assert.ok(configuration[key].length > 0, key)
  const plugin = readJson(new URL('orca-plugin.json', ROOT))
  assert.deepEqual(plugin.contributes.syntaxes, contributes.syntaxes, 'orca-plugin.json was merged again')
})

test('the tokenizer follows TextMate: the end of the open rule wins a tie, and a capture is tokenized again', () => {
  // Checked on the grammar itself: `}` both ends an expression and could open nothing else.
  const doc = tokenize('<a href="${x}">')
  token(doc, 1, '}', 'punctuation.section.embedded.end.isml')
  token(doc, 1, '>', 'punctuation.definition.tag.end.html')
  assert.equal(doc.depthAfter[0], 0)
  // The attributes of <script> are a capture with patterns of its own.
  token(tokenize('<script type="module"></script>'), 1, 'type', 'entity.other.attribute-name.html')
})

// ---------------------------------------------------------------------------------------------
// What each construct gets, on src/pieces/isml/fixtures/showcase.isml

const showcase = fixture('showcase.isml')

test('the showcase ends at the top level, and every block closes on its own line', () => {
  const open = showcase.depthAfter.map((depth, i) => (depth === 0 ? null : i + 1)).filter((line) => line !== null)
  // Inside <iscomment> (lines 4 to 6), <isscript> (10 to 15), <script> (38 to 40), <style> (42, 43).
  assert.deepEqual(open, [4, 5, 6, 10, 11, 12, 13, 14, 15, 38, 39, 40, 42, 43])
})

test('HTML: tags, attribute names, quoted and unquoted values, entities, the doctype and comments', () => {
  token(showcase, 18, 'div', 'entity.name.tag.html')
  token(showcase, 18, '<', 'punctuation.definition.tag.begin.html')
  token(showcase, 18, 'class', 'entity.other.attribute-name.html')
  token(showcase, 18, '=', 'punctuation.separator.key-value.html')
  token(showcase, 18, '"product-tile ', 'string.quoted.double.html')
  token(showcase, 19, "'", 'string.quoted.single.html')
  token(showcase, 47, '"after"', 'string.quoted.double.html')
  token(showcase, 23, '&amp;', 'constant.character.entity.html')
  token(showcase, 37, '</', 'punctuation.definition.tag.begin.html')
  token(showcase, 2, 'DOCTYPE', 'entity.name.tag.doctype.html')
  token(showcase, 17, '<!--', 'comment.block.html')
  token(showcase, 17, '-->', 'comment.block.html')
  const unquoted = tokenize('<input type=checkbox checked>')
  token(unquoted, 1, 'checkbox', 'string.unquoted.html')
  token(unquoted, 1, 'checked', 'entity.other.attribute-name.html')
})

test('ISML tags are scoped apart from HTML tags, with their attributes', () => {
  for (const [line, name] of [
    [1, 'iscontent'],
    [3, 'ismodule'],
    [8, 'isdecorate'],
    [9, 'isset'],
    [20, 'isif'],
    [22, 'iselseif'],
    [24, 'iselse'],
    [25, 'isprint'],
    [28, 'isloop'],
    [29, 'iscontinue'],
    [34, 'isinclude'],
    [36, 'isslot'],
    [48, 'isdecorate']
  ] as const) {
    token(showcase, line, name, 'entity.name.tag.isml')
    inside(showcase, line, name, 'meta.tag.isml')
  }
  token(showcase, 20, '<', 'punctuation.definition.tag.begin.isml')
  token(showcase, 26, '</', 'punctuation.definition.tag.begin.isml')
  token(showcase, 25, '/>', 'punctuation.definition.tag.end.isml')
  token(showcase, 20, 'condition', 'entity.other.attribute-name.isml')
  token(showcase, 9, '=', 'punctuation.separator.key-value.isml')
  token(showcase, 9, '"product"', 'string.quoted.double.isml')
  token(showcase, 25, '"on"', 'string.quoted.double.isml')
  // A tag declared with <ismodule> (line 3) is an ISML tag too, scoped as a custom one.
  token(showcase, 35, 'isbadge', 'entity.name.tag.custom.isml')
  token(showcase, 35, 'label', 'entity.other.attribute-name.isml')
  // ISML tags inside an HTML tag and inside its quoted value.
  token(showcase, 30, 'isif', 'entity.name.tag.isml')
  token(showcase, 30, 'isif', 'entity.name.tag.isml', 2)
  token(showcase, 30, 'selected', 'string.quoted.double.html', 2)
  token(showcase, 30, 'li', 'entity.name.tag.html', 2)
  // Every built-in tag the plan names, alone.
  for (const name of ['isif', 'iselseif', 'iselse', 'isloop', 'isinclude', 'isset', 'isprint', 'isdecorate', 'isreplace', 'ismodule', 'iscontent', 'iscache', 'isredirect', 'isslot', 'isobject', 'isactivedatahead', 'isbreak', 'iscontinue', 'isnext', 'isstatus']) {
    const doc = tokenize(`<${name} qq="b"/></${name}>`)
    token(doc, 1, name, 'entity.name.tag.isml')
    token(doc, 1, name, 'entity.name.tag.isml', 2)
    token(doc, 1, 'qq', 'entity.other.attribute-name.isml')
  }
})

test('an expression in text and in attribute values, of HTML and ISML tags', () => {
  // In text.
  token(showcase, 19, '${', 'punctuation.section.embedded.begin.isml', 2)
  token(showcase, 19, 'name', 'variable.other.property.js')
  token(showcase, 19, '}', 'punctuation.section.embedded.end.isml', 2)
  inside(showcase, 19, '${product.name}', 'meta.embedded.expression.isml')
  // In a double-quoted HTML value, beside plain text.
  inside(showcase, 18, "${product.available ? 'in-stock' : 'sold-out'}", 'meta.embedded.expression.isml')
  token(showcase, 18, "'in-stock'", 'string.quoted.single.js')
  outside(showcase, 18, 'product-tile', 'meta.embedded.expression.isml')
  // In a single-quoted HTML value, with double-quoted strings inside.
  token(showcase, 19, '"label.title"', 'string.quoted.double.js')
  // In ISML attributes.
  inside(showcase, 9, '${pdict.product}', 'meta.embedded.expression.isml')
  inside(showcase, 20, '${!empty(product.images) && product.images.length > 0}', 'meta.embedded.expression.isml')
  inside(showcase, 34, '${URLUtils.url("Product-Show", "pid", product.ID)}', 'meta.embedded.expression.isml')
})

test('JavaScript in an expression: keywords, constants, operators, calls, properties and support names', () => {
  token(showcase, 9, 'pdict', 'support.variable.isml')
  token(showcase, 22, 'session', 'support.variable.isml')
  token(showcase, 19, 'Resource', 'support.class.isml')
  token(showcase, 34, 'URLUtils', 'support.class.isml')
  token(showcase, 20, 'empty', 'support.function.isml')
  token(showcase, 19, 'msg', 'entity.name.function.js')
  token(showcase, 19, '.', 'punctuation.accessor.js')
  token(showcase, 20, 'length', 'variable.other.property.js')
  token(showcase, 19, 'null', 'constant.language.js')
  token(showcase, 20, '!', 'keyword.operator.js')
  token(showcase, 20, '&&', 'keyword.operator.js')
  token(showcase, 20, '>', 'keyword.operator.js')
  token(showcase, 30, '==', 'keyword.operator.js')
  token(showcase, 18, '?', 'keyword.operator.js')
  token(showcase, 20, '0', 'constant.numeric.js')
  token(showcase, 18, 'product', 'variable.other.readwrite.js', 2)
  const doc = tokenize('${typeof x === "number" ? new Date().getTime() : true}')
  token(doc, 1, 'typeof', 'keyword.operator.expression.js')
  token(doc, 1, 'new', 'keyword.operator.expression.js')
  token(doc, 1, 'Date', 'support.class.builtin.js')
  token(doc, 1, 'getTime', 'entity.name.function.js')
  token(doc, 1, 'true', 'constant.language.js')
})

test('an expression keeps a } that sits in a string or closes nested braces, and a string its escaped quote', () => {
  token(showcase, 33, "'A } in a string, and an escaped ", 'string.quoted.single.js')
  token(showcase, 33, "\\'", 'constant.character.escape.js')
  token(showcase, 33, " quote'", 'string.quoted.single.js')
  token(showcase, 33, '}', 'punctuation.section.embedded.end.isml', 2)
  // `{count: 1}` closes its own brace; the expression ends at the next `}`.
  inside(showcase, 33, '{count: 1}.count }', 'meta.embedded.expression.isml')
  token(showcase, 33, 'count', 'variable.other.property.js', 2)
  token(showcase, 33, '}', 'punctuation.section.embedded.end.isml', 4)
  outside(showcase, 33, '</p>', 'meta.embedded.expression.isml')
  // In <isscript>: an escaped quote, and the other quote kind, inside a string.
  token(showcase, 15, "'it", 'string.quoted.single.js')
  token(showcase, 15, "\\'", 'constant.character.escape.js')
  token(showcase, 15, 's "quoted"\'', 'string.quoted.single.js')
  // A double-quoted string inside an expression inside a double-quoted value.
  token(showcase, 34, '"Product-Show"', 'string.quoted.double.js')
  token(showcase, 34, '}', 'punctuation.section.embedded.end.isml')
  token(showcase, 34, '"', 'string.quoted.double.isml', 6)
})

test('<isscript> is JavaScript', () => {
  token(showcase, 10, 'isscript', 'entity.name.tag.isml')
  token(showcase, 16, 'isscript', 'entity.name.tag.isml')
  inside(showcase, 11, 'var Site', 'source.js.embedded.isml')
  token(showcase, 11, 'var', 'storage.type.js')
  token(showcase, 11, 'require', 'support.function.require.js')
  token(showcase, 11, "'dw/system/Site'", 'string.quoted.single.js')
  token(showcase, 12, 'dw.util.StringUtils', 'support.class.dw.js')
  token(showcase, 12, 'formatNumber', 'entity.name.function.js')
  token(showcase, 12, '42.5', 'constant.numeric.js')
  token(showcase, 12, '// a line comment', 'comment.line.double-slash.js')
  token(showcase, 13, '/* a block comment */', 'comment.block.js')
  token(showcase, 14, '`Total: ', 'string.template.js')
  token(showcase, 14, '${', 'punctuation.definition.template-expression.begin.js')
  token(showcase, 14, 'price', 'variable.other.readwrite.js')
  token(showcase, 14, '\\u20AC', 'constant.character.escape.js')
  // Server code: ISML does not fill ${…} in an <isscript> string.
  const doc = tokenize("<isscript>\nvar a = '${x}';\nif (a) { return null; }\n</isscript>\n<p>")
  token(doc, 2, "'${x}'", 'string.quoted.single.js')
  token(doc, 3, 'if', 'keyword.control.js')
  token(doc, 3, 'return', 'keyword.control.js')
  token(doc, 5, 'p', 'entity.name.tag.html')
})

test('both kinds of comment, whatever they hold', () => {
  for (const [line, text] of [
    [4, '<iscomment>'],
    [5, 'An invented page'],
    [6, '<isif condition="${notCode}">Still a comment</isif>'],
    [7, '</iscomment>']
  ] as const) {
    token(showcase, line, text, 'comment.block.isml')
  }
  // ISML runs inside an HTML comment: only the rest of it is comment.
  token(showcase, 17, '<!-- ISML still runs in an HTML comment: ', 'comment.block.html')
  token(showcase, 17, '${', 'punctuation.section.embedded.begin.isml')
  token(showcase, 17, 'isprint', 'entity.name.tag.isml')
  token(showcase, 17, ' -->', 'comment.block.html')
  token(showcase, 8, 'isdecorate', 'entity.name.tag.isml')
})

test('<script> and <style> hold raw text: client code where ISML fills ${…}, and CSS', () => {
  token(showcase, 38, 'script', 'entity.name.tag.html')
  inside(showcase, 39, 'var config', 'source.js.embedded.html')
  token(showcase, 39, 'var', 'storage.type.js')
  token(showcase, 39, '${', 'punctuation.section.embedded.begin.isml')
  token(showcase, 39, '"Cart-Show"', 'string.quoted.double.js')
  inside(showcase, 39, "'${URLUtils.url(\"Cart-Show\")}'", 'string.quoted.single.js')
  token(showcase, 39, 'pdict', 'support.variable.isml')
  token(showcase, 40, 'if', 'keyword.control.js')
  token(showcase, 40, '>', 'keyword.operator.js')
  token(showcase, 40, 'alert', 'entity.name.function.js')
  token(showcase, 41, 'script', 'entity.name.tag.html')
  token(showcase, 42, 'style', 'entity.name.tag.html')
  outside(showcase, 43, '.product-tile {', 'meta.tag.html')
  token(showcase, 43, '/* a style comment */', 'comment.block.css')
  token(showcase, 44, 'style', 'entity.name.tag.html')
})

test('an unclosed ${ stops at the end of the line, the closing quote or the closing tag', () => {
  // On the showcase: at the closing tag in text, at the closing quote in a value.
  token(showcase, 45, '</', 'punctuation.definition.tag.begin.html')
  outside(showcase, 45, '</p>', 'meta.embedded.expression.isml')
  token(showcase, 46, '"', 'string.quoted.double.html', 2)
  token(showcase, 46, '>', 'punctuation.definition.tag.end.html')
  outside(showcase, 46, 'and in a value', 'meta.embedded.expression.isml')
  token(showcase, 47, 'class', 'entity.other.attribute-name.html')
  // On src/pieces/isml/fixtures/unclosed.isml, each case followed by a line of plain HTML.
  const doc = fixture('unclosed.isml')
  assert.deepEqual(doc.depthAfter, doc.lines.map(() => 0), 'every line ends at the top level')
  inside(doc, 1, '${pdict.product.name', 'meta.embedded.expression.isml')
  token(doc, 2, 'p', 'entity.name.tag.html')
  token(doc, 2, 'class', 'entity.other.attribute-name.html')
  // A string left open inside the expression stops at the quote that closes the value.
  token(doc, 3, "'a string left open}", 'string.quoted.single.js')
  token(doc, 3, '>', 'punctuation.definition.tag.end.html')
  token(doc, 3, 'Text', 'text.html.isml')
  token(doc, 4, 'span', 'entity.name.tag.html')
  // In an ISML attribute.
  token(doc, 5, '"', 'string.quoted.double.isml', 2)
  token(doc, 5, 'One', 'text.html.isml')
  token(doc, 6, 'p', 'entity.name.tag.html')
  // Nested braces left open stop at the quote too.
  token(doc, 7, "'", 'string.quoted.single.html', 2)
  token(doc, 7, 'Text', 'text.html.isml')
  token(doc, 8, 'p', 'entity.name.tag.html')
})

// ---------------------------------------------------------------------------------------------
// The review's samples, on src/pieces/isml/fixtures/edges.isml

const edges = fixture('edges.isml')

test('the edge cases end at the top level, and only their blocks stay open', () => {
  // <isscript with its > on the next line (10 and 11), its body (12), <iscomment split (14),
  // the second <isscript> (17 to 21).
  assert.deepEqual(edges.depthAfter, [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0])
})

test('ISML inside an HTML comment is ISML; the rest of the comment stays comment', () => {
  token(edges, 1, '<!-- ', 'comment.block.html')
  token(edges, 1, '${', 'punctuation.section.embedded.begin.isml')
  token(edges, 1, 'pdict', 'support.variable.isml')
  token(edges, 1, ' and ', 'comment.block.html')
  token(edges, 1, 'isinclude', 'entity.name.tag.isml')
  token(edges, 1, 'template', 'entity.other.attribute-name.isml')
  token(edges, 1, ' stay ISML -->', 'comment.block.html')
  inside(edges, 1, 'isinclude', 'comment.block.html')
  token(edges, 2, 'p', 'entity.name.tag.html')
})

test('inside a quoted value, an expression closed on its line keeps its own strings of either quote', () => {
  // <isif condition="${pdict.type == "a"}">: the value goes on after the expression.
  token(edges, 3, '"a"', 'string.quoted.double.js')
  token(edges, 3, '}', 'punctuation.section.embedded.end.isml')
  token(edges, 3, '"', 'string.quoted.double.isml', 4)
  token(edges, 3, '>', 'punctuation.definition.tag.end.isml')
  token(edges, 3, 'A', 'text.html.isml')
  for (const text of ['"Page-Include"', '"cid"', '"x"']) token(edges, 4, text, 'string.quoted.double.js')
  token(edges, 4, '/>', 'punctuation.definition.tag.end.isml')
  // The same with single quotes inside a single-quoted value.
  token(edges, 7, "'k'", 'string.quoted.single.js')
  token(edges, 7, "'", 'string.quoted.single.html', 6)
  token(edges, 7, 'z', 'text.html.isml')
  // One left open still stops at the quote of its value, even with a closed one after it.
  token(edges, 5, '"', 'string.quoted.double.html', 2)
  token(edges, 5, 'open', 'text.html.isml')
  token(edges, 6, '"', 'string.quoted.double.html', 2)
  token(edges, 6, 'x', 'text.html.isml')
  token(edges, 6, 'b', 'variable.other.readwrite.js', 2)
  token(edges, 6, 'y', 'text.html.isml')
})

test('HTML raw-text tags in any letter case', () => {
  token(edges, 8, 'Script', 'entity.name.tag.html')
  token(edges, 8, 'var', 'storage.type.js')
  token(edges, 8, '"<p>"', 'string.quoted.double.js')
  token(edges, 8, 'Script', 'entity.name.tag.html', 2)
  token(edges, 9, 'STYLE', 'entity.name.tag.html')
  token(edges, 9, 'p { color: red; }', 'source.css.embedded.html')
  token(edges, 9, 'STYLE', 'entity.name.tag.html', 2)
})

test('<isscript and <iscomment open their block when the rest of the tag is on the next line', () => {
  token(edges, 10, 'isscript', 'entity.name.tag.isml')
  token(edges, 11, 'type', 'entity.other.attribute-name.isml')
  token(edges, 11, '>', 'punctuation.definition.tag.end.isml')
  token(edges, 12, 'var', 'storage.type.js')
  inside(edges, 12, 'a = 1', 'source.js.embedded.isml')
  token(edges, 13, 'isscript', 'entity.name.tag.isml')
  token(edges, 14, '<iscomment', 'comment.block.isml')
  token(edges, 15, '>hidden <p>x</p></iscomment>', 'comment.block.isml')
})

test('template strings inside an expression', () => {
  token(edges, 16, '`a}b`', 'string.template.js')
  token(edges, 16, '}', 'punctuation.section.embedded.end.isml', 2)
  token(edges, 16, ' and ', 'text.html.isml')
  token(edges, 16, '`x ', 'string.template.js')
  token(edges, 16, '${', 'punctuation.definition.template-expression.begin.js', 3)
  token(edges, 16, 'pdict', 'support.variable.isml')
  token(edges, 16, ' z`', 'string.template.js')
  token(edges, 16, '}', 'punctuation.section.embedded.end.isml', 4)
})

test('regular-expression literals in <isscript> where a / cannot be division', () => {
  token(edges, 18, "/'/g", 'string.regexp.js')
  token(edges, 18, "''", 'string.quoted.single.js')
  token(edges, 19, '/^https?:\\/\\//', 'string.regexp.js')
  token(edges, 19, 'test', 'entity.name.function.js')
  token(edges, 19, 'var', 'storage.type.js')
  token(edges, 21, 'return', 'keyword.control.js')
  token(edges, 21, '/x[/]y/i', 'string.regexp.js')
  // Division stays an operator.
  token(edges, 20, '/', 'keyword.operator.js')
  token(edges, 20, '/', 'keyword.operator.js', 2)
  token(edges, 20, 'c', 'variable.other.readwrite.js')
  token(edges, 23, 'p', 'entity.name.tag.html')
})
