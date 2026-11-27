// The ISML parser: every node kind of a template with its positions (elements, ISML tags, custom
// tags, attributes, text, `${…}` in text, values and tags, both comment kinds, `<isscript>`,
// raw-text elements, the doctype), where `${…}` ends as the ISML grammar has it, and broken
// templates: each problem at its place, and nothing unclosed takes the rest of the file.
import { assert, test } from 'orca/testing'
import { fixture, offsetOf, rangeOf } from '../fixtures/read'
import { attribute, attributeText, parseTemplate, walkTemplate, type Element, type IsmlDocument, type IsmlExpression, type IsmlNode } from './parser'

const range = (node: { start: number; end: number }) => ({ start: node.start, end: node.end })

function all(document: IsmlDocument): IsmlNode[] {
  const out: IsmlNode[] = []
  walkTemplate(document, (node) => out.push(node))
  return out
}

const elements = (document: IsmlDocument, name: string) => all(document).filter((n): n is Element => n.type === 'Element' && n.name === name)
const element = (document: IsmlDocument, name: string, nth = 0) => {
  const found = elements(document, name)[nth]
  if (!found) throw new Error(`no <${name}> #${nth}`)
  return found
}

test('a template with every construct parses with no problem', () => {
  const { problems } = parseTemplate(fixture('template.isml'))
  assert.deepEqual(problems, [])
})

test('the top level: doctype, empty ISML tags, the module declaration and the decorator around the page', () => {
  const text = fixture('template.isml')
  const { document } = parseTemplate(text)
  assert.deepEqual(range(document), { start: 0, end: text.length })
  const top = document.children.filter((n) => n.type !== 'Text')
  assert.deepEqual(top.map((n) => (n.type === 'Element' ? n.name : n.type)), ['Doctype', 'iscontent', 'ismodule', 'isdecorate'])
  assert.deepEqual(range(top[0]), rangeOf(text, '<!DOCTYPE html>'))
  const content = top[1] as Element
  assert.deepEqual([content.isml, content.custom, content.selfClosing, content.close], [true, false, true, null])
  assert.deepEqual(range(content), rangeOf(text, '<iscontent type="text/html" charset="UTF-8" compact="true"/>'))
  assert.deepEqual({ start: content.nameStart, end: content.nameEnd }, rangeOf(text, 'iscontent'))
  assert.deepEqual(document.modules, [
    { name: 'price', template: 'components/price', attributes: ['value', 'currency'], ...rangeOf(text, '<ismodule template="components/price" name="price" attribute="value" attribute="currency"/>') }
  ])
  const decorate = top[3] as Element
  assert.deepEqual(decorate.close, rangeOf(text, '</isdecorate>'))
  assert.deepEqual(range(decorate), { start: offsetOf(text, '<isdecorate'), end: offsetOf(text, '</isdecorate>') + '</isdecorate>'.length })
  assert.equal(decorate.openEnd, offsetOf(text, '<isdecorate template="common/layout/page">') + '<isdecorate template="common/layout/page">'.length)
})

test('attributes: names, values, quotes and the `${…}` inside them, each with its range', () => {
  const text = fixture('template.isml')
  const { document } = parseTemplate(text)
  const div = element(document, 'div')
  assert.deepEqual(div.attributes.map((a) => a.name), ['class', 'data-pid'])
  const cls = div.attributes[0]
  assert.deepEqual({ start: cls.nameStart, end: cls.nameEnd }, rangeOf(text, 'class', 0))
  assert.equal(cls.value?.quote, '"')
  const valueText = "product-detail ${pdict.product.online ? 'online' : 'offline'}"
  assert.deepEqual({ start: cls.value?.contentStart, end: cls.value?.contentEnd }, rangeOf(text, valueText))
  assert.deepEqual(range(cls.value as { start: number; end: number }), rangeOf(text, `"${valueText}"`))
  assert.deepEqual(range(cls), rangeOf(text, `class="${valueText}"`))
  assert.deepEqual(cls.value?.parts.map((p) => [p.type, text.slice(p.start, p.end)]), [
    ['Text', 'product-detail '],
    ['Expression', "${pdict.product.online ? 'online' : 'offline'}"]
  ])
  const expression = cls.value?.parts[1] as IsmlExpression
  assert.deepEqual({ start: expression.codeStart, end: expression.codeEnd }, rangeOf(text, "pdict.product.online ? 'online' : 'offline'"))
  assert.equal(expression.closed, true)
  assert.equal(attributeText(text, element(document, 'isset'), 'name'), 'showPrice')
  assert.equal(attributeText(text, element(document, 'isset'), 'value'), null, 'a value holding ${…} is not plain text')
  assert.equal(attribute(element(document, 'isset'), 'scope')?.value?.quote, '"')
})

test('ISML tags: conditions with their branches, loops, custom tags, an empty tag closed by an end tag', () => {
  const text = fixture('template.isml')
  const { document } = parseTemplate(text)
  const isif = element(document, 'isif')
  assert.deepEqual(isif.close, rangeOf(text, '</isif>', 0))
  const branches = isif.children.filter((n): n is Element => n.type === 'Element')
  assert.deepEqual(branches.map((b) => b.name), ['isprice', 'iselseif', 'span', 'iselse', 'span'])
  const price = branches[0]
  assert.deepEqual([price.custom, price.isml, price.selfClosing], [true, true, true])
  assert.deepEqual(range(price), rangeOf(text, `<isprice value="\${pdict.product.price}" currency="\${'EUR'}"/>`))
  const loop = element(document, 'isloop')
  assert.deepEqual(range(loop), { start: offsetOf(text, '<isloop'), end: offsetOf(text, '</isloop>') + '</isloop>'.length })
  assert.deepEqual(loop.children.filter((n) => n.type === 'Element').map((n) => (n as Element).name), ['li'])
  const print = element(document, 'isprint')
  assert.deepEqual(print.close, rangeOf(text, '</isprint>'))
  assert.equal(print.end, print.close?.end)
})

test('ISML tags and `${…}` among a tag’s attributes, and HTML around them', () => {
  const text = fixture('template.isml')
  const { document } = parseTemplate(text)
  const list = element(document, 'ul')
  assert.deepEqual(list.inTag.map((n) => [n.type, n.type === 'Element' || n.type === 'CloseTag' ? n.name : '']), [
    ['Element', 'isif'],
    ['CloseTag', 'isif']
  ])
  assert.deepEqual(range(list.inTag[0]), rangeOf(text, '<isif condition="${pdict.product.variants}">'))
  assert.deepEqual(list.attributes.map((a) => a.name), ['class', 'data-variants'])
  assert.equal(list.openEnd, offsetOf(text, '</isif>>') + '</isif>>'.length)
  const img = element(document, 'img')
  assert.deepEqual([img.selfClosing, img.close, range(img)], [false, null, rangeOf(text, `<img src="\${URLUtils.staticURL('/images/logo.png')}" alt="logo">`)])
  assert.deepEqual(element(document, 'br').selfClosing, true)
  const h1 = element(document, 'h1')
  const inner = h1.children[0] as IsmlExpression
  assert.deepEqual([inner.type, range(inner)], ['Expression', rangeOf(text, '${pdict.product.productName}')])
})

test('expressions in text: nested braces and strings that hold a brace', () => {
  const text = fixture('template.isml')
  const { document } = parseTemplate(text)
  const expressions = all(document).filter((n): n is IsmlExpression => n.type === 'Expression')
  const nested = expressions.find((e) => text.slice(e.start, e.end).startsWith('${Resource.msgf')) as IsmlExpression
  assert.deepEqual(range(nested), rangeOf(text, "${Resource.msgf('label.none', 'product', null, {a: {b: '}'}})}"))
  assert.equal(nested.closed, true)
  assert.ok(expressions.length >= 18)
})

test('comments: ISML runs inside <!-- -->, nothing runs inside <iscomment>', () => {
  const text = fixture('template.isml')
  const { document } = parseTemplate(text)
  const html = all(document).find((n) => n.type === 'Comment')
  assert.ok(html && html.type === 'Comment')
  assert.deepEqual(range(html), rangeOf(text, '<!-- ISML still runs in a comment: ${pdict.product.id} -->'))
  assert.deepEqual(html.children.map((n) => [n.type, text.slice(n.start, n.end)]), [
    ['Text', ' ISML still runs in a comment: '],
    ['Expression', '${pdict.product.id}'],
    ['Text', ' ']
  ])
  const iscomment = all(document).find((n) => n.type === 'IsComment')
  assert.ok(iscomment && iscomment.type === 'IsComment')
  assert.deepEqual(range(iscomment), rangeOf(text, '<iscomment>An invented product page: <isif> and ${here} are not parsed.</iscomment>'))
  assert.deepEqual({ start: iscomment.contentStart, end: iscomment.contentEnd }, rangeOf(text, 'An invented product page: <isif> and ${here} are not parsed.'))
  assert.ok(!all(document).some((n) => n.type === 'Expression' && text.slice(n.start, n.end) === '${here}'))
})

test('<isscript> and the raw text of <script>, where only ISML is parsed', () => {
  const text = fixture('template.isml')
  const { document } = parseTemplate(text)
  const script = all(document).find((n) => n.type === 'IsScript')
  assert.ok(script && script.type === 'IsScript')
  const code = "\n    var URLUtils = require('dw/web/URLUtils');\n    var assets = require('*/cartridge/scripts/assets');\n    assets.addJs('/js/productDetail.js');\n"
  assert.deepEqual({ start: script.codeStart, end: script.codeEnd }, rangeOf(text, code))
  assert.deepEqual(script.close, rangeOf(text, '</isscript>'))
  assert.deepEqual(range(script), { start: offsetOf(text, '<isscript>'), end: offsetOf(text, '</isscript>') + '</isscript>'.length })
  const client = element(document, 'script')
  assert.deepEqual(client.close, rangeOf(text, '</script>'))
  assert.deepEqual(client.children.map((n) => n.type), ['Text', 'Expression', 'Text'], 'a `<div>` in a script string is text')
  assert.deepEqual(range(client.children[1]), rangeOf(text, '${pdict.product.id}', 2))
})

test('where an expression ends, as in the ISML grammar', () => {
  const cases: [string, string, boolean][] = [
    // text, the expression as parsed, closed
    ['<p>${a + b}</p>', '${a + b}', true],
    // A closed expression may span lines; an unclosed one ends with its first line.
    ['<p>${a\n}</p>', '${a\n}', true],
    ['<span class="price">${pdict.total\n    + pdict.tax}</span>', '${pdict.total\n    + pdict.tax}', true],
    ['<p>${a\r\n    + b}</p>', '${a\r\n    + b}', true],
    ['<p>${a\n<b>x</b>', '${a', false],
    ['<p>${a\nb\nc</p>', '${a', false],
    ['<p>${a</p>', '${a', false],
    // A regex literal's quotes are not strings.
    ['<p>${s.replace(/\'/g, "")}</p><b>${t}</b>', '${s.replace(/\'/g, "")}', true],
    ['<p>${a / b / c}</p>', '${a / b / c}', true],
    ['<!-- ${a --> after', '${a ', false],
    ['<p>${ "}" + \'{\' + `x${y}z` }</p>', '${ "}" + \'{\' + `x${y}z` }', true],
    ['<p>${ /* } */ a }</p>', '${ /* } */ a }', true],
    ['<a href="${URLUtils.url("Home-Show")}">', '${URLUtils.url("Home-Show")}', true],
    ['<a href="${pdict.open">x</a>', '${pdict.open', false],
    ["<a href='${a ? \"x\" : 'y'}'>", "${a ? \"x\" : 'y'}", true],
    ['<a href=${a}>', '${a}', true]
  ]
  for (const [text, expected, closed] of cases) {
    const { document, problems } = parseTemplate(text)
    const expression = all(document).find((n): n is IsmlExpression => n.type === 'Expression')
    assert.ok(expression, text)
    assert.equal(text.slice(expression.start, expression.end), expected, text)
    assert.equal(expression.closed, closed, text)
    assert.equal(problems.some((p) => p.code === 'unclosed_expression'), !closed, text)
  }
})

test('a broken template: each problem at its place, and nothing unclosed takes the rest', () => {
  const text = fixture('broken.isml')
  const { document, problems } = parseTemplate(text)
  assert.deepEqual(
    problems.map((p) => [p.code, text.slice(p.start, p.end)]),
    [
      ['unclosed_expression', '${pdict.open'],
      ['unclosed_expression', '${pdict.unclosed'],
      ['unclosed_attribute_value', '"a>after</p>'],
      ['unclosed_iscomment', '<iscomment>'],
      ['unclosed_isscript', '<isscript>'],
      ['unclosed_comment', '<!--'],
      ['unclosed_tag', '<isloop items="${pdict.items}" var="item">'],
      ['unexpected_close_tag', '</isnotopen>']
    ]
  )
  // What follows each unclosed construct is still parsed.
  const after = all(document).find((n) => n.type === 'Element' && n.name === 'isprint') as Element
  assert.ok(after, 'the tag after an unclosed comment is parsed')
  assert.deepEqual(range(after), rangeOf(text, `<isprint value="\${'still parsed'}"/>`))
  const script = all(document).find((n) => n.type === 'IsScript')
  assert.ok(script && script.type === 'IsScript')
  assert.equal(script.close, null)
  assert.equal(script.codeEnd, offsetOf(text, '<span>${x}'), 'an unclosed <isscript> stops before the next line that starts with a tag')
  const isif = element(document, 'isif')
  assert.deepEqual(isif.close, rangeOf(text, '</isif>'), 'the end tag closes its tag over the unclosed loop inside')
  const loop = element(document, 'isloop')
  assert.equal(loop.close, null)
  assert.equal(loop.end, offsetOf(text, '</isif>'))
  const paragraph = element(document, 'p')
  assert.equal(paragraph.openEnd, offsetOf(text, '\n    <em>next'), 'the start tag ends with its unclosed value, before the line that starts with an HTML tag')
  assert.ok(all(document).some((n) => n.type === 'CloseTag' && n.name === 'div'), 'an HTML end tag never closes past an open ISML tag')
})

test('a multi-line ${…} keeps every line, and what follows it', () => {
  const text = '<span class="price">${pdict.total\n    + pdict.tax}</span>\n<p>${after}</p>'
  const { document, problems } = parseTemplate(text)
  assert.deepEqual(problems, [])
  const expressions = all(document).filter((n): n is IsmlExpression => n.type === 'Expression')
  assert.deepEqual(expressions.map((e) => text.slice(e.codeStart, e.codeEnd)), ['pdict.total\n    + pdict.tax', 'after'])
})

test('an ISML tag inside a quoted value, at the start of a line too', () => {
  const text = '<div class="form-group\n    <isif condition="${pdict.required}">required</isif>">\n  <input name="a"/>\n</div>'
  const { document, problems } = parseTemplate(text)
  assert.deepEqual(problems, [])
  const div = element(document, 'div')
  const value = div.attributes[0].value
  assert.ok(value)
  assert.deepEqual({ start: value.contentStart, end: value.contentEnd }, rangeOf(text, 'form-group\n    <isif condition="${pdict.required}">required</isif>'))
  assert.deepEqual(value.parts.map((p) => [p.type, p.type === 'Element' || p.type === 'CloseTag' ? p.name : '']), [
    ['Text', ''],
    ['Element', 'isif'],
    ['Text', ''],
    ['CloseTag', 'isif']
  ])
  assert.deepEqual(div.children.filter((n) => n.type === 'Element').map((n) => (n as Element).name), ['input'])
  assert.deepEqual(div.close, rangeOf(text, '</div>'))
})

test('tags inside tags are bounded: past the bound the rest is read as content, never lost', () => {
  const nested = '<p>${keep}</p>' + '<isa '.repeat(20000) + '\n<b>${alsoKept}</b>'
  const deep = parseTemplate(nested)
  assert.ok(deep.problems.some((p) => p.code === 'too_deep'))
  assert.equal(deep.problems.filter((p) => p.code === 'too_deep').length, 1, 'reported once')
  const kept = all(deep.document).filter((n): n is IsmlExpression => n.type === 'Expression').map((e) => nested.slice(e.codeStart, e.codeEnd))
  assert.deepEqual([kept[0], kept[kept.length - 1]], ['keep', 'alsoKept'])
  const values = '<p>${keep}</p>' + '<a b="<isa c=\''.repeat(5000) + '\n<b>${alsoKept}</b>'
  const inValues = parseTemplate(values)
  const keptInValues = all(inValues.document).filter((n): n is IsmlExpression => n.type === 'Expression').map((e) => values.slice(e.codeStart, e.codeEnd))
  assert.deepEqual([keptInValues[0], keptInValues[keptInValues.length - 1]], ['keep', 'alsoKept'])
  assert.ok(!inValues.problems.some((p) => p.code === 'internal_error'))
})

test('more tolerance: an unclosed start tag, a stray end tag, names in any case', () => {
  const unclosed = parseTemplate('<div class="a"\n<span>b</span>')
  assert.deepEqual(unclosed.problems.map((p) => p.code), ['unclosed_start_tag'])
  assert.deepEqual(unclosed.document.children.filter((n) => n.type === 'Element').map((n) => (n as Element).name), ['div'])
  assert.equal((unclosed.document.children[0] as Element).children.some((n) => n.type === 'Element' && n.name === 'span'), true)
  const upper = parseTemplate('<ISIF condition="${a}"><P>x</P></ISIF>')
  assert.deepEqual(upper.problems, [])
  assert.equal((upper.document.children[0] as Element).name, 'isif')
  const stray = parseTemplate('<div></div></div></isif>')
  assert.deepEqual(stray.problems.map((p) => p.code), ['unexpected_close_tag'], 'only an ISML end tag with nothing to close is a problem')
  const undeclared = parseTemplate('<isproductcard product="${p}"/>')
  assert.equal((undeclared.document.children[0] as Element).custom, true)
  assert.deepEqual(undeclared.document.modules, [])
})
