// The tolerant JavaScript parser: every construct of SFCC scripts with its positions, regex
// versus division, automatic semicolons, JSDoc attached to declarations, and broken and
// truncated input (problems with positions, and parsing that goes on after them).
import { assert, test } from 'orca/testing'
import { fixture, offsetOf, rangeOf } from '../fixtures/read'
import type * as AST from './ast'
import { forEachChild } from './ast'
import { parseExpression, parseScript } from './parser'

const range = (node: { start: number; end: number }) => ({ start: node.start, end: node.end })

/** Every node of a tree, in order. */
function nodes(root: AST.Node): AST.Node[] {
  const out: AST.Node[] = []
  const walk = (node: AST.Node) => {
    out.push(node)
    forEachChild(node, walk)
  }
  walk(root)
  return out
}

const firstOf = <T extends AST.Node['type']>(root: AST.Node, type: T) => nodes(root).find((n) => n.type === type) as Extract<AST.Node, { type: T }>

test('the valid fixtures parse with no problem', () => {
  for (const name of ['controller.js', 'model.js', 'shapes.js', 'helper.js']) {
    const { problems } = parseScript(fixture(name))
    assert.deepEqual(problems, [], name)
  }
})

test('an SFRA controller: the route calls, the middleware chain and the export, with positions', () => {
  const text = fixture('controller.js')
  const { program } = parseScript(text)
  const routes = program.body.filter(
    (s): s is AST.ExpressionStatement => s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' && s.expression.callee.type === 'MemberExpression'
  )
  assert.equal(routes.length, 2)
  const show = routes[0].expression as AST.CallExpression
  assert.deepEqual(range(routes[0]), { start: offsetOf(text, "server.get(\n    'Show'"), end: offsetOf(text, 'computedPageMetaData\n);') + 'computedPageMetaData\n);'.length })
  assert.equal(show.end, routes[0].end - 1, 'the call ends before its semicolon')
  assert.deepEqual(
    show.arguments.map((a) => a.type),
    ['Literal', 'MemberExpression', 'MemberExpression', 'FunctionExpression', 'MemberExpression']
  )
  assert.deepEqual(range(show.arguments[0]), rangeOf(text, "'Show'"))
  const handler = show.arguments[3] as AST.FunctionExpression
  assert.deepEqual(handler.params.map((p) => (p as AST.Identifier).name), ['req', 'res', 'next'])
  assert.deepEqual(range(handler.params[1]), rangeOf(text, 'res', 0))
  const exported = program.body[program.body.length - 1] as AST.ExpressionStatement
  assert.deepEqual(range(exported), rangeOf(text, 'module.exports = server.exports();'))
  const assignment = exported.expression as AST.AssignmentExpression
  assert.deepEqual(range(assignment.right), rangeOf(text, 'server.exports()'))
})

test('statements: every kind, with positions', () => {
  const text = [
    'var a = 1, b;',
    'let [c, , ...d] = list;',
    'const { e, f: g = 2, ...h } = obj;',
    'function k(x, y = 1, ...z) { return x; }',
    'class M extends N { constructor() { super(); } static s() {} get v() { return 1; } set v(w) {} }',
    'if (a) b(); else if (c) d(); else { e(); }',
    'for (var i = 0; i < 3; i++) continue;',
    'for (var key in obj) {}',
    'for each (var item in list) {}',
    'for (const [p, q] of pairs) {}',
    'while (a) break;',
    'do { a--; } while (a)',
    'outer: for (;;) { break outer; }',
    'switch (a) { case 1: b(); break; default: c(); }',
    'try { a(); } catch (err if err instanceof TypeError) { b(); } finally { c(); }',
    'try { a(); } catch { b(); }',
    'throw new Error("x");',
    'with (obj) { a; }',
    'debugger;',
    ';'
  ].join('\n')
  const { program, problems } = parseScript(text)
  assert.deepEqual(problems, [])
  assert.deepEqual(program.body.map((s) => s.type), [
    'VariableDeclaration', 'VariableDeclaration', 'VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration',
    'IfStatement', 'ForStatement', 'ForInStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement',
    'DoWhileStatement', 'LabeledStatement', 'SwitchStatement', 'TryStatement', 'TryStatement', 'ThrowStatement',
    'WithStatement', 'DebuggerStatement', 'EmptyStatement'
  ])
  const lines = text.split('\n')
  let lineStart = 0
  program.body.forEach((statement, i) => {
    assert.deepEqual(range(statement), { start: lineStart, end: lineStart + lines[i].length }, `statement ${i} spans its line`)
    lineStart += lines[i].length + 1
  })
  const forEach = program.body[8] as AST.ForInStatement
  assert.equal(forEach.each, true)
  assert.equal((program.body[7] as AST.ForInStatement).each, false)
  const tryCatch = program.body[14] as AST.TryStatement
  assert.ok(tryCatch.handler?.guard, 'the conditional catch keeps its guard')
  assert.deepEqual(range(tryCatch.handler?.guard as AST.Expression), rangeOf(text, 'err instanceof TypeError'))
  const chain = program.body[5] as AST.IfStatement
  assert.equal(chain.alternate?.type, 'IfStatement')
  assert.equal((chain.alternate as AST.IfStatement).alternate?.type, 'BlockStatement')
  const klass = program.body[4] as AST.ClassDeclaration
  assert.deepEqual(klass.body.body.map((m) => `${m.static ? 'static ' : ''}${m.kind}`), ['constructor', 'static method', 'get', 'set'])
  const params = (program.body[3] as AST.FunctionDeclaration).params
  assert.deepEqual(params.map((p) => p.type), ['Identifier', 'AssignmentPattern', 'RestElement'])
  const pattern = (program.body[2] as AST.VariableDeclaration).declarations[0].id as AST.ObjectPattern
  assert.deepEqual(range(pattern), rangeOf(text, '{ e, f: g = 2, ...h }'))
  assert.deepEqual(pattern.properties.map((p) => p.type), ['Property', 'Property', 'RestElement'])
  const holes = ((program.body[1] as AST.VariableDeclaration).declarations[0].id as AST.ArrayPattern).elements
  assert.deepEqual(holes.map((e) => e && e.type), ['Identifier', null, 'RestElement'])
})

test('expressions: every kind, with positions', () => {
  const text = [
    'x = a => a * 2;',
    'x = (a, { b }) => { return a + b; };',
    'x = () => ({ v: 1 });',
    'x = `t ${a} and ${ b + 1 }`;',
    'x = tag`raw ${a}`;',
    'x = [1, ...rest, , 3];',
    'x = { a, b: 1, [c]: 2, d() {}, get e() { return 1; }, set e(v) {}, ...f, "g": 3, 4: 4 };',
    'x = function named() {};',
    'x = class {};',
    'x = new Foo.Bar(1).baz;',
    'x = new Foo;',
    'x = a ? b : c;',
    'x = a || b && c;',
    'x = a ?? b;',
    'x = a + b * c ** 2;',
    'x = typeof a === "string";',
    'x = !a, y = -b, z = void 0, delete o.p;',
    'x = a++ + --b;',
    'x = a.b[c](d)?.e;',
    'x += 1;',
    'x = this.y;',
    'x = /re/g;',
    'x = (a, b);'
  ].join('\n')
  const { program, problems } = parseScript(text)
  assert.deepEqual(problems, [])
  const values = program.body.map((s) => {
    const expression = (s as AST.ExpressionStatement).expression
    if (expression.type === 'SequenceExpression') return expression.expressions[0]
    return expression
  })
  const right = (i: number) => (values[i] as AST.AssignmentExpression).right
  assert.deepEqual(
    values.map((v, i) => (i === 19 ? v.type : right(i).type)),
    [
      'ArrowFunctionExpression', 'ArrowFunctionExpression', 'ArrowFunctionExpression', 'TemplateLiteral', 'TaggedTemplateExpression',
      'ArrayExpression', 'ObjectExpression', 'FunctionExpression', 'ClassExpression', 'MemberExpression', 'NewExpression',
      'ConditionalExpression', 'LogicalExpression', 'LogicalExpression', 'BinaryExpression', 'BinaryExpression',
      'UnaryExpression', 'BinaryExpression', 'MemberExpression', 'AssignmentExpression', 'MemberExpression', 'Literal',
      'SequenceExpression'
    ]
  )
  // Each right-hand side runs from after `x = ` to its line's last `;`.
  const lines = text.split('\n')
  let lineStart = 0
  lines.forEach((line, i) => {
    if (i !== 16 && i !== 19 && i !== 22) {
      assert.deepEqual(range(right(i)), { start: lineStart + 4, end: lineStart + line.lastIndexOf(';') }, `expression ${i}: ${line}`)
    }
    lineStart += line.length + 1
  })
  // As in ESTree, parentheses are not a node: the sequence spans what is inside them.
  assert.deepEqual(range(right(22)), { start: text.lastIndexOf('(a, b)') + 1, end: text.lastIndexOf('(a, b)') + 5 })
  const arrow = right(1) as AST.ArrowFunctionExpression
  assert.deepEqual(arrow.params.map((p) => p.type), ['Identifier', 'ObjectPattern'])
  assert.equal(arrow.expression, false)
  assert.equal((right(2) as AST.ArrowFunctionExpression).body.type, 'ObjectExpression')
  const template = right(3) as AST.TemplateLiteral
  assert.deepEqual(template.quasis.map((q) => q.cooked), ['t ', ' and ', ''])
  assert.deepEqual(template.expressions.map((e) => text.slice(e.start, e.end)), ['a', 'b + 1'])
  const object = right(6) as AST.ObjectExpression
  assert.deepEqual(
    object.properties.map((p) => (p.type === 'SpreadElement' ? 'spread' : `${p.kind}${p.shorthand ? ' shorthand' : ''}${p.computed ? ' computed' : ''}${p.method ? ' method' : ''}`)),
    ['init shorthand', 'init', 'init computed', 'init method', 'get', 'set', 'spread', 'init', 'init']
  )
  const logical = right(12) as AST.LogicalExpression
  assert.equal(logical.operator, '||')
  assert.equal((logical.right as AST.LogicalExpression).operator, '&&', '&& binds tighter than ||')
  const power = right(14) as AST.BinaryExpression
  assert.equal(power.operator, '+')
  assert.equal(((power.right as AST.BinaryExpression).right as AST.BinaryExpression).operator, '**')
  const newMember = right(9) as AST.MemberExpression
  assert.equal(newMember.object.type, 'NewExpression')
  assert.deepEqual(range(newMember.object), rangeOf(text, 'new Foo.Bar(1)'))
  const optional = right(18) as AST.MemberExpression
  assert.equal(optional.optional, true)
})

test('regex or division, as the parser decides it', () => {
  const division = parseScript('var r = a / b / c;')
  const outer = (division.program.body[0] as AST.VariableDeclaration).declarations[0].init as AST.BinaryExpression
  assert.equal(outer.operator, '/')
  assert.equal((outer.left as AST.BinaryExpression).operator, '/')
  const regex = parseScript('var r = /=+[/]/g.test(s) ? 1 : 2;')
  assert.deepEqual(regex.problems, [])
  const literal = firstOf(regex.program, 'Literal')
  assert.deepEqual([literal.kind, literal.regex], ['regex', { pattern: '=+[/]', flags: 'g' }])
  // After the `)` of an `if`, a statement starts: a regex (a token-based guess would say division).
  const afterIf = parseScript('if (a) /x/.test(b);')
  assert.deepEqual(afterIf.problems, [])
  assert.equal(firstOf(afterIf.program, 'Literal').kind, 'regex')
  // No semicolon is inserted before a `/` on the next line: it divides.
  const noAsi = parseScript('var y = a\n/b/g')
  assert.equal(((noAsi.program.body[0] as AST.VariableDeclaration).declarations[0].init as AST.BinaryExpression).operator, '/')
})

test('automatic semicolon insertion', () => {
  const lines = parseScript('var a = 1\nvar b = 2\nb++\n++a\nfoo()\n(bar)')
  assert.deepEqual(lines.problems, [])
  assert.deepEqual(lines.program.body.map((s) => s.type), ['VariableDeclaration', 'VariableDeclaration', 'ExpressionStatement', 'ExpressionStatement', 'ExpressionStatement'])
  const call = (lines.program.body[4] as AST.ExpressionStatement).expression as AST.CallExpression
  assert.equal(call.callee.type, 'CallExpression', 'a `(` on the next line continues the call')
  const restricted = parseScript('function f() {\n  return\n  value\n}\na\n++\nb')
  assert.deepEqual(restricted.problems, [])
  const body = (restricted.program.body[0] as AST.FunctionDeclaration).body.body
  assert.equal((body[0] as AST.ReturnStatement).argument, null, '`return` ends at its line')
  assert.equal(body[1].type, 'ExpressionStatement')
  const update = (restricted.program.body[2] as AST.ExpressionStatement).expression as AST.UpdateExpression
  assert.deepEqual([update.prefix, (update.argument as AST.Identifier).name], [true, 'b'], '`++` after a line break goes with the next line')
  const missing = parseScript('var a = 1 var b = 2')
  assert.deepEqual(missing.problems.map((p) => [p.code, p.detail, p.start]), [['expected', ';', 10]])
})

test('JSDoc comments are attached to the declaration that follows, with their offsets', () => {
  const text = fixture('helper.js')
  const { program, comments } = parseScript(text)
  const fn = program.body.find((s) => s.type === 'FunctionDeclaration') as AST.FunctionDeclaration
  assert.ok(fn.doc)
  assert.equal(fn.doc?.kind, 'doc')
  assert.deepEqual(range(fn.doc as AST.Comment), { start: offsetOf(text, '/**\n * Splits'), end: offsetOf(text, '*/\nfunction splitLine') + 2 })
  assert.match(fn.doc?.text ?? '', /@param \{string\} line - the address line\n \* @param \{number\} \[limit\]/)
  const declarations = program.body.filter((s): s is AST.VariableDeclaration => s.type === 'VariableDeclaration')
  const byName = (name: string) => declarations.find((d) => (d.declarations[0].id as AST.Identifier).name === name) as AST.VariableDeclaration
  assert.match(byName('POSTCODE').doc?.text ?? '', /@type \{RegExp\}/)
  assert.match(byName('ratio').doc?.text ?? '', /@type \{number\}/)
  assert.match(byName('isValid').doc?.text ?? '', /@param \{string\} code/)
  assert.equal(byName('Logger').doc, undefined, 'a declaration without JSDoc has none')
  assert.equal(byName('label').doc, undefined)
  const exported = program.body[program.body.length - 1] as AST.ExpressionStatement
  const object = (exported.expression as AST.AssignmentExpression).right as AST.ObjectExpression
  const property = object.properties[1] as AST.Property
  assert.match(property.doc?.text ?? '', /Whether a postcode is valid/)
  assert.ok(comments.some((c) => c.kind === 'line' || c.kind === 'block' || c.kind === 'doc'))
  assert.ok(comments.every((c) => text.slice(c.start, c.start + 2) === '/*' || text.slice(c.start, c.start + 2) === '//'))
})

test('a broken script: each problem at its place, and parsing goes on to the end', () => {
  const text = fixture('broken.js')
  const { program, problems } = parseScript(text)
  assert.deepEqual(
    problems.map((p) => [p.code, p.detail, p.start]),
    [
      ['expected', ')', offsetOf(text, '{\n    return a +;')],
      ['unexpected_token', ';', offsetOf(text, ';\n}\n\nvar after')],
      ['expected', ';', offsetOf(text, '2;\n\nfunction second')],
      ['unexpected_token', ';', offsetOf(text, ';\n    Logger.info')],
      ['expected', '}', offsetOf(text, 'b: 2 }')]
    ]
  )
  const functions = program.body.filter((s): s is AST.FunctionDeclaration => s.type === 'FunctionDeclaration')
  assert.deepEqual(functions.map((f) => f.id?.name), ['first', 'second', 'third'])
  const third = functions[2]
  assert.deepEqual(range(third), { start: offsetOf(text, 'function third'), end: offsetOf(text, "'third';\n}") + "'third';\n}".length })
  const last = program.body[program.body.length - 1] as AST.ExpressionStatement
  assert.deepEqual(range(last), rangeOf(text, 'module.exports = { first: first, second: second, third: third };'))
  // The line after a broken one is read whole.
  const second = functions[1]
  assert.ok(nodes(second).some((n) => n.type === 'Identifier' && n.name === 'Logger'))
})

test('a truncated script: the open constructs are reported at the end, and what was read is kept', () => {
  const text = fixture('truncated.js')
  const { program, problems } = parseScript(text)
  assert.ok(problems.length > 0)
  assert.ok(problems.every((p) => p.end <= text.length))
  assert.deepEqual(problems[problems.length - 1].start, text.length)
  const save = program.body.find((s) => s.type === 'FunctionDeclaration') as AST.FunctionDeclaration
  assert.equal(save.id?.name, 'save')
  assert.equal(save.end, text.trimEnd().length, 'the function runs to the last token')
  assert.ok(nodes(save).some((n) => n.type === 'TemplateLiteral'))
  const inside = parseScript('function f() {\n  var a = [1, {b: (2')
  assert.ok(inside.problems.length > 0)
  assert.equal((inside.program.body[0] as AST.FunctionDeclaration).body.body[0].type, 'VariableDeclaration')
})

test('an expression alone, from a slice of a larger text, in that text’s positions', () => {
  const text = '<span>${ pdict.product.name + suffix }</span>'
  const start = offsetOf(text, '${') + 2
  const end = offsetOf(text, '}</span>')
  const { expression, problems } = parseExpression(text, { start, end })
  assert.deepEqual(problems, [])
  assert.equal(expression.type, 'BinaryExpression')
  assert.deepEqual(range(expression), rangeOf(text, 'pdict.product.name + suffix'))
  assert.deepEqual(range((expression as AST.BinaryExpression).right), rangeOf(text, 'suffix'))
  assert.deepEqual(parseExpression('a b').problems.map((p) => [p.code, p.start]), [['unexpected_token', 2]])
  const empty = parseExpression('   ')
  assert.deepEqual(empty.problems.map((p) => [p.code, p.detail]), [['expected', 'expression']])
  assert.equal(empty.expression.type, 'InvalidExpression')
})

test('reserved words where a name belongs, and other mistakes, are reported but read on', () => {
  const text = 'var enum = 1; foo(1,, 2); x = ; a.;'
  const reserved = parseScript(text)
  assert.deepEqual(
    reserved.problems.map((p) => [p.code, p.detail, p.start]),
    [
      ['unexpected_token', 'enum', 4],
      ['unexpected_token', ',', offsetOf(text, ',, 2') + 1],
      ['unexpected_token', ';', offsetOf(text, '; a.;')],
      ['expected', 'name', text.length - 1]
    ]
  )
  assert.equal(reserved.program.body.length, 4, 'each statement after a problem is still read')
  const declarator = (reserved.program.body[0] as AST.VariableDeclaration).declarations[0]
  assert.deepEqual([(declarator.id as AST.Identifier).name, (declarator.init as AST.Literal).value], ['enum', 1])
  const statementKeyword = parseScript('var class = 1;\nfoo();')
  assert.deepEqual(statementKeyword.problems.map((p) => [p.code, p.detail, p.start]), [['expected', 'name', 4]])
  assert.equal(statementKeyword.program.body[1].type, 'ExpressionStatement')
  const target = parseScript('a + b = c; (x) => {}; 1++;')
  assert.deepEqual(target.problems.map((p) => p.code), ['invalid_assignment_target', 'invalid_assignment_target'])
})
