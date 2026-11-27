// The strict XML reader of form definitions and the JSON reader of `steptypes.json`: each fault
// at its place, what they accept read whole, and no input that makes them throw or recurse; and
// the problems' modules are pure, as the editor of phase 7 loads them in its frame.
import { assert, test } from 'orca/testing'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_JSON_NESTING, member, readJson } from './json'
import { readXml, type XmlFault } from './xml'
import { formUses } from './forms'
import { stepTypesUses } from './steptypes'

test('well-formed XML is read into its elements, attributes decoded, with the ranges of their names and values', () => {
  const text = '<?xml version="1.0"?>\n<!-- a form -->\n<form a="1 &amp; 2" b=\'x\'>\n  <field formid="f"/>\n  <group formid="g"><![CDATA[ <raw> ]]><field formid="h"></field></group>\n</form>\n'
  const read = readXml(text)
  assert.equal(read.fault, null)
  const root = read.root
  assert.ok(root)
  assert.equal(root.name, 'form')
  assert.deepEqual(
    root.attributes.map((a) => [a.name, a.value, text.slice(a.valueStart, a.valueEnd)]),
    [
      ['a', '1 & 2', '1 &amp; 2'],
      ['b', 'x', 'x']
    ]
  )
  assert.deepEqual(
    root.children.map((child) => [child.name, child.children.length]),
    [
      ['field', 0],
      ['group', 1]
    ]
  )
  assert.equal(text.slice(root.children[1].nameStart, root.children[1].nameEnd), 'group')
})

test('each fault of XML is told at its place, the first one only', () => {
  const cases: [string, XmlFault, string][] = [
    ['<form><field></form>', 'mismatched_tag', '</form>'],
    ['<form><field>', 'unclosed_tag', '<field'],
    ['<form></field></form>', 'mismatched_tag', '</field>'],
    ['<form/></form>', 'stray_close', '</form>'],
    ['<form a=1/>', 'unquoted_value', '1'],
    ['<form a="1" a="2"/>', 'duplicate_attribute', 'a'],
    ['<form a="1"b="2"/>', 'bad_attribute', 'b'],
    ['<form a="x<y"/>', 'lt_in_value', '<'],
    ['<form>a & b</form>', 'bad_entity', '&'],
    ['<form a="&nbsp;"/>', 'bad_entity', '&'],
    ['', 'no_root', ''],
    ['<form/>text', 'outside_root', 't'],
    ['<form/><form/>', 'outside_root', '<form'],
    ['<form><!-- open </form>', 'unclosed_comment', '<!--'],
    ['<form><![CDATA[ open </form>', 'unclosed_cdata', '<![CDATA['],
    ['<?xml version="1.0"<form/>', 'unclosed_declaration', '<?'],
    ['<1form/>', 'bad_name', '<']
  ]
  for (const [text, reason, at] of cases) {
    const read = readXml(text)
    assert.ok(read.fault, text)
    assert.equal(read.fault.reason, reason, text)
    assert.equal(text.slice(read.fault.start, read.fault.end), at, text)
  }
})

test('the XML reader is linear and never throws: deep nesting, long attributes, broken input', () => {
  const deep = '<a>'.repeat(50_000) + '</a>'.repeat(50_000)
  const started = performance.now()
  assert.equal(readXml(deep).fault, null)
  assert.ok(performance.now() - started < 2_000)
  for (const text of ['<', '<a', '<a b', '<a b=', '<a b="', '</', '<!', '<!--', '<![CDATA[', '<?', '&', '<a>&#xZZ;</a>', '<a b="1" />junk']) assert.ok(readXml(text).fault, text)
})

test('JSON is read with the place of each value and key; each fault is told at its place', () => {
  const text = '{ "a": [1, -2.5e3, true, null, "x\\n"], "b": { "c": "d" } }'
  const read = readJson(text)
  assert.equal(read.fault, null)
  const a = member(read.value, 'a')
  assert.ok(a && a.value.kind === 'array')
  assert.deepEqual(
    a.value.items.map((item) => item.kind),
    ['number', 'number', 'boolean', 'null', 'string']
  )
  assert.equal(text.slice(a.keyStart, a.keyEnd), 'a')
  const c = member(member(read.value, 'b')?.value, 'c')
  assert.ok(c && c.value.kind === 'string')
  assert.equal(c.value.value, 'd')
  const cases: [string, string, number][] = [
    ['{ "a": 1, }', 'unexpected', 10],
    ['[1, 2', 'unclosed', 0],
    ['{ "a" 1 }', 'unexpected', 6],
    ['"\u0001"', 'bad_string', 0],
    ['-x', 'bad_number', 0],
    ['{} []', 'trailing', 3],
    ['', 'unexpected', 0],
    ['{ a: 1 }', 'unexpected', 2]
  ]
  for (const [input, reason, at] of cases) {
    const found = readJson(input)
    assert.ok(found.fault, input)
    assert.equal(found.fault.reason, reason, input)
    assert.equal(found.fault.start, at, input)
  }
  // Whatever JSON.parse accepts, the reader accepts; deep input is refused, never overflows.
  for (const valid of ['0', '"é"', '[[[]]]', '{"":{"":[]}}', ' \n\t{ } ', '1e-7']) assert.equal(readJson(valid).fault, null, valid)
  assert.equal(readJson('['.repeat(MAX_JSON_NESTING + 1)).fault?.reason, 'too_deep')
  assert.equal(readJson('['.repeat(100_000)).fault?.reason, 'too_deep')
})

test('a form reads only the schema it knows: other namespaces are skipped, attributes of each element checked', () => {
  const text =
    '<form xmlns="http://www.demandware.com/xml/form/2008-04-19" xmlns:x="urn:other" x:note="n">\n' +
    '  <x:extra formid="a" anything="1"><unknown/></x:extra>\n' +
    '  <field formid="a" type="string" x:hint="h" lable="typo" />\n' +
    '  <field formid="b" type="string"><options optionid-binding="ID"><option optionid="1" label="one" value="1" default="true"/></options></field>\n' +
    '  <list formid="items"><field formid="a" type="string"/><field formid="a" type="string"/></list>\n' +
    '</form>\n'
  const uses = formUses(text)
  assert.deepEqual(
    uses.own.map((each) => [each.code, text.slice(each.start, each.end), each.args]),
    [
      ['form_unknown_attribute', 'lable', { attribute: 'lable', element: 'field' }],
      ['form_duplicate_id', 'a', { id: 'a' }]
    ]
  )
  // Not a form: told once, at the root, and nothing else read.
  assert.deepEqual(
    formUses('<metadata><field/></metadata>').own.map((each) => each.code),
    ['form_unknown_element']
  )
})

test('step types: the shapes the platform takes, one step or a list, and what each lacks', () => {
  const one = stepTypesUses('{ "step-types": { "script-module-step": { "@type-id": "a", "module": "x/cartridge/y.js" } } }')
  assert.deepEqual(one.own, [])
  assert.deepEqual(
    one.ids.map((each) => each.id),
    ['a']
  )
  assert.deepEqual(
    stepTypesUses('{ "steps": [] }').own.map((each) => [each.code, each.args]),
    [['steptypes_missing_key', { key: 'step-types' }]]
  )
  assert.deepEqual(
    stepTypesUses('{ "step-types": { "script-module-step": [ { "@type-id": "", "module": 3 }, 4 ] } }').own.map((each) => each.args.key),
    ['@type-id', 'module', '@type-id']
  )
})

test('the problems modules import nothing but each other and the engine’s pure modules: no Node, no Orca', () => {
  const here = fileURLToPath(new URL('./', import.meta.url))
  const modules = readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'testing.ts')
  assert.ok(modules.length >= 10, modules.join(', '))
  for (const module of modules) {
    const source = readFileSync(join(here, module), 'utf8')
    const imports = [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const specifier of imports) {
      const pure = specifier.startsWith('./') || /^\.\.\/(js|isml|query)\//.test(specifier) || specifier === '../dw/index' || (/^\.\.\/checkout\//.test(specifier) && !/\/(disk|git|testing)$/.test(specifier))
      assert.ok(pure, `${module} imports ${specifier}`)
    }
    assert.ok(!/\brequire\(|process\.|globalThis\.orca/.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")), `${module} uses a runtime global`)
  }
})
