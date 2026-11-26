// The JavaScript of a template: every `${…}` and `<isscript>` parsed in template positions, and
// the facts of the template as a whole, where a name is seen only after it is declared.
import { assert, test } from 'orca/testing'
import { fixture, offsetOf, rangeOf } from '../fixtures/read'
import type * as AST from '../js/ast'
import type { ScriptFacts } from '../js/facts'
import { templateScript } from './embedded'

const range = (node: { start: number; end: number }) => ({ start: node.start, end: node.end })

/** The declaration (id or null) of the use of `name` that begins the `nth` occurrence of `snippet`. */
function resolved(facts: ScriptFacts, text: string, name: string, nth = 0, snippet = name): number | null {
  const start = offsetOf(text, snippet, nth) + snippet.indexOf(name)
  const reference = facts.references.find((r) => r.start === start && r.name === name)
  if (!reference) throw new Error(`no use of ${name} at ${start}`)
  return reference.declaration
}

test('every ${…} and <isscript> of a template is parsed, in template positions', () => {
  const text = fixture('template.isml')
  const script = templateScript(text)
  assert.deepEqual(script.problems, [])
  assert.equal(script.fragments.filter((f) => f.kind === 'script').length, 1)
  assert.equal(script.fragments.filter((f) => f.kind === 'expression').length, 19)
  for (let i = 1; i < script.fragments.length; i++) assert.ok(script.fragments[i - 1].start < script.fragments[i].start, 'in source order')
  const name = script.fragments.find((f) => text.slice(f.start, f.end) === 'pdict.product.productName')
  assert.ok(name)
  assert.equal(name.node.type, 'MemberExpression')
  assert.deepEqual(range(name.node), rangeOf(text, 'pdict.product.productName'))
  assert.deepEqual(range((name.node as AST.MemberExpression).property), rangeOf(text, 'productName'))
  const block = script.fragments.find((f) => f.kind === 'script')
  assert.ok(block && block.node.type === 'Program')
  assert.deepEqual(block.node.body.map((s) => range(s)), [
    rangeOf(text, "var URLUtils = require('dw/web/URLUtils');"),
    rangeOf(text, "var assets = require('*/cartridge/scripts/assets');"),
    rangeOf(text, "assets.addJs('/js/productDetail.js');")
  ])
  const nested = script.fragments.find((f) => text.slice(f.start, f.end).startsWith('Resource.msgf'))
  assert.equal(nested?.node.type, 'CallExpression')
  const lastArgument = (nested?.node as AST.CallExpression).arguments[3]
  assert.deepEqual(range(lastArgument), rangeOf(text, "{a: {b: '}'}}"))
})

test('a require in <isscript> binds a name the expressions after it use; the template’s own names too', () => {
  const text = fixture('template.isml')
  const { facts } = templateScript(text)
  assert.deepEqual(facts.requires.map((r) => [r.module, r.argument]), [
    ['dw/web/URLUtils', rangeOf(text, "'dw/web/URLUtils'")],
    ['*/cartridge/scripts/assets', rangeOf(text, "'*/cartridge/scripts/assets'")]
  ])
  const urlUtils = facts.declarations.find((d) => d.name === 'URLUtils')
  assert.ok(urlUtils)
  assert.deepEqual([urlUtils.kind, range(urlUtils)], ['var', rangeOf(text, 'URLUtils', 0)])
  assert.equal(facts.requires[0].binding?.kind === 'name' && facts.requires[0].binding.declaration, urlUtils.id)
  assert.equal(resolved(facts, text, 'URLUtils', 0, 'URLUtils.url('), urlUtils.id)
  assert.equal(resolved(facts, text, 'URLUtils', 0, 'URLUtils.staticURL('), urlUtils.id)
  const showPrice = facts.declarations.find((d) => d.name === 'showPrice')
  assert.ok(showPrice)
  assert.deepEqual([showPrice.kind, range(showPrice)], ['isset', rangeOf(text, 'showPrice')])
  assert.equal(resolved(facts, text, 'showPrice', 0, '${showPrice}'), showPrice.id)
  const variant = facts.declarations.find((d) => d.name === 'variant')
  const loopState = facts.declarations.find((d) => d.name === 'loopState')
  assert.ok(variant && loopState)
  assert.deepEqual(range(variant), { start: offsetOf(text, 'var="variant"') + 5, end: offsetOf(text, 'var="variant"') + 12 })
  assert.equal(variant.kind, 'isloop')
  assert.equal(facts.scopes[variant.scope].kind, 'loop')
  assert.equal(resolved(facts, text, 'variant', 0, 'variant.id'), variant.id)
  assert.equal(resolved(facts, text, 'loopState', 0, 'loopState.first'), loopState.id)
  assert.equal(resolved(facts, text, 'pdict', 0, 'pdict.product.price !=='), null, 'pdict is a global')
})

test('in a template, a name is seen only after it is declared', () => {
  const text = '${early}<isscript>var early = require("x");</isscript>${early}\n<isset name="a" value="${1}"/><isset name="a" value="${a + 1}"/>${a}'
  const { facts, problems } = templateScript(text)
  assert.deepEqual(problems, [])
  const early = facts.declarations.find((d) => d.name === 'early')
  assert.ok(early)
  assert.equal(resolved(facts, text, 'early', 0), null, 'used before the script that declares it')
  assert.equal(resolved(facts, text, 'early', 2), early.id)
  const [first, second] = facts.declarations.filter((d) => d.name === 'a')
  assert.equal(resolved(facts, text, 'a', 0, 'a + 1'), first.id, 'an <isset> value sees the earlier one')
  assert.equal(resolved(facts, text, 'a', 0, 'a}'), second.id)
})

test('the variables of an <isloop> are seen inside it, not outside or in its items', () => {
  const text = '<isloop items="${item}" var="item" status="state">${item.name}${state.index}</isloop>${item}'
  const { facts } = templateScript(text)
  const item = facts.declarations.find((d) => d.name === 'item')
  assert.ok(item)
  assert.equal(resolved(facts, text, 'item', 0, '${item}'), null, 'not in its own items')
  assert.equal(resolved(facts, text, 'item', 0, 'item.name'), item.id)
  assert.equal(resolved(facts, text, 'item', 1, '${item}'), null, 'not after the loop')
  assert.equal(resolved(facts, text, 'state', 0, 'state.index'), facts.declarations.find((d) => d.name === 'state')?.id)
})

test('a broken template: script problems in template positions, and the names it declared still bind', () => {
  const text = fixture('broken.isml')
  const { facts, problems, fragments } = templateScript(text)
  assert.deepEqual(problems.map((p) => [p.code, p.detail, p.start]), [['expected', ')', offsetOf(text, '<span>${x}')]])
  const x = facts.declarations.find((d) => d.name === 'x')
  assert.ok(x)
  assert.deepEqual(range(x), { start: offsetOf(text, 'var x') + 4, end: offsetOf(text, 'var x') + 5 })
  assert.equal(resolved(facts, text, 'x', 0, '${x}'), x.id)
  assert.equal(facts.requires[0].module, 'dw/util/StringUtils')
  assert.ok(fragments.every((f) => f.start <= f.end && f.end <= text.length))
})

test('comments inside fragments keep template positions', () => {
  const text = '<p>${a /* note */ + b}</p><isscript>\n/** The total. */\nvar total = 1; // done\n</isscript>'
  const { comments, facts } = templateScript(text)
  assert.deepEqual(comments.map((c) => [c.kind, range(c)]), [
    ['block', rangeOf(text, '/* note */')],
    ['doc', rangeOf(text, '/** The total. */')],
    ['line', rangeOf(text, '// done')]
  ])
  assert.match(facts.declarations.find((d) => d.name === 'total')?.doc?.text ?? '', /The total/)
})
