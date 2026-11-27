// Typing in a 3,000-line template, as the surface does it on every key with no DOM: the model's
// edit, the history, the incremental highlighting of the lines in view, and the whole text handed
// to the document sync. A key must leave most of a frame (16.7 ms) to the drawing: after a few keys
// to warm up, the median is held to 2 ms and 95 keys in 100 to 8 ms. The slowest key is printed,
// not held: it is a garbage collection landing on it, as long as the machine is busy (the whole
// suite runs in parallel), and S9 measured it inside Orca's frame.
import { assert, test } from 'orca/testing'
import { Highlighter } from '../highlight/highlighter'
import { LEXERS } from '../highlight/language'
import { EditorModel } from './model'

/** An invented template of `lines` lines: tags, ISML tags, expressions, a script block, comments. */
function template(lines: number): string {
  const block = [
    '<isif condition="${pdict.items.length > 0}">',
    '    <div class="row ${loopState.odd ? \'odd\' : \'even\'}" data-pid="${item.id}">',
    '        <isprint value="${Resource.msg(\'cart.item\', \'cart\', null)}" encoding="htmlcontent"/>',
    '        <!-- the price -->',
    '        <span class="price">${item.price.decimalValue.toFixed(2)}</span>',
    '    </div>',
    '<iselse/>',
    '    <isscript>',
    "        var total = require('dw/util/StringUtils').formatMoney(basket.totalGrossPrice);",
    '    </isscript>',
    '</isif>'
  ]
  const out: string[] = []
  while (out.length < lines) out.push(...block)
  return out.slice(0, lines).join('\n')
}

function stats(samples: number[]): { median: number; p95: number; worst: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], worst: sorted[sorted.length - 1] }
}

/** Types `keys` at a line, as the view does: edit, colour what is in view, hand the text to the sync. */
function typeAt(model: EditorModel, highlighter: Highlighter, line: number, keys: string): number[] {
  const viewLines = 60
  model.setSelection({ line, col: model.buffer.line(line).length })
  highlighter.ensure(Math.min(model.buffer.lineCount - 1, line + viewLines))
  const samples: number[] = []
  let sent = ''
  for (const key of keys) {
    const started = performance.now()
    model.type(key)
    const head = model.selection.head.line
    highlighter.ensure(Math.min(model.buffer.lineCount - 1, head + viewLines / 2))
    highlighter.tokens(head)
    sent = model.text()
    samples.push(performance.now() - started)
  }
  assert.ok(sent.length > 0)
  return samples
}

test('typing 200 keys in the middle and at the end of a 3,000-line template stays well inside a frame', () => {
  const text = template(3_000)
  const model = new EditorModel(text)
  const highlighter = new Highlighter(model.buffer, LEXERS.isml)
  // Warm the lexer and the buffer the way opening the file does.
  highlighter.ensure(model.buffer.lineCount - 1)
  typeAt(model, highlighter, 100, 'warm up '.repeat(3))
  const keys = 'var subtotal = basket.getAdjustedMerchandizeTotalPrice(false); ${x} '.repeat(4).slice(0, 200)
  const middle = stats(typeAt(model, highlighter, 1_500, keys))
  const end = stats(typeAt(model, highlighter, model.buffer.lineCount - 2, keys))
  // A quote that opens a value changes the state of the lines after it: only those in view are lexed.
  highlighter.lexed = 0
  model.setSelection({ line: 1_200, col: 0 })
  model.type('"')
  highlighter.ensure(1_260)
  assert.ok(highlighter.lexed <= 61, `${highlighter.lexed} lines lexed`)
  const report = `middle ${JSON.stringify(middle)} end ${JSON.stringify(end)}`
  assert.ok(middle.median < 2 && end.median < 2, report)
  assert.ok(middle.p95 < 8 && end.p95 < 8, report)
  console.log(`typing in 3,000 lines, ms per key: ${report}`)
  // Undo of everything typed restores the text exactly.
  while (model.undo()) {
    // all of it
  }
  assert.equal(model.text(), text)
})
