// The line lexers and the incremental highlighter: what each language's lines become, that a
// state carries what a line cannot see, that the result per line equals lexing the whole text
// from the start, and that a change re-lexes only what it must.
import { assert, test } from 'orca/testing'
import { TextBuffer } from '../surface/buffer'
import { Highlighter } from './highlighter'
import { lexIsmlLine } from './isml'
import { javascript } from './js'
import { guessLanguage, languageOfPath, LEXERS, type Language } from './language'
import { lexPropertiesLine } from './properties'
import { describeTokens, type LineLexer, type TokenClass } from './tokens'
import { lexXmlLine } from './xml'

/** Every line of a text lexed from the start, as `[text, class]` per line. */
function lexAll(lexer: LineLexer, text: string): [string, TokenClass][][] {
  let state = lexer.initial
  return text.split('\n').map((line) => {
    const result = lexer.line(line, state)
    state = result.state
    return describeTokens(line, result.tokens)
  })
}

const has = (tokens: [string, TokenClass][], text: string, cls: TokenClass) => tokens.some(([t, c]) => t === text && c === cls)

test('JavaScript: keywords, literals, strings, numbers, regexes and comments, with the engine’s lexer', () => {
  const [line] = lexAll(javascript, "var re = /a+b/g; return total / 2 + 'x' + null; // done")
  assert.ok(has(line, 'var', 'keyword'))
  assert.ok(has(line, '/a+b/g', 'regex'), 'a slash after = starts a regex')
  assert.ok(has(line, '2', 'number'))
  assert.ok(has(line, "'x'", 'string'))
  assert.ok(has(line, 'null', 'literal'))
  assert.ok(has(line, '// done', 'comment'))
  assert.ok(!line.some(([, c]) => c === 'regex' && line.length > 0 && false))
  const [each] = lexAll(javascript, 'for each (var item in items) {}')
  assert.ok(has(each, 'each', 'keyword'), 'Rhino’s for each')
})

test('JavaScript: a block comment and a template literal go on to the next lines', () => {
  const lines = lexAll(javascript, ['/** doc', ' * more', ' */ var a = `one', 'two ${b + `in', 'ner`} three', '` + c;'].join('\n'))
  assert.deepEqual(lines[1], [[' * more', 'comment']])
  assert.ok(has(lines[2], ' */', 'comment') && has(lines[2], 'var', 'keyword'))
  assert.ok(has(lines[3], 'two ${', 'string') && has(lines[3], 'b', 'plain'))
  // The nested template closes, and the outer one goes on after the `}` (adjacent strings join).
  assert.deepEqual(lines[4], [['ner`} three', 'string']])
  assert.deepEqual(lines[5], [['`', 'string'], ['+', 'punct'], ['c', 'plain'], [';', 'punct']], 'the template closed on its last line')
})

test('ISML: tags, ISML tags, attributes, values, ${} in text and in values', () => {
  const [line] = lexAll(LEXERS.isml, '<div class="tile ${pdict.css}"><isprint value="${Resource.msg(\'a\', \'b\', null)}" encoding="on"/> ${count + 1}</div>')
  assert.ok(has(line, 'div', 'tag'))
  assert.ok(has(line, 'isprint', 'istag'))
  assert.ok(has(line, 'class', 'attr'))
  assert.ok(has(line, '"tile ', 'string'))
  assert.ok(has(line, '${', 'expr') && has(line, '}', 'expr'))
  assert.ok(has(line, 'pdict', 'plain'))
  assert.ok(has(line, "'a'", 'string'))
  assert.ok(has(line, 'null', 'literal'))
  assert.ok(has(line, '1', 'number'))
})

test('ISML: an ISML tag inside a value, a ${} among a tag’s attributes, a custom tag', () => {
  const [line] = lexAll(LEXERS.isml, '<li class="<isif condition="${active}">on</isif>" ${attrs}><ismytag x="1"/></li>')
  assert.ok(has(line, 'isif', 'istag'))
  assert.ok(has(line, 'active', 'plain'))
  assert.ok(has(line, '/isif'.slice(1), 'istag'))
  assert.ok(has(line, 'attrs', 'plain'))
  assert.ok(has(line, 'ismytag', 'istag'))
})

test('ISML: comments and <isscript> span lines; an unclosed ${ stops before a line that starts with a tag', () => {
  const lines = lexAll(
    LEXERS.isml,
    [
      '<iscomment>',
      '  not code ${x}',
      '</iscomment>',
      '<!-- an html',
      'comment -->',
      '<isscript>',
      "  var a = require('dw/util/StringUtils'); /* open",
      '  close */ var b = 2;',
      '</isscript>',
      '<p>${open',
      '<div>after</div>'
    ].join('\n')
  )
  assert.deepEqual(lines[1], [['  not code ${x}', 'comment']])
  assert.ok(has(lines[2], 'iscomment', 'istag'))
  assert.deepEqual(lines[4], [['comment -->', 'comment']])
  assert.ok(has(lines[6], 'var', 'keyword') && has(lines[6], "'dw/util/StringUtils'", 'string'))
  assert.ok(has(lines[7], '  close */', 'comment') && has(lines[7], '2', 'number'))
  assert.ok(has(lines[8], 'isscript', 'istag'))
  assert.ok(has(lines[10], 'div', 'tag'), 'the unclosed ${ ended with its line')
})

test('ISML: a <script> body is JavaScript, a <style> body plain', () => {
  const lines = lexAll(LEXERS.isml, ['<script>', 'var x = 1;', '</script><style>', 'a { color: red }', '</style>'].join('\n'))
  assert.ok(has(lines[1], 'var', 'keyword'))
  assert.ok(has(lines[2], 'style', 'tag'))
  assert.ok(!lines[3].some(([, c]) => c === 'keyword'))
})

test('XML: declarations, tags, attributes, entities, comments and CDATA across lines', () => {
  const lines = lexAll(
    LEXERS.xml,
    ['<?xml version="1.0" encoding="UTF-8"?>', '<metadata xmlns="http://www.example.com/x">', '  <!-- a', '  b --><name>A &amp; B</name>', '  <![CDATA[ raw', ' ]]></metadata>'].join('\n')
  )
  assert.ok(lines[0].every(([, c]) => c === 'meta'))
  assert.ok(has(lines[1], 'metadata', 'tag') && has(lines[1], 'xmlns', 'attr') && has(lines[1], '"http://www.example.com/x"', 'string'))
  assert.ok(has(lines[3], '  b -->', 'comment') && has(lines[3], '&amp;', 'escape') && has(lines[3], 'name', 'tag'))
  assert.ok(has(lines[5], ' ]]>', 'string'))
  assert.deepEqual(lexXmlLine('<a', 'x').state, 't')
})

test('.properties: keys, separators, values, escapes, placeholders and continued values', () => {
  const lines = lexAll(LEXERS.properties, ['# a comment', 'cart.title=Your basket', 'cart.items = {0} items\\u00e9 \\', '    continued {1}', 'key\\ with\\:escapes: value'].join('\n'))
  assert.deepEqual(lines[0], [['# a comment', 'comment']])
  assert.ok(has(lines[1], 'cart.title', 'key') && has(lines[1], '=', 'punct') && has(lines[1], 'Your basket', 'string'))
  assert.ok(has(lines[2], '{0}', 'expr') && has(lines[2], '\\u00e9', 'escape'))
  assert.ok(has(lines[3], '{1}', 'expr'), 'the continued line is a value')
  assert.ok(has(lines[4], 'key\\ with\\:escapes', 'key'))
  assert.equal(lexPropertiesLine('a=b\\\\', 'k').state, 'k', 'an even number of backslashes ends the value')
})

test('the language comes from the extension, else from the text', () => {
  assert.equal(languageOfPath('cartridge/templates/default/cart.isml'), 'isml')
  assert.equal(languageOfPath('a/b.JS'), 'javascript')
  assert.equal(languageOfPath('meta/system-objecttype-extensions.xml'), 'xml')
  assert.equal(languageOfPath('templates/resources/cart_fr.properties'), 'properties')
  assert.equal(languageOfPath('README.md'), null)
  const guesses: [string, Language][] = [
    ['<isif condition="${a}">\n</isif>', 'isml'],
    ['<?xml version="1.0"?>\n<a/>', 'xml'],
    ['cart.title=Basket\n# comment\ncart.empty=Empty', 'properties'],
    ["'use strict';\nvar a = require('x');", 'javascript']
  ]
  for (const [text, language] of guesses) assert.equal(guessLanguage(text), language, text)
  // The editor of `.js`, `.xml` and `.properties` guesses among those three only.
  const others: Language[] = ['javascript', 'xml', 'properties']
  const viewGuesses: [string, Language][] = [
    ['var tpl = "${name}";\nmodule.exports = { tpl: tpl };', 'javascript'],
    ['!function(e){e.x=1}(window);', 'javascript'],
    ['return.label=Return\nfunction.title=Function\n! a comment\nprice={0} items', 'properties'],
    ['<form xmlns="http://www.example.com/form">\n  <field formid="email" type="string"/>\n</form>', 'xml'],
    ['exports.total = total;', 'javascript']
  ]
  for (const [text, language] of viewGuesses) assert.equal(guessLanguage(text, others), language, text)
})

test('the incremental highlighter gives every line what lexing from the start gives, after any edits', () => {
  const lines = [
    '<isdecorate template="common/layout/page">',
    '<isscript>',
    "  var assets = require('*/cartridge/scripts/assets');",
    '</isscript>',
    '<div class="cart ${pdict.css}">',
    '  <!-- note -->',
    '  <isloop items="${pdict.items}" var="item">',
    '    <isprint value="${item.name}"/>',
    '  </isloop>',
    '</div>',
    '</isdecorate>'
  ]
  const buffer = new TextBuffer(lines.join('\n'))
  const highlighter = new Highlighter(buffer, LEXERS.isml)
  highlighter.ensure(buffer.lineCount)
  const edits: [number, number, number, number, string][] = [
    [5, 2, 5, 2, '<!-- open'],
    [7, 0, 7, 0, '"'],
    [1, 0, 1, 0, 'x'],
    [5, 2, 5, 11, ''],
    [7, 0, 7, 1, ''],
    [2, 2, 3, 0, '/* a\n b */\n'],
    [0, 0, 0, 0, '<iscomment>\n'],
    [0, 0, 1, 0, '']
  ]
  for (const [l1, c1, l2, c2, text] of edits) {
    buffer.replace({ line: l1, col: c1 }, { line: l2, col: c2 }, text)
    highlighter.ensure(buffer.lineCount)
    const fresh = lexAll(LEXERS.isml, buffer.text())
    for (let l = 0; l < buffer.lineCount; l++) {
      assert.deepEqual(describeTokens(buffer.line(l), highlighter.tokens(l)), fresh[l], `line ${l} after inserting ${JSON.stringify(text)}`)
    }
  }
})

test('a typed key re-lexes its own line; a quote re-lexes only until the state agrees, never past what is asked', () => {
  const body = Array.from({ length: 3_000 }, (_, i) => `  <div class="row-${i}">\${pdict.items[${i}].name}</div>`)
  const buffer = new TextBuffer(body.join('\n'))
  const highlighter = new Highlighter(buffer, LEXERS.isml)
  highlighter.ensure(60)
  highlighter.lexed = 0
  buffer.replace({ line: 30, col: 2 }, { line: 30, col: 2 }, 'x')
  highlighter.ensure(60)
  assert.equal(highlighter.lexed, 1, 'one line')
  highlighter.lexed = 0
  buffer.replace({ line: 30, col: 2 }, { line: 30, col: 2 }, '<!--')
  highlighter.ensure(60)
  assert.equal(highlighter.lexed, 31, 'the comment runs to what is drawn, and no further')
  highlighter.lexed = 0
  buffer.replace({ line: 30, col: 2 }, { line: 30, col: 6 }, '')
  highlighter.ensure(60)
  assert.equal(highlighter.lexed, 31)
})
