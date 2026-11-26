// The syntax layer on any input: the parsers never throw, on the fixtures and on 2,000 seeded
// mutations of them (truncations, deletions, duplications, swaps, stray tokens), and every node
// they return has positions inside the text and inside its parent. Then the speed on a large
// generated script, and that the modules stay pure (the editor loads them in a frame).
import { assert, test } from 'orca/testing'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { largeScript, mutate, seeded } from './fixtures/generate'
import { forEachChild, parseExpression, parseScript, parseTemplate, scriptFacts, templateScript, tokenize, type IsmlNode, type Node, type Problem } from './index'

const HERE = new URL('./', import.meta.url)
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, HERE), 'utf8')
const SCRIPTS = ['controller.js', 'model.js', 'shapes.js', 'helper.js', 'broken.js', 'truncated.js'].map(fixture)
const TEMPLATES = ['template.isml', 'broken.isml'].map(fixture)

/** Every node of a JavaScript tree lies inside its parent, with `start <= end`; returns how many there are. */
function checkTree(node: Node, low: number, high: number, where: string): number {
  assert.ok(node.start <= node.end, `${where}: ${node.type} ends before it starts`)
  assert.ok(low <= node.start && node.end <= high, `${where}: ${node.type} ${node.start}-${node.end} outside ${low}-${high}`)
  let count = 1
  forEachChild(node, (child) => {
    count += checkTree(child, node.start, node.end, where)
  })
  return count
}

function checkProblems(problems: Problem[], length: number, where: string): void {
  for (const problem of problems) {
    assert.ok(0 <= problem.start && problem.start <= problem.end && problem.end <= length, `${where}: problem ${problem.code} at ${problem.start}-${problem.end}`)
  }
}

/** Every node of a template lies inside its parent; attributes and values inside their tag. */
function checkTemplate(nodes: readonly IsmlNode[], low: number, high: number, where: string): void {
  for (const node of nodes) {
    assert.ok(low <= node.start && node.start <= node.end && node.end <= high, `${where}: ${node.type} ${node.start}-${node.end} outside ${low}-${high}`)
    if (node.type === 'Element') {
      assert.ok(node.nameStart <= node.nameEnd && node.nameEnd <= node.openEnd && node.openEnd <= node.end, `${where}: element ${node.name} tag range`)
      for (const attribute of node.attributes) {
        assert.ok(node.start <= attribute.start && attribute.end <= node.openEnd, `${where}: attribute ${attribute.name} outside its tag`)
        if (attribute.value) {
          assert.ok(attribute.value.contentStart <= attribute.value.contentEnd, `${where}: attribute value range`)
          checkTemplate(attribute.value.parts, attribute.value.start, attribute.value.end, where)
        }
      }
      checkTemplate(node.inTag, node.start, node.openEnd, where)
      checkTemplate(node.children, node.openEnd, node.end, where)
    } else if (node.type === 'Comment') {
      checkTemplate(node.children, node.start, node.end, where)
    } else if (node.type === 'Expression' || node.type === 'IsScript') {
      assert.ok(node.start <= node.codeStart && node.codeStart <= node.codeEnd && node.codeEnd <= node.end, `${where}: code range`)
    }
  }
}

function checkScript(text: string, where: string): void {
  const parsed = parseScript(text)
  checkTree(parsed.program, 0, text.length, where)
  checkProblems(parsed.problems, text.length, where)
  for (const comment of parsed.comments) assert.ok(0 <= comment.start && comment.end <= text.length, `${where}: comment range`)
  const facts = scriptFacts(parsed.program)
  for (const reference of facts.references) assert.equal(text.slice(reference.start, reference.end), reference.name, `${where}: reference ${reference.name}`)
  for (const declaration of facts.declarations) assert.equal(text.slice(declaration.start, declaration.end), declaration.name, `${where}: declaration ${declaration.name}`)
  tokenize(text)
  parseExpression(text)
}

function checkIsml(text: string, where: string): void {
  const parsed = parseTemplate(text)
  checkTemplate(parsed.document.children, 0, text.length, where)
  checkProblems(parsed.problems, text.length, where)
  const script = templateScript(text, parsed.document)
  for (const fragment of script.fragments) checkTree(fragment.node, fragment.start, fragment.end, `${where} fragment`)
  checkProblems(script.problems, text.length, where)
  for (const reference of script.facts.references) assert.equal(text.slice(reference.start, reference.end), reference.name, `${where}: reference ${reference.name}`)
}

test('the fixtures parse without throwing, with positions inside the text and inside each parent', () => {
  SCRIPTS.forEach((text, i) => checkScript(text, `script ${i}`))
  TEMPLATES.forEach((text, i) => {
    checkIsml(text, `template ${i}`)
    // A template read as a script, and a script as a template: nonsense, still no throw.
    checkScript(text, `template ${i} as script`)
  })
  SCRIPTS.forEach((text, i) => checkIsml(text, `script ${i} as template`))
})

test('2,000 seeded mutations of the fixtures never make a parser throw', () => {
  const random = seeded(20261126)
  const all = [...SCRIPTS.map((text) => ({ text, isml: false })), ...TEMPLATES.map((text) => ({ text, isml: true }))]
  for (let i = 0; i < 2000; i++) {
    const source = all[i % all.length]
    const text = mutate(source.text, random)
    const where = `mutation ${i}`
    try {
      if (source.isml) checkIsml(text, where)
      else checkScript(text, where)
    } catch (error) {
      // Name the input that broke it, so it can be turned into a test of its own.
      throw new Error(`${where} (${source.isml ? 'template' : 'script'}): ${(error as Error).message}\n--- input ---\n${text}`)
    }
  }
})

test('pathological input: deep nesting and long chains are bounded, not a stack overflow', () => {
  const inputs = [
    '('.repeat(20000),
    '['.repeat(20000),
    '{'.repeat(20000),
    'a = '.repeat(20000) + '1',
    '!'.repeat(20000) + 'a',
    'function f() {'.repeat(3000),
    'if (a) '.repeat(5000) + 'b()',
    'x' + '.y'.repeat(20000),
    'a' + ' + a'.repeat(20000),
    '`${'.repeat(5000),
    '/'.repeat(5000),
    '"'.repeat(5001),
    '\\u'.repeat(1000)
  ]
  for (const text of inputs) {
    const parsed = parseScript(text)
    assert.ok(Array.isArray(parsed.program.body))
    checkProblems(parsed.problems, text.length, text.slice(0, 20))
    scriptFacts(parsed.program)
  }
  const deep = parseScript('('.repeat(20000))
  assert.ok(deep.problems.some((p) => p.code === 'too_deep'))
  const chain = parseScript('if (a) b(); ' + 'else if (a) b(); '.repeat(5000) + 'else c();')
  assert.deepEqual(chain.problems, [], 'a long else-if chain is read in a loop, never too deep')
  for (const text of ['<isif condition="${'.repeat(3000), '<div '.repeat(5000), '<!--'.repeat(3000), '${{'.repeat(5000), '<isif>'.repeat(5000)]) {
    const parsed = parseTemplate(text)
    checkTemplate(parsed.document.children, 0, text.length, text.slice(0, 20))
    templateScript(text, parsed.document)
  }
})

test('a 5,000-line script parses well under 100 ms', () => {
  const text = largeScript(5000)
  assert.ok(text.split('\n').length >= 5000)
  // Warm up on the fixtures, then time the large script a few times: the machine running the
  // tests may be busy, so the best run is what the parser costs.
  for (const fixtureText of SCRIPTS) scriptFacts(parseScript(fixtureText).program)
  const times: number[] = []
  let problems = -1
  for (let run = 0; run < 5; run++) {
    const started = performance.now()
    const parsed = parseScript(text)
    times.push(performance.now() - started)
    problems = parsed.problems.length
  }
  const factsStarted = performance.now()
  scriptFacts(parseScript(text).program)
  const factsTime = performance.now() - factsStarted
  const best = Math.min(...times)
  console.log(`parse of ${text.split('\n').length} lines (${text.length} characters): first ${times[0].toFixed(1)} ms, best ${best.toFixed(1)} ms; facts ${factsTime.toFixed(1)} ms`)
  assert.equal(problems, 0)
  assert.ok(best < 100, `best of 5 took ${best.toFixed(1)} ms`)
})

test('the syntax modules import nothing but each other: no Node, no Orca', () => {
  const ROOT = fileURLToPath(HERE)
  const modules = ['index.ts', ...readdirSync(new URL('js/', HERE)).map((f) => `js/${f}`), ...readdirSync(new URL('isml/', HERE)).map((f) => `isml/${f}`)].filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
  )
  assert.ok(modules.length >= 6)
  for (const module of modules) {
    const source = readFileSync(`${ROOT}/${module}`, 'utf8')
    const imports = [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const specifier of imports) assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `${module} imports ${specifier}`)
    for (const specifier of imports.filter((s) => s.startsWith('../'))) {
      assert.ok(!/\.\.\/\.\.\//.test(specifier) && !specifier.includes('/core/'), `${module} reaches outside the engine: ${specifier}`)
    }
    assert.ok(!/\brequire\(|process\.|globalThis\.orca/.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")), `${module} uses a runtime global`)
  }
})
