// The JavaScript lexer: tokens with their positions, regex or division, templates, comments, and
// what it does with what it cannot read.
import { assert, test } from 'orca/testing'
import { Lexer, tokenize, type Token } from './lexer'

const kinds = (tokens: Token[]) => tokens.map((t) => `${t.type}:${t.value}`)

test('tokens carry their text and their range', () => {
  const text = "var total = price * 2.5; // done\nlet name = 'a\\'b';"
  const { tokens, problems } = tokenize(text)
  assert.deepEqual(problems, [])
  assert.deepEqual(kinds(tokens), [
    'keyword:var', 'identifier:total', 'punctuator:=', 'identifier:price', 'punctuator:*', 'number:2.5', 'punctuator:;',
    'comment:// done', 'identifier:let', 'identifier:name', 'punctuator:=', "string:a'b", 'punctuator:;'
  ])
  for (const token of tokens) {
    if (token.type === 'string') assert.equal(text.slice(token.start, token.end), "'a\\'b'")
    else assert.equal(text.slice(token.start, token.end), token.value)
  }
  const letToken = tokens.find((t) => t.value === 'let') as Token
  assert.equal(letToken.newlineBefore, true)
  assert.equal(tokens[1].newlineBefore, false)
})

test('a slash is a regex where an operand may start, a division elsewhere', () => {
  const division = tokenize('a = b / c / d; x = (y) / 2; z = arr[0] / 3; n = this / 1')
  assert.ok(division.tokens.every((t) => t.type !== 'regex'))
  const regex = tokenize("a = /ab+c/gi.test(s); return /[/]x\\//; f(/=+/); x = !/y/")
  const found = regex.tokens.filter((t) => t.type === 'regex')
  assert.deepEqual(
    found.map((t) => t.regex),
    [{ pattern: 'ab+c', flags: 'gi' }, { pattern: '[/]x\\/', flags: '' }, { pattern: '=+', flags: '' }, { pattern: 'y', flags: '' }]
  )
  // The parser's own way: a `/` scanned as a punctuator, read again as a regex.
  const lexer = new Lexer('/a\\/b/m.x')
  const slash = lexer.next()
  assert.equal(slash.value, '/')
  const literal = lexer.rescanRegex(slash)
  assert.deepEqual([literal.type, literal.start, literal.end, literal.regex], ['regex', 0, 7, { pattern: 'a\\/b', flags: 'm' }])
  assert.equal(lexer.next().value, '.')
})

test('template literals come as chunks, nested ones included', () => {
  const text = 'x = `a${b + `c${d}`}e${ {f: 1}.f }g`'
  const { tokens, problems } = tokenize(text)
  assert.deepEqual(problems, [])
  const chunks = tokens.filter((t) => t.type === 'template')
  assert.deepEqual(
    chunks.map((t) => [text.slice(t.start, t.end), t.cooked, t.templateHead, t.templateTail]),
    [
      ['`a${', 'a', true, false],
      ['`c${', 'c', true, false],
      ['}`', '', false, true],
      ['}e${', 'e', false, false],
      ['}g`', 'g', false, true]
    ]
  )
})

test('comments are kept with their kind and range, and a JSDoc rides on the next token', () => {
  const text = '/* plain */\n/**\n * Doc.\n * @param {string} a\n */\n// line\nfunction f(a) {}'
  const comments: import('./ast').Comment[] = []
  const lexer = new Lexer(text, 0, text.length, comments)
  const first = lexer.next()
  assert.equal(first.value, 'function')
  const docStart = text.indexOf('/**')
  const docEnd = text.indexOf('*/', docStart) + 2
  const lineStart = text.indexOf('// line')
  assert.deepEqual(comments.map((c) => [c.kind, c.start, c.end]), [
    ['block', 0, 11],
    ['doc', docStart, docEnd],
    ['line', lineStart, lineStart + '// line'.length]
  ])
  assert.ok(first.doc)
  assert.equal(first.doc?.start, docStart)
  assert.match(first.doc?.text ?? '', /@param \{string\} a/)
  assert.equal(first.newlineBefore, true)
})

test('numbers in every form, strings with escapes', () => {
  const { tokens, problems } = tokenize("0x1F 1e3 .5 1_000 0o17 0b101 10n 012 'tab\\there' \"\\u0041\\x42\\u{43}\" 'line\\\ncontinued'")
  assert.deepEqual(problems, [])
  assert.deepEqual(
    tokens.map((t) => t.value),
    ['0x1F', '1e3', '.5', '1_000', '0o17', '0b101', '10n', '012', 'tab\there', 'ABC', 'linecontinued']
  )
})

test('what cannot be read is reported, with its range, and lexing goes on', () => {
  const text = "a § b 'open\nc = 3in; /* never closed"
  const { tokens, problems } = tokenize(text)
  assert.deepEqual(
    problems.map((p) => [p.code, text.slice(p.start, p.end)]),
    [
      ['invalid_character', '§'],
      ['unterminated_string', "'open"],
      ['invalid_number', '3in'],
      ['unterminated_comment', '/* never closed']
    ]
  )
  assert.ok(tokens.some((t) => t.value === 'c'), 'the line after an unterminated string is read')
  assert.equal(tokenize('x = `never ${a} closed').problems[0].code, 'unterminated_template')
  assert.equal(tokenize('x = /open\ny').problems[0].code, 'unterminated_regex')
})

test('lexing a slice of a text keeps the positions of the whole text', () => {
  const text = '<div>${ pdict.name }</div>'
  const { tokens } = tokenize(text, 7, 19)
  assert.deepEqual(tokens.map((t) => [t.value, t.start]), [['pdict', 8], ['.', 13], ['name', 14]])
})
