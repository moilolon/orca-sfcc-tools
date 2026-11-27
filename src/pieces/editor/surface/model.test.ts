// The editing model with no DOM: typing and its undo steps, the selection by keyboard, the
// clipboard, Tab and Enter with indentation, IME composition, and an outside change.
import { assert, test } from 'orca/testing'
import { GROUP_MS, History, MAX_STEPS } from './history'
import { columnAt, detectIndent, EditorModel, visualColumn } from './model'

/** A model with a clock the test moves. */
function modelOf(text: string, readOnly = false) {
  let now = 1_000
  const model = new EditorModel(text, { readOnly, now: () => now })
  return { model, tick: (ms: number) => (now += ms) }
}

test('typing in one place is one undo step; a pause, a move or Enter starts another', () => {
  const { model, tick } = modelOf('')
  for (const c of 'abc') {
    model.type(c)
    tick(100)
  }
  tick(GROUP_MS + 1)
  model.type('d')
  assert.equal(model.text(), 'abcd')
  assert.equal(model.history.done.length, 2)
  model.undo()
  assert.equal(model.text(), 'abc')
  model.undo()
  assert.equal(model.text(), '')
  model.redo()
  model.redo()
  assert.equal(model.text(), 'abcd')
  assert.deepEqual(model.selection.head, { line: 0, col: 4 })

  model.move('char', -1, false)
  model.type('x')
  assert.equal(model.history.done.length, 3, 'a move seals the step')
})

test('undo of 100 separate edits restores the text exactly, and redo replays them', () => {
  const { model, tick } = modelOf('line one\nline two\n')
  const original = model.text()
  const states: string[] = [original]
  for (let i = 0; i < 100; i++) {
    model.setSelection({ line: i % 2, col: 0 })
    model.type(String.fromCharCode(97 + (i % 26)))
    tick(GROUP_MS + 1)
    states.push(model.text())
  }
  assert.equal(model.history.done.length, 100)
  for (let i = 99; i >= 0; i--) {
    assert.ok(model.undo())
    assert.equal(model.text(), states[i])
  }
  assert.ok(!model.undo(), 'nothing left')
  for (let i = 1; i <= 100; i++) {
    model.redo()
    assert.equal(model.text(), states[i])
  }
})

test('Backspace runs join one step; Delete on a selection removes it', () => {
  const { model } = modelOf('hello world')
  model.setSelection({ line: 0, col: 11 })
  for (let i = 0; i < 5; i++) model.deleteBy(-1, false)
  assert.equal(model.text(), 'hello ')
  assert.equal(model.history.done.length, 1)
  model.setSelection({ line: 0, col: 0 }, { line: 0, col: 2 })
  model.deleteBy(1, false)
  assert.equal(model.text(), 'llo ')
  model.setSelection({ line: 0, col: 4 })
  model.deleteBy(-1, true)
  assert.equal(model.text(), '')
})

test('arrows, words, Home, End, and the selection by keyboard', () => {
  const { model } = modelOf('    var total = basket.getTotal();\nnext')
  model.setSelection({ line: 0, col: 0 })
  model.move('lineEdge', -1, false)
  assert.deepEqual(model.selection.head, { line: 0, col: 4 }, 'Home goes to the first character first')
  model.move('lineEdge', -1, false)
  assert.deepEqual(model.selection.head, { line: 0, col: 0 })
  model.move('word', 1, false)
  assert.deepEqual(model.selection.head, { line: 0, col: 7 })
  model.move('word', 1, true)
  assert.equal(model.selectedText(), ' total')
  model.move('char', 1, false)
  assert.deepEqual(model.selection, { anchor: { line: 0, col: 13 }, head: { line: 0, col: 13 } }, 'an arrow lands on the selection’s edge')
  model.move('lineEdge', 1, false)
  model.move('char', 1, false)
  assert.deepEqual(model.selection.head, { line: 1, col: 0 }, 'past the end of a line to the next')
  model.move('docEdge', -1, true)
  assert.equal(model.selectedText(), '    var total = basket.getTotal();\n')
  model.selectAll()
  assert.equal(model.selectedText(), model.text())
})

test('up and down keep the column, tabs counted as their width', () => {
  const { model } = modelOf('\tabcdef\nab\n12345678')
  model.setSelection({ line: 0, col: 3 })
  assert.equal(visualColumn('\tabcdef', 3), 6)
  model.move('line', 1, false)
  assert.deepEqual(model.selection.head, { line: 1, col: 2 }, 'a short line: its end')
  model.move('line', 1, false)
  assert.deepEqual(model.selection.head, { line: 2, col: 6 }, 'the goal column comes back')
  model.move('line', 1, false)
  assert.deepEqual(model.selection.head, { line: 2, col: 8 }, 'down on the last line: its end')
  assert.equal(columnAt('\tab', 3), 1)
})

test('a 1,000-line selection by keyboard, copied and cut', () => {
  const lines = Array.from({ length: 1_200 }, (_, i) => `<div>${i}</div>`)
  const { model } = modelOf(lines.join('\n'))
  model.setSelection({ line: 100, col: 0 })
  for (let i = 0; i < 1_000; i++) model.move('line', 1, true)
  const copied = model.selectedText()
  assert.equal(copied.split('\n').length, 1_001)
  assert.equal(model.cut(), copied)
  assert.equal(model.buffer.lineCount, 200)
  model.undo()
  assert.equal(model.text(), lines.join('\n'))
})

test('a paste takes the document’s line breaks, and a 1 MB paste is one undo step', () => {
  const { model } = modelOf('a\r\nb')
  model.setSelection({ line: 0, col: 1 })
  model.paste('x\ny\rz')
  assert.equal(model.text(), 'ax\r\ny\r\nz\r\nb')
  const big = 'x'.repeat(40) + '\n'
  const megabyte = big.repeat(Math.ceil(1_048_576 / big.length))
  const { model: large } = modelOf('<isif condition="${true}">\n</isif>')
  large.setSelection({ line: 1, col: 0 })
  large.paste(megabyte)
  assert.ok(large.text().length > 1_048_576)
  assert.equal(large.history.done.length, 1)
  large.undo()
  assert.equal(large.text(), '<isif condition="${true}">\n</isif>')
})

test('Enter keeps the indentation; Tab indents, Shift+Tab and Tab on lines move whole lines', () => {
  const { model } = modelOf('<isif condition="${a}">\n    <div>\n    </div>\n</isif>')
  model.setSelection({ line: 1, col: 9 })
  model.enter()
  assert.equal(model.buffer.line(2), '    ')
  model.type('x')
  assert.equal(model.buffer.line(2), '    x')
  model.setSelection({ line: 1, col: 0 }, { line: 3, col: 2 })
  model.tab(false)
  assert.deepEqual([1, 2, 3].map((l) => model.buffer.line(l)), ['        <div>', '        x', '        </div>'])
  model.tab(true)
  model.tab(true)
  assert.deepEqual([1, 2, 3].map((l) => model.buffer.line(l)), ['<div>', 'x', '</div>'])
  model.setSelection({ line: 0, col: 0 })
  model.tab(false)
  assert.equal(model.buffer.line(0), '    <isif condition="${a}">')
  assert.equal(detectIndent(['\tx', '\ty', '  z']), '\t')
  assert.equal(detectIndent(['  a', '    b', '  c']), '  ')
  assert.equal(detectIndent(['    a', '        b']), '    ')
})

test('an IME composition is drawn but recorded only when it ends, as one step', () => {
  const { model } = modelOf('precio: ')
  model.setSelection({ line: 0, col: 8 })
  const seen: boolean[] = []
  model.onUpdate((event) => seen.push(event.provisional))
  model.startComposition()
  model.updateComposition('´')
  assert.equal(model.text(), 'precio: ´')
  model.updateComposition('に')
  model.updateComposition('にほん')
  model.endComposition('日本')
  assert.equal(model.text(), 'precio: 日本')
  assert.ok(seen.includes(true), 'the provisional text was drawn')
  assert.equal(model.history.done.length, 1)
  model.undo()
  assert.equal(model.text(), 'precio: ')
  // A cancelled composition leaves nothing.
  model.startComposition()
  model.updateComposition('ñ')
  model.endComposition('')
  assert.equal(model.text(), 'precio: ')
  // A dead key then a vowel commits the accented letter.
  model.startComposition()
  model.updateComposition('´')
  model.endComposition('á')
  assert.equal(model.text(), 'precio: á')
})

test('a read-only document takes no edit', () => {
  const { model } = modelOf('fixed', true)
  model.type('x')
  model.paste('y')
  model.deleteBy(-1, false)
  model.enter()
  assert.equal(model.text(), 'fixed')
  assert.equal(model.cut(), '')
})

test('replaceAll changes only the differing range and keeps the caret in the text around it', () => {
  const { model } = modelOf('a\nb\nc\nd')
  model.setSelection({ line: 3, col: 1 })
  assert.ok(model.replaceAll('a\nB\nB2\nc\nd'))
  assert.deepEqual(model.selection.head, { line: 4, col: 1 })
  assert.ok(!model.replaceAll('a\nB\nB2\nc\nd'), 'the same text changes nothing')
})

test('an outside write during an IME composition is held, then merged with what was composed', () => {
  const { model } = modelOf('hello\nworld\n')
  const sent: string[] = []
  model.onUpdate((event) => {
    if (event.textChanged && !event.provisional) sent.push(model.text())
  })
  model.setSelection({ line: 0, col: 5 })
  model.startComposition()
  model.updateComposition('に')
  model.updateComposition('にほ')
  // An agent writes the file: the composition goes on, untouched.
  assert.equal(model.replaceAll('hello\nWORLD\n'), false)
  assert.equal(model.text(), 'helloにほ\nworld\n')
  assert.ok(model.composition, 'still composing')
  model.updateComposition('にほん')
  // A second write before it ends: the latest is the one merged.
  model.replaceAll('hello\nWORLD!\n')
  model.endComposition('日本')
  assert.equal(model.text(), 'hello日本\nWORLD!\n', 'both the composed text and the outside write')
  assert.equal(sent.at(-1), 'hello日本\nWORLD!\n', 'the merged text goes to Orca')
  // A write that changes the line being composed keeps the composed text there.
  model.setSelection({ line: 1, col: 6 })
  model.startComposition()
  model.updateComposition('´')
  model.replaceAll('hello日本\nWORLD!?\n')
  model.endComposition('á')
  assert.equal(model.text(), 'hello日本\nWORLD!á\n')
  // A cancelled composition still takes the write in.
  model.startComposition()
  model.updateComposition('x')
  model.replaceAll('changed\n')
  model.endComposition('')
  assert.equal(model.text(), 'changed\n')
})

test('a byte order mark is held apart: never deleted, never typed before, always written back', () => {
  const { model } = modelOf('﻿<isif>\r\n</isif>\r\n')
  assert.equal(model.bom, true)
  assert.equal(model.buffer.line(0), '<isif>', 'not in the editable text')
  // Select all and paste.
  model.selectAll()
  model.paste('<div/>')
  assert.equal(model.text(), '﻿<div/>')
  // Home twice, then type: after the mark, never before it.
  const { model: home } = modelOf('﻿  foo\r\n')
  home.setSelection({ line: 0, col: 4 })
  home.move('lineEdge', -1, false)
  home.move('lineEdge', -1, false)
  home.type('x')
  assert.equal(home.text(), '﻿x  foo\r\n')
  // Backspace at the start deletes nothing.
  const { model: back } = modelOf('﻿foo')
  back.setSelection({ line: 0, col: 0 })
  back.deleteBy(-1, false)
  back.deleteBy(-1, true)
  assert.equal(back.text(), '﻿foo')
  // Undo of everything gives the file back exactly, and offsets count the mark.
  while (home.undo()) {
    // all of it
  }
  assert.equal(home.text(), '﻿  foo\r\n')
  assert.equal(home.textOffset({ line: 0, col: 2 }), 3)
  // An outside write may add or drop the mark: the file's own say.
  assert.ok(back.replaceAll('foo'))
  assert.equal(back.bom, false)
  assert.equal(back.text(), 'foo')
  assert.ok(back.replaceAll('﻿foo'))
  assert.equal(back.text(), '﻿foo')
})

test('the history is bounded', () => {
  const history = new History(() => 0)
  const change = { from: { line: 0, col: 0 }, removed: '', inserted: 'x', end: { line: 0, col: 1 } }
  const sel = { anchor: { line: 0, col: 0 }, head: { line: 0, col: 0 } }
  for (let i = 0; i < MAX_STEPS + 50; i++) history.record([change], sel, sel, 'paste')
  assert.equal(history.done.length, MAX_STEPS)
})
