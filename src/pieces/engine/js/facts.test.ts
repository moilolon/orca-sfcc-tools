// What a script declares and uses: `require` calls and their bindings, every export shape,
// `module.superModule` chains, declarations with their scopes, and the declaration each use
// refers to. Each fact is checked with its positions.
import { assert, test } from 'orca/testing'
import { fixture, offsetOf, rangeOf } from '../fixtures/read'
import { declarationAt, referenceAt, scopeAt, scriptFacts, type Declaration, type ScriptFacts } from './facts'
import { parseScript } from './parser'

const factsOf = (text: string) => scriptFacts(parseScript(text).program)
const range = (node: { start: number; end: number }) => ({ start: node.start, end: node.end })

/** The declaration of `name` whose name sits at its `nth` occurrence in the text. */
function declared(facts: ScriptFacts, text: string, name: string, nth = 0): Declaration {
  const start = offsetOf(text, name, nth)
  const found = facts.declarations.find((d) => d.name === name && d.start === start)
  if (!found) throw new Error(`no declaration of ${name} at ${start}`)
  return found
}

/** The declaration (its id, or null) of the use of `name` that begins the `nth` occurrence of `snippet`. */
function resolved(facts: ScriptFacts, text: string, name: string, nth: number, snippet = name): number | null {
  const start = offsetOf(text, snippet, nth)
  const reference = facts.references.find((r) => r.start === start && r.name === name)
  if (!reference) throw new Error(`no use of ${name} at ${start}`)
  return reference.declaration
}

test('an SFRA controller: its requires, at module level and inside the route, and its export', () => {
  const text = fixture('controller.js')
  const facts = factsOf(text)
  assert.deepEqual(
    facts.requires.map((r) => r.module),
    [
      'server',
      '*/cartridge/scripts/middleware/cache',
      '*/cartridge/scripts/middleware/consentTracking',
      '*/cartridge/scripts/middleware/pageMetaData',
      '*/cartridge/scripts/factories/product',
      'dw/web/URLUtils',
      '*/cartridge/scripts/factories/product'
    ]
  )
  const [server, , , , productInShow, urlUtils, productInQuickView] = facts.requires
  assert.deepEqual(server.argument, rangeOf(text, "'server'"))
  assert.deepEqual(range(server), rangeOf(text, "require('server')"))
  assert.deepEqual(server.binding, { kind: 'name', name: 'server', ...rangeOf(text, 'server'), declaration: declared(facts, text, 'server').id })
  assert.deepEqual(urlUtils.argument, rangeOf(text, "'dw/web/URLUtils'"))
  assert.deepEqual(productInShow.argument, rangeOf(text, "'*/cartridge/scripts/factories/product'", 0))
  assert.deepEqual(productInQuickView.argument, rangeOf(text, "'*/cartridge/scripts/factories/product'", 1))
  // Inside the route handlers: bound in each function's own scope.
  for (const inner of [productInShow, urlUtils, productInQuickView]) {
    assert.equal(inner.binding?.kind, 'name')
    const declaration = facts.declarations[(inner.binding as { declaration: number }).declaration]
    assert.equal(facts.scopes[declaration.scope].kind, 'function')
  }
  assert.notEqual(
    (productInShow.binding as { declaration: number }).declaration,
    (productInQuickView.binding as { declaration: number }).declaration,
    'two routes, two bindings'
  )
  // A use of the inner binding resolves to it.
  const urlUse = facts.references.find((r) => r.name === 'URLUtils' && r.start === offsetOf(text, 'URLUtils.url'))
  assert.equal(urlUse?.declaration, (urlUtils.binding as { declaration: number }).declaration)
  assert.deepEqual(facts.exports.assignments.map((a) => [a.value.kind, a.value.callee, range(a)]), [['call', 'server.exports', rangeOf(text, 'module.exports = server.exports()')]])
  assert.deepEqual(facts.exports.members, [])
})

test('every require shape: name, pattern, member, assignment, bare, dynamic, inside a function', () => {
  const text = fixture('shapes.js')
  const facts = factsOf(text)
  const byModule = (module: string | null, nth = 0) => facts.requires.filter((r) => r.module === module)[nth]

  const resource = byModule('dw/web/Resource')
  assert.deepEqual(resource.binding, { kind: 'name', name: 'Resource', ...rangeOf(text, 'Resource'), declaration: declared(facts, text, 'Resource').id })

  const price = byModule('*/cartridge/scripts/helpers/priceHelpers')
  assert.deepEqual(price.binding, {
    kind: 'pattern',
    names: [
      { key: 'getPrice', name: 'getPrice', ...rangeOf(text, 'getPrice'), declaration: declared(facts, text, 'getPrice').id },
      { key: 'formatMoney', name: 'format', ...rangeOf(text, 'format', 1), declaration: declared(facts, text, 'format', 1).id }
    ]
  })
  assert.equal(facts.declarations[declared(facts, text, 'format', 1).id].kind, 'const')

  const web = byModule('dw/web')
  assert.equal(web.member, 'URLUtils')
  assert.deepEqual(range(web), rangeOf(text, "require('dw/web')"))
  assert.equal(web.binding?.kind === 'name' && web.binding.name, 'URLUtils')

  const later = byModule('~/cartridge/scripts/later')
  assert.deepEqual(later.binding, { kind: 'name', name: 'later', ...rangeOf(text, 'later', 1), declaration: declared(facts, text, 'later', 0).id })

  const bare = byModule('./sideEffect')
  assert.deepEqual([bare.binding, bare.member], [null, null])

  const dynamic = byModule(null)
  assert.deepEqual(dynamic.argument, rangeOf(text, "Resource.msg('module.name', 'config', null)"))
  assert.equal(dynamic.binding?.kind === 'name' && dynamic.binding.name, 'dynamic')

  const store = byModule('dw/catalog/StoreMgr')
  const storeDeclaration = facts.declarations[(store.binding as { declaration: number }).declaration]
  assert.equal(facts.scopes[storeDeclaration.scope].kind, 'function')
  assert.equal(facts.scopes[store.scope].kind, 'function')

  const geo = byModule('../geo')
  assert.deepEqual(
    geo.binding?.kind === 'pattern' && geo.binding.names.map((n) => [n.key, n.name, n.start]),
    [
      ['lat', 'lat', offsetOf(text, '{ lat') + 2],
      [null, 'rest', offsetOf(text, 'rest')]
    ]
  )

  const nested = byModule('*/cartridge/scripts/nested')
  assert.equal(nested.binding, null)
})

test('every export shape: an object, members, exports.x, Object.assign', () => {
  const text = fixture('shapes.js')
  const facts = factsOf(text)
  assert.deepEqual(
    facts.exports.assignments.map((a) => [a.value.kind, range(a)]),
    [
      ['object', { start: offsetOf(text, 'module.exports = {'), end: offsetOf(text, "nested')\n}") + "nested')\n}".length }],
      ['assign', { start: offsetOf(text, 'module.exports = Object.assign'), end: offsetOf(text, 'assigned: true\n})') + 'assigned: true\n})'.length }]
    ]
  )
  assert.deepEqual(
    facts.exports.members.map((m) => [m.name, m.source, m.value.kind]),
    [
      ['lookup', 'object', 'identifier'],
      ['local', 'object', 'identifier'],
      ['title', 'object', 'function'],
      ['describe', 'object', 'function'],
      ['later', 'object', 'identifier'],
      ['nested', 'object', 'require'],
      ['extra', 'member', 'function'],
      ['direct', 'member', 'identifier'],
      ['assigned', 'assign', 'other']
    ]
  )
  const member = (name: string) => facts.exports.members.find((m) => m.name === name)
  assert.deepEqual(range(member('lookup') as { start: number; end: number }), { start: offsetOf(text, 'lookup: lookup'), end: offsetOf(text, 'lookup: lookup') + 'lookup'.length })
  assert.equal(member('lookup')?.value.declaration, declared(facts, text, 'lookup', 0).id, 'the exported name resolves to its function')
  assert.equal(member('local')?.value.declaration, declared(facts, text, 'local', 0).id)
  assert.equal(member('nested')?.value.module, '*/cartridge/scripts/nested')
  assert.deepEqual(range(member('extra') as { start: number; end: number }), rangeOf(text, 'extra'))
  assert.deepEqual(range(member('direct') as { start: number; end: number }), rangeOf(text, 'direct'))
  assert.equal(member('direct')?.value.declaration, declared(facts, text, 'shared', 0).id)
  assert.deepEqual(range(member('describe')?.value as { start: number; end: number }), { start: offsetOf(text, '() {\n        return format'), end: offsetOf(text, 'getPrice(local));\n    }') + 'getPrice(local));\n    }'.length })
})

test('module.superModule: a model that binds it, extends it and exports it', () => {
  const text = fixture('model.js')
  const facts = factsOf(text)
  const base = declared(facts, text, 'base')
  assert.deepEqual(facts.exports.superModule, { uses: [rangeOf(text, 'module.superModule')], bindings: [base.id], extended: true })
  assert.deepEqual(facts.exports.assignments.map((a) => [a.value.kind, a.value.name, a.value.declaration, a.value.superModule]), [['identifier', 'base', base.id, true]])
  assert.deepEqual(
    facts.exports.members.map((m) => [m.name, m.source, m.value.kind, range(m)]),
    [['canWrap', 'extension', 'function', rangeOf(text, 'canWrap')]]
  )
  assert.match(facts.exports.members[0].doc?.text ?? '', /Whether the cart can be wrapped/)
  assert.equal(resolved(facts, text, 'base', 0, 'base.call'), base.id)
  assert.equal(resolved(facts, text, 'base', 0, 'base.prototype'), base.id)
})

test('module.superModule: exported directly, through Object.assign, or extended but not exported', () => {
  const direct = factsOf('module.exports = module.superModule;')
  assert.deepEqual([direct.exports.assignments[0].value.kind, direct.exports.superModule.extended], ['superModule', true])

  const text = "var base = module.superModule;\nmodule.exports = Object.assign({}, base, {\n    extra: function () {}\n});"
  const assigned = factsOf(text)
  const assignment = assigned.exports.assignments[0]
  assert.deepEqual([assignment.value.kind, assignment.value.superModule], ['assign', true])
  assert.deepEqual(assignment.bases?.map((b) => [b.kind, b.name, b.superModule, range(b)]), [['identifier', 'base', true, rangeOf(text, 'base', 1)]])
  assert.deepEqual(assigned.exports.members.map((m) => [m.name, m.source, m.value.kind, m.start]), [['extra', 'assign', 'function', offsetOf(text, 'extra')]])
  assert.equal(assigned.exports.superModule.extended, true)

  const unexported = factsOf('var base = module.superModule;\nbase.x = 1;\nmodule.exports = {};')
  assert.deepEqual([unexported.exports.superModule.extended, unexported.exports.members], [false, []])
})

test('an exported name: the members of its object and of its extensions', () => {
  const text = 'var helpers = { a: 1 };\nhelpers.b = function () {};\nother.c = 2;\nmodule.exports = helpers;'
  const facts = factsOf(text)
  assert.deepEqual(facts.exports.assignments.map((a) => [a.value.kind, a.value.name, a.value.declaration]), [['identifier', 'helpers', declared(facts, text, 'helpers').id]])
  assert.deepEqual(facts.exports.members.map((m) => [m.name, m.source, m.value.kind, m.start]), [
    ['a', 'object', 'other', offsetOf(text, 'a: 1')],
    ['b', 'extension', 'function', offsetOf(text, 'b = function')]
  ])
})

test('declarations, scopes and the declaration of each use', () => {
  const text = [
    'var top = 1;',
    'let blockScoped = 2;',
    'const constant = 3;',
    'function outer(param, { destructured }, ...rest) {',
    '    use(hoisted);',
    '    if (param) {',
    '        var hoisted = 1;',
    '        let inner = 2;',
    '        inner++;',
    '    }',
    '    try { risky(); } catch (err) { report(err); }',
    '    var named = function self() { return self; };',
    '    return inner;',
    '}',
    'class Shape {}',
    'outer(top, blockScoped, constant, Shape, later());',
    'function later() {}'
  ].join('\n')
  const facts = factsOf(text)
  const kinds = facts.declarations.map((d) => [d.name, d.kind])
  for (const expected of [
    ['top', 'var'], ['blockScoped', 'let'], ['constant', 'const'], ['outer', 'function'], ['param', 'param'],
    ['destructured', 'param'], ['rest', 'param'], ['hoisted', 'var'], ['inner', 'let'], ['err', 'catch'],
    ['named', 'var'], ['self', 'function'], ['Shape', 'class'], ['later', 'function']
  ]) {
    assert.ok(kinds.some(([name, kind]) => name === expected[0] && kind === expected[1]), `${expected[0]} is a ${expected[1]}`)
  }
  // Positions: the name where it is declared, and the whole declaring construct.
  const outer = declared(facts, text, 'outer')
  assert.deepEqual(outer.node, { start: offsetOf(text, 'function outer'), end: offsetOf(text, '    return inner;\n}') + '    return inner;\n}'.length })
  assert.equal(outer.init?.type, 'FunctionDeclaration')
  const top = declared(facts, text, 'top')
  assert.deepEqual(top.node, rangeOf(text, 'top = 1'))
  assert.equal(top.init?.type, 'Literal')

  const hoisted = declared(facts, text, 'hoisted', 1)
  const functionScope = facts.scopes[hoisted.scope]
  assert.equal(functionScope.kind, 'function', '`var` belongs to the function, not the block')
  const paramScope = facts.scopes[declared(facts, text, 'param').scope]
  assert.equal(paramScope.kind, 'params')
  assert.equal(functionScope.parent, paramScope.id, 'the parameters’ scope holds the body’s')
  const inner = declared(facts, text, 'inner')
  assert.equal(facts.scopes[inner.scope].kind, 'block')
  assert.equal(facts.scopes[declared(facts, text, 'err', 0).scope].kind, 'catch')
  assert.equal(facts.scopes[declared(facts, text, 'top').scope].kind, 'module')

  assert.equal(resolved(facts, text, 'hoisted', 0), hoisted.id, 'a use before a `var` sees it')
  assert.equal(resolved(facts, text, 'inner', 1), inner.id)
  assert.equal(resolved(facts, text, 'inner', 2), null, 'a block’s `let` is not seen outside it')
  assert.equal(resolved(facts, text, 'err', 1), declared(facts, text, 'err', 0).id)
  assert.equal(resolved(facts, text, 'self', 1), declared(facts, text, 'self', 0).id)
  assert.equal(resolved(facts, text, 'later', 0), declared(facts, text, 'later', 1).id, 'a function is seen before its declaration')
  assert.equal(resolved(facts, text, 'Shape', 1), declared(facts, text, 'Shape').id)
  for (const global of ['use', 'risky', 'report']) assert.equal(resolved(facts, text, global, 0), null)
  const increment = facts.references.find((r) => r.start === offsetOf(text, 'inner++'))
  assert.equal(increment?.write, true)

  // Lookups by offset.
  assert.equal(referenceAt(facts, offsetOf(text, 'hoisted') + 2)?.declaration, hoisted.id)
  assert.equal(declarationAt(facts, offsetOf(text, 'destructured') + 1)?.kind, 'param')
  const blockScope = scopeAt(facts, offsetOf(text, 'let inner'))
  assert.equal(blockScope.kind, 'block')
  assert.equal(facts.scopes[blockScope.parent as number].kind, 'function')
})

test('shadowing, and which uses write', () => {
  const text = 'var x = 1;\nfunction f(x) { x = 2; return x; }\nx;\na = 1; [b, c] = d; ({ e } = g); for (h in k) {}'
  const facts = factsOf(text)
  const outer = declared(facts, text, 'x', 0)
  const param = declared(facts, text, 'x', 1)
  assert.equal(param.kind, 'param')
  assert.equal(resolved(facts, text, 'x', 2), param.id)
  assert.equal(resolved(facts, text, 'x', 3), param.id)
  assert.equal(resolved(facts, text, 'x', 0, 'x;\na ='), outer.id)
  const writes = facts.references.filter((r) => r.write).map((r) => r.name)
  assert.deepEqual(writes, ['x', 'a', 'b', 'c', 'e', 'h'])
  const reads = facts.references.filter((r) => !r.write).map((r) => r.name)
  assert.deepEqual(reads, ['x', 'x', 'd', 'g', 'k'])
})

test('Object.assign as a statement exports onto module.exports, exports, or an exported name', () => {
  const ontoModule = factsOf('Object.assign(module.exports, { a: 1 });\nObject.assign(exports, { b: function () {} });')
  assert.deepEqual(ontoModule.exports.members.map((m) => [m.name, m.source, m.value.kind]), [
    ['a', 'assign', 'other'],
    ['b', 'assign', 'function']
  ])
  const text = 'var base = module.superModule;\nObject.assign(base, { extra: function () {} });\nmodule.exports = base;'
  const extended = factsOf(text)
  assert.deepEqual(extended.exports.members.map((m) => [m.name, m.source, m.start]), [['extra', 'assign', offsetOf(text, 'extra')]])
  const local = factsOf('var other = {};\nObject.assign(other, { hidden: 1 });\nmodule.exports = {};')
  assert.deepEqual(local.exports.members, [], 'a name that is not exported exports nothing')
  const assigned = factsOf('module.exports = Object.assign({}, { once: 1 });')
  assert.deepEqual(assigned.exports.members.map((m) => m.name), ['once'], 'the value of an export is counted once')
})

test('module and exports are the module’s only when no local name shadows them', () => {
  const shadowed = factsOf('function f(exports, module) { exports.x = 1; module.exports = {}; module.exports.y = 2; }\nexports.z = 3;')
  assert.deepEqual(shadowed.exports.members.map((m) => m.name), ['z'])
  assert.deepEqual(shadowed.exports.assignments, [])
})

test('a default parameter sees earlier parameters and outer names, not later ones or the body', () => {
  const text = 'var x = 1, b = 0;\nfunction f(a = x, c = a, d = b, b) { var x = 2; return x + a; }'
  const facts = factsOf(text)
  const byKind = (name: string, kind: string) => facts.declarations.find((d) => d.name === name && d.kind === kind) as Declaration
  const outerX = byKind('x', 'var')
  const innerX = facts.declarations.filter((d) => d.name === 'x')[1]
  const paramA = byKind('a', 'param')
  const outerB = byKind('b', 'var')
  assert.equal(outerX.start, offsetOf(text, 'x = 1'))
  assert.equal(innerX.start, offsetOf(text, 'x = 2'))
  assert.equal(resolved(facts, text, 'x', 0, 'x, c ='), outerX.id, 'a default sees the outer x, not the body’s var')
  assert.equal(resolved(facts, text, 'a', 0, 'a, d'), paramA.id, 'an earlier parameter')
  assert.equal(resolved(facts, text, 'b', 0, 'b, b)'), outerB.id, 'a later parameter is not seen: the outer b')
  assert.equal(resolved(facts, text, 'x', 0, 'x + a'), innerX.id, 'the body sees its own var')
  assert.equal(resolved(facts, text, 'a', 0, 'a; }'), paramA.id, 'and the parameters')
})

test('declarations keep their JSDoc', () => {
  const text = fixture('helper.js')
  const facts = factsOf(text)
  assert.match(declared(facts, text, 'splitLine').doc?.text ?? '', /@param \{string\} line/)
  assert.match(declared(facts, text, 'POSTCODE').doc?.text ?? '', /@type \{RegExp\}/)
  assert.match(declared(facts, text, 'isValid').doc?.text ?? '', /@returns \{boolean\}/)
  assert.equal(declared(facts, text, 'Logger').doc, undefined)
  const exported = facts.exports.members.find((m) => m.name === 'isValid')
  assert.match(exported?.doc?.text ?? '', /Whether a postcode is valid/)
})
