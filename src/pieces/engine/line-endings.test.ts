// Line endings: every fixture parsed with LF, CRLF and CR gives the same trees, problems and
// facts. Positions stay offsets of the text as given: with CRLF each one is shifted by the
// carriage returns before it, and with CR (one character for one) they are the same as with LF.
import { assert, test } from 'orca/testing'
import { fixture, SCRIPT_FIXTURES, TEMPLATE_FIXTURES } from './fixtures/read'
import { parseScript, parseTemplate, scriptFacts, templateScript, tokenize, walk, walkTemplate, type IsmlNode, type Problem, type ScriptFacts } from './index'

type Variant = { name: string; text: string; toLf: (offset: number) => number }

/** The fixture in LF, CRLF and CR, each with the map of its offsets to the LF ones. */
function variants(lf: string): Variant[] {
  const crlf = lf.replace(/\n/g, '\r\n')
  // In the CRLF text: how many carriage returns lie before each offset.
  const before = new Int32Array(crlf.length + 1)
  for (let i = 0; i < crlf.length; i++) before[i + 1] = before[i] + (crlf[i] === '\r' ? 1 : 0)
  return [
    { name: 'LF', text: lf, toLf: (offset) => offset },
    { name: 'CRLF', text: crlf, toLf: (offset) => offset - before[offset] },
    { name: 'CR', text: lf.replace(/\n/g, '\r'), toLf: (offset) => offset }
  ]
}

const problems = (list: Problem[], v: Variant) => list.map((p) => `${p.code}:${p.detail ?? ''}@${v.toLf(p.start)}-${v.toLf(p.end)}`)

function facts(f: ScriptFacts, v: Variant): string[] {
  return [
    ...f.declarations.map((d) => `decl ${d.name} ${d.kind} ${v.toLf(d.start)} scope ${f.scopes[d.scope].kind}`),
    ...f.references.map((r) => `use ${r.name} ${v.toLf(r.start)} -> ${r.declaration === null ? 'global' : f.declarations[r.declaration].name + '@' + v.toLf(f.declarations[r.declaration].start)}`),
    ...f.requires.map((r) => `require ${r.module} ${v.toLf(r.start)}-${v.toLf(r.end)} ${r.member ?? ''} ${r.binding ? JSON.stringify(r.binding.kind) : ''}`),
    ...f.exports.assignments.map((a) => `assignment ${a.value.kind} ${v.toLf(a.start)}-${v.toLf(a.end)}`),
    ...f.exports.members.map((m) => `member ${m.name} ${m.source} ${v.toLf(m.start)} ${m.doc ? 'doc' : ''}`),
    `superModule ${f.exports.superModule.uses.map((u) => v.toLf(u.start)).join(',')} ${f.exports.superModule.extended}`
  ]
}

function script(v: Variant): string[] {
  const parsed = parseScript(v.text)
  const out: string[] = []
  walk(parsed.program, (node) => out.push(`${node.type} ${v.toLf(node.start)}-${v.toLf(node.end)}`))
  out.push(...problems(parsed.problems, v))
  out.push(...parsed.comments.map((c) => `comment ${c.kind} ${v.toLf(c.start)}-${v.toLf(c.end)}`))
  out.push(...tokenize(v.text).tokens.map((t) => `token ${t.type} ${v.toLf(t.start)}-${v.toLf(t.end)} ${t.newlineBefore}`))
  out.push(...facts(scriptFacts(parsed.program), v))
  return out
}

function template(v: Variant): string[] {
  const parsed = parseTemplate(v.text)
  const out: string[] = []
  walkTemplate(parsed.document, (node: IsmlNode) => {
    let line = `${node.type} ${v.toLf(node.start)}-${v.toLf(node.end)}`
    if (node.type === 'Element') {
      line += ` ${node.name} open ${v.toLf(node.openEnd)} close ${node.close ? v.toLf(node.close.start) : '-'}`
      for (const a of node.attributes) line += ` [${a.name} ${v.toLf(a.start)}-${v.toLf(a.end)} ${a.value ? `${v.toLf(a.value.contentStart)}-${v.toLf(a.value.contentEnd)} ${a.value.closed}` : ''}]`
    }
    if (node.type === 'Expression' || node.type === 'IsScript') line += ` code ${v.toLf(node.codeStart)}-${v.toLf(node.codeEnd)}`
    out.push(line)
  })
  out.push(...problems(parsed.problems, v))
  out.push(...parsed.document.modules.map((m) => `module ${m.name} ${v.toLf(m.start)}`))
  const js = templateScript(v.text, parsed.document)
  for (const fragment of js.fragments) walk(fragment.node, (node) => out.push(`js ${node.type} ${v.toLf(node.start)}-${v.toLf(node.end)}`))
  out.push(...problems(js.problems, v))
  out.push(...facts(js.facts, v))
  return out
}

test('every script fixture reads the same with LF, CRLF and CR', () => {
  for (const name of SCRIPT_FIXTURES) {
    const [lf, ...others] = variants(fixture(name))
    const expected = script(lf)
    assert.ok(expected.length > 20, name)
    for (const other of others) assert.deepEqual(script(other), expected, `${name} with ${other.name}`)
  }
})

test('every template fixture reads the same with LF, CRLF and CR', () => {
  for (const name of TEMPLATE_FIXTURES) {
    const [lf, ...others] = variants(fixture(name))
    const expected = template(lf)
    assert.ok(expected.length > 20, name)
    for (const other of others) assert.deepEqual(template(other), expected, `${name} with ${other.name}`)
  }
})

test('a template literal reads CRLF and CR as LF, an escaped \\r stays', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const { program } = parseScript(`x = \`a${eol}b\\r\``)
    let cooked = ''
    walk(program, (node) => {
      if (node.type === 'TemplateElement') cooked = node.cooked
    })
    assert.equal(cooked, 'a\nb\r', JSON.stringify(eol))
  }
})
