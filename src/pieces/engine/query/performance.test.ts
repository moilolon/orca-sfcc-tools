// The time of a completion and a hover on a 5,000-line script and a 5,000-line template of the
// invented checkout, once its index is built: the first query on a text (which reads it) and the
// next ones (which reuse what was read, as the worker does). The numbers are in the log.
import { assert, test } from 'orca/testing'
import { CheckoutIndex } from '../checkout/checkout'
import { fixtureFiles } from '../checkout/testing'
import { largeScript } from '../fixtures/generate'
import { analyse, type Analysis } from './analysis'
import { complete } from './complete'
import { hover } from './hover'
import type { QueryContext } from './modules'
import { BASE, committedDw, dwLookup } from './testing'

/**
 * The bound the editor needs is 50 ms; alone, the first query on a 5,000-line text takes 7 to 16 ms
 * (the numbers are in the log). A test asserts a bound that holds on a busy machine, the best of
 * several rounds, as the parser's timing tests do: the other test files run alongside.
 */
const BUSY_BOUND_MS = 150
/** What reusing a text read costs: far under the bound even when busy. */
const NEXT_BOUND_MS = 50

/** An invented template of at least `lines` lines: includes, conditions, loops, keys and custom tags. */
function largeTemplate(lines: number): string {
  let text = '<isinclude template="components/modules" />\n<isdecorate template="common/layout/page">\n'
  let n = 0
  while (text.split('\n').length < lines) {
    text += [
      `<div class="garden-row garden-row-${n}">`,
      `    <isif condition="\${pdict.rows && pdict.rows.length > ${n}}">`,
      `        <isloop items="\${pdict.rows}" var="row" status="loop">`,
      `            <span>\${Resource.msg('label.price', 'product', null)} \${row.price}</span>`,
      `            <isinclude template="product/components/price" />`,
      `            <isbadge label="\${Resource.msg('title.home', 'common', null)}" tone="new" />`,
      '        </isloop>',
      '    <iselse>',
      `        <a href="\${URLUtils.url('Product-Show', 'pid', pdict.pid)}">\${pdict.name}</a>`,
      '    </isif>',
      '</div>',
      ''
    ].join('\n')
    n++
  }
  return text + '</isdecorate>\n'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function measure(run: () => unknown): number {
  const started = performance.now()
  run()
  return performance.now() - started
}

test('timings: a completion and a hover on a 5,000-line script and template, once the index is built, the best of several rounds', async () => {
  const script = largeScript(5000)
  const template = largeTemplate(5000)
  const scriptPath = `${BASE}/cartridge/scripts/helpers/large.js`
  const templatePath = `${BASE}/cartridge/templates/default/large/page.isml`
  const files = fixtureFiles()
  files.set(scriptPath, script)
  files.set(templatePath, template)
  const index = new CheckoutIndex(files, { dw: dwLookup })
  await index.build()
  const ctx: QueryContext = { index, dw: committedDw() }
  assert.ok(script.split('\n').length >= 5000 && template.split('\n').length >= 5000)

  // Places in the middle of each file.
  const middle = (text: string, snippet: string, shift: number) => text.indexOf(snippet, Math.floor(text.length / 2)) + shift
  const queries: { name: string; path: string; text: string; offset: number; kind: 'complete' | 'hover'; expect: (answer: unknown) => boolean }[] = [
    { name: 'members of ProductMgr', path: scriptPath, text: script, offset: middle(script, 'ProductMgr.getProduct', 'ProductMgr.'.length), kind: 'complete', expect: (a) => (a as ReturnType<typeof complete>).items.some((item) => item.label === 'getProduct') },
    { name: 'custom attributes of a product', path: scriptPath, text: script, offset: middle(script, 'product.custom.excluded', 'product.custom.'.length), kind: 'complete', expect: (a) => (a as ReturnType<typeof complete>).context === 'custom' },
    { name: 'members of a JSDoc parameter', path: scriptPath, text: script, offset: middle(script, 'basket.productLineItems', 'basket.'.length), kind: 'complete', expect: (a) => (a as ReturnType<typeof complete>).items.some((item) => item.label === 'productLineItems') },
    { name: 'hover of getProduct', path: scriptPath, text: script, offset: middle(script, 'getProduct(item', 3), kind: 'hover', expect: (a) => (a as ReturnType<typeof hover>)?.kind === 'dw-member' },
    { name: 'hover of a module', path: scriptPath, text: script, offset: script.indexOf('*/cartridge') + 3, kind: 'hover', expect: (a) => (a as ReturnType<typeof hover>)?.kind === 'module' },
    { name: 'template keys', path: templatePath, text: template, offset: middle(template, "'label.price'", 1), kind: 'complete', expect: (a) => (a as ReturnType<typeof complete>).context === 'resource-key' },
    { name: 'tag attributes', path: templatePath, text: template, offset: middle(template, 'var="row"', 0), kind: 'complete', expect: (a) => (a as ReturnType<typeof complete>).context === 'tag-attribute' },
    { name: 'hover of a template', path: templatePath, text: template, offset: middle(template, 'product/components/price', 3), kind: 'hover', expect: (a) => (a as ReturnType<typeof hover>)?.kind === 'template' },
    { name: 'hover of a route', path: templatePath, text: template, offset: middle(template, 'Product-Show', 3), kind: 'hover', expect: (a) => (a as ReturnType<typeof hover>)?.kind === 'route' }
  ]
  const lines: string[] = []
  for (const query of queries) {
    const first: number[] = []
    const next: number[] = []
    for (let round = 0; round < 15; round++) {
      let analysis: Analysis | null = null
      let answer: unknown = null
      // The first query on a text reads it; the worker keeps what it read for the next ones.
      first.push(measure(() => {
        analysis = analyse(query.path, query.text)
        answer = query.kind === 'complete' ? complete(ctx, analysis, query.offset) : hover(ctx, analysis, query.offset)
      }))
      assert.ok(query.expect(answer), query.name)
      next.push(measure(() => (query.kind === 'complete' ? complete(ctx, analysis as unknown as Analysis, query.offset) : hover(ctx, analysis as unknown as Analysis, query.offset))))
    }
    lines.push(`${query.name}: first ${median(first).toFixed(1)} ms (best ${Math.min(...first).toFixed(1)}, worst ${Math.max(...first).toFixed(1)}), then ${median(next).toFixed(2)} ms`)
    assert.ok(Math.min(...first) < BUSY_BOUND_MS, `${query.name}: the first query took at best ${Math.min(...first)} ms`)
    assert.ok(median(next) < NEXT_BOUND_MS, `${query.name}: the next query took ${median(next)} ms`)
  }
  console.log(`queries on ${script.split('\n').length}-line script and ${template.split('\n').length}-line template:\n  ${lines.join('\n  ')}`)
})
