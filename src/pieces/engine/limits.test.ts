// Inputs that once broke the syntax layer, from the review of phase 6.2: a tree as deep as its
// input, nesting past the parsers' bounds, and runs of unclosed constructs that cost quadratic
// time. Each must finish, keep what follows, and take time linear in its size.
import { assert, test } from 'orca/testing'
import { parseScript, parseTemplate, scriptFacts, templateScript, walk } from './index'

test('a 20,000-link else-if chain: facts walk it without recursion, and see every name', () => {
  let text = 'if (a) {}'
  for (let i = 0; i < 20000; i++) text += ` else if (c${i}) { use${i}(); }`
  const { program, problems } = parseScript(text)
  assert.deepEqual(problems, [])
  const facts = scriptFacts(program)
  const names = new Set(facts.references.map((r) => r.name))
  assert.ok(names.has('use0') && names.has('use19999') && names.has('c19999'))
  let depth = 0
  walk(program, (node) => {
    if (node.type === 'IfStatement') depth++
  })
  assert.equal(depth, 20001, 'the shared walker reaches the end of the chain')
})

test('nested patterns past the bound: reported once, and the statements after them are kept', () => {
  const object = 'var keep = 1;\nvar ' + '{a:'.repeat(4000) + 'b' + '}'.repeat(4000) + ' = c;\nvar alsoKept = 2;'
  const array = 'var keep = 1;\nfunction f(' + '['.repeat(4000) + 'x' + ']'.repeat(4000) + ') {}\nvar alsoKept = 2;'
  for (const text of [object, array]) {
    const { program, problems } = parseScript(text)
    assert.deepEqual(problems.filter((p) => p.code === 'too_deep').length, 1)
    assert.ok(!problems.some((p) => p.code === 'internal_error'))
    const declared = scriptFacts(program).declarations.map((d) => d.name)
    assert.ok(declared.includes('keep') && declared.includes('alsoKept'), declared.join(','))
  }
})

test('a 100,000-link chain past the bound reports too_deep once', () => {
  const { problems } = parseScript('x = a' + ' ** a'.repeat(100000) + ';\ny = 1;')
  assert.equal(problems.filter((p) => p.code === 'too_deep').length, 1)
  assert.ok(problems.length < 20, `${problems.length} problems`)
})

/** The best of three runs, in milliseconds. */
function time(run: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    run()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

test('runs of unclosed constructs take linear time', () => {
  // Each of these took seconds to minutes when every construct searched to the end of the text;
  // linear, each takes tens of milliseconds. The bound leaves room for a busy machine.
  const BOUND = 2000
  const template = (label: string, text: string, withScript = false) => {
    const took = time(() => {
      const parsed = parseTemplate(text)
      if (withScript) templateScript(text, parsed.document)
    })
    console.log(`${label}: ${took.toFixed(0)} ms`)
    assert.ok(took < BOUND, `${label}: ${took.toFixed(0)} ms`)
  }
  template('50,000 unclosed <!--', '<!--'.repeat(50000))
  template('30,000 unclosed <iscomment>', '<iscomment>x\n'.repeat(30000))
  template('20,000 unclosed <isscript>', '<isscript>var a = 1\n'.repeat(20000), true)
  template('30,000 unclosed <script>', '<script>x\n'.repeat(30000))
  template('20,000 ${/*}', '${/*}\n'.repeat(20000), true)
  template('20,000 unclosed ${', '<p>${a\n'.repeat(20000), true)
  template('16,000 loops', '<isloop items="${list}" var="v">${v.name}</isloop>\n'.repeat(16000), true)
  template('16,000 <isset> of one name', '<isset name="v" value="${v}" scope="page"/>${v}\n'.repeat(16000), true)
  const script = (label: string, text: string) => {
    const took = time(() => scriptFacts(parseScript(text).program))
    console.log(`${label}: ${took.toFixed(0)} ms`)
    assert.ok(took < BOUND, `${label}: ${took.toFixed(0)} ms`)
  }
  script('20,000 unclosed comments in strings', "a('/*');\n".repeat(20000))
  script('20,000 var of one name', 'var v = v + 1;\n'.repeat(20000))
})

/** `prefix`, then `unit` repeated until the text holds `size` characters, then `suffix`. */
const build = (size: number, unit: string, prefix = '', suffix = '') => prefix + unit.repeat(Math.max(1, Math.ceil((size - prefix.length - suffix.length) / unit.length))) + suffix

test('a 1 MB line of values with an unclosed ${ parses in well under a second', () => {
  const text = build(1_000_000, 'b="${(x" ', '<a ', '>')
  const took = time(() => templateScript(text, parseTemplate(text).document))
  console.log(`1 MB line of b="\${(x": ${took.toFixed(0)} ms`)
  assert.ok(took < 1000, `${took.toFixed(0)} ms`)
  const tags = build(1_000_000, '<a b="${(x">')
  const tagsTook = time(() => templateScript(tags, parseTemplate(tags).document))
  console.log(`1 MB line of <a b="\${(x">: ${tagsTook.toFixed(0)} ms`)
  assert.ok(tagsTook < 1000, `${tagsTook.toFixed(0)} ms`)
})

test('no input shape grows worse than linear', () => {
  // Each shape at 64 KB and at four times that. Linear work grows about 4 times, quadratic 16:
  // the bound (8 times, plus room for a busy machine and its garbage collector) tells them apart.
  const templates: [string, string, string?, string?][] = [
    ['values with an unclosed ${ on one line', 'b="${(x" ', '<a ', '>'],
    ['tags with an unclosed ${ in a value', '<a b="${(x">'],
    ['unclosed braces closed at the end', 'b="${{x" ', '<a ', '}">'],
    ['values with an unclosed ${ on many lines', 'b="${{x"\n', '<a ', '>'],
    ['unclosed ${{ in text', '${{', '<p>'],
    ['unclosed ${ on many lines', '${(x\n'],
    ['unclosed template literals in ${', '${`'],
    ['unclosed regex literals in ${', '${(/x'],
    ['comments in ${', '${/*}\n'],
    ['unclosed values on lines without a tag', 'x<a b="x\n'],
    ['ISML tags in values', '<a b="<isif c=\'${x}\'>'],
    ['unclosed doctypes', '<!doctype x'],
    ['stray end tags under deep nesting', '</span>', '<div>'.repeat(300)],
    ['unclosed start tags', '<a b'],
    ['attributes of one tag', 'x ', '<a ', '>'],
    ['unclosed comments', '<!--'],
    ['unclosed <isscript>', '<isscript>a(\n'],
    ['stray ISML end tags', '</isif>'],
    ['isset of one name', '<isset name="v" value="${v}"/>${v}\n']
  ]
  const scripts: [string, string, string?][] = [
    ['broken statements on one line', 'a b '],
    ['unclosed calls', 'f('],
    ['objects missing commas', 'x = {a: 1 b: 2}\n'],
    ['unterminated templates', '`${'],
    ['comments in strings', "a('/*');\n"],
    ['an else-if chain', ' else if (c) { u(); }', 'if (a) {}'],
    ['many exports of one name', 'module.exports = base;\nbase.x = function () {};\nObject.assign(base, { y: 1 });\n', 'var base = {};\n'],
    ['one name declared many times', 'var v = v + 1;\n']
  ]
  const SIZE = 64_000
  const check = (label: string, run: (text: string) => void, make: (size: number) => string) => {
    const small = make(SIZE)
    const large = make(SIZE * 4)
    const tSmall = time(() => run(small))
    const tLarge = time(() => run(large))
    console.log(`${label}: ${tSmall.toFixed(1)} ms, ×4: ${tLarge.toFixed(1)} ms`)
    assert.ok(tLarge < tSmall * 8 + 50, `${label}: ${tSmall.toFixed(1)} ms then ${tLarge.toFixed(1)} ms`)
  }
  for (const [label, unit, prefix, suffix] of templates) {
    check(label, (text) => templateScript(text, parseTemplate(text).document), (size) => build(size, unit, prefix, suffix))
  }
  for (const [label, unit, prefix] of scripts) {
    check(label, (text) => scriptFacts(parseScript(text).program), (size) => build(size, unit, prefix))
  }
})

test('a run of sibling loops still gives each fragment its own loop', () => {
  const text = '<isloop items="${a}" var="x">${x}</isloop><isloop items="${b}" var="x"><isloop items="${x}" var="y">${x}${y}</isloop></isloop>${x}'
  const { facts } = templateScript(text)
  const loops = facts.declarations.filter((d) => d.kind === 'isloop')
  assert.deepEqual(loops.map((d) => d.name), ['x', 'x', 'y'])
  const target = (offset: number) => {
    const reference = facts.references.find((r) => r.start === offset) as { declaration: number | null }
    return reference.declaration
  }
  const uses = facts.references.filter((r) => r.name === 'x').map((r) => r.start)
  // `${a}` items, first loop's `${x}`, `${x}` as items of the inner loop, inner `${x}`, after all.
  assert.equal(target(uses[0]), loops[0].id)
  assert.equal(target(uses[1]), loops[1].id, 'the inner loop’s items see the outer loop’s x')
  assert.equal(target(uses[2]), loops[1].id)
  assert.equal(target(uses[3]), null)
})
