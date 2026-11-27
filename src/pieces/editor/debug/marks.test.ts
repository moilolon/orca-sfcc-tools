// Breakpoints follow the text as the person edits it (real edits of the editing model: Enter,
// Backspace, a paste, a cut, undo), drawn through the line diff from the file as saved, so they
// never move with a write from outside; a click on a written line is held until a save makes it a
// line of the file. The script is invented.
import { assert, test } from 'orca/testing'
import { textLines } from '../../debugger/line-diff'
import { EditorModel } from '../surface/model'
import { BreakpointMarks } from './marks'

const SCRIPT = ['var a = 1;', 'var b = 2;', 'function show() {', '  return a + b;', '}', 'module.exports.show = show;'].join('\n')

/** A model whose every buffer change reaches the marks, with the store holding `lines` (1-based). */
function edited(lines: number[], session: 'none' | 'attached' = 'none') {
  const model = new EditorModel(SCRIPT)
  const marks = new BreakpointMarks(() => model.buffer.lines)
  marks.setStored(
    lines.map((line) => ({ line, verified: null })),
    session
  )
  model.buffer.onChange((fromLine, oldEnd, newEnd, change) => marks.change(fromLine, oldEnd, newEnd, change))
  /** Shown lines, 1-based, with their state. */
  const shown = () => [...marks.shown()].map(([line, state]) => `${line + 1}:${state}`).sort((a, b) => parseInt(a) - parseInt(b))
  const at = (line: number, col: number) => model.setSelection({ line, col })
  return { model, marks, shown, at }
}

test('lines inserted or removed above a breakpoint move it; edits on its line or below do not', () => {
  const { model, shown, at } = edited([4])
  assert.deepEqual(shown(), ['4:idle'])
  at(0, 10)
  model.enter()
  assert.deepEqual(shown(), ['5:idle'])
  model.type('x')
  assert.deepEqual(shown(), ['5:idle'])
  // Typing on the breakpoint's own line keeps it there.
  at(4, 4)
  model.type('/* sum */ ')
  assert.deepEqual(shown(), ['5:idle'])
  // Enter at its start: its text moves down, and the breakpoint with it.
  at(4, 0)
  model.enter()
  assert.deepEqual(shown(), ['6:idle'])
  // Backspace at its start takes it back up.
  at(5, 0)
  model.deleteBy(-1, false)
  assert.deepEqual(shown(), ['5:idle'])
  at(5, 1)
  model.enter()
  model.paste('one\ntwo\n')
  assert.deepEqual(shown(), ['5:idle'])
})

test('finding 5: a line deleted whole hides its breakpoint, and undo brings it back where it was', () => {
  const { model, marks, shown } = edited([4])
  model.setSelection({ line: 3, col: 0 }, { line: 4, col: 0 })
  model.cut()
  assert.deepEqual(shown(), [], 'never drawn on the line that took its place')
  assert.equal(marks.current(4), null)
  model.undo()
  assert.deepEqual(shown(), ['4:idle'])
})

test('a pasted block above moves breakpoints by its lines; a cut around one hides only that one', () => {
  const { model, shown, at } = edited([2, 6])
  at(0, 0)
  model.paste('// one\n// two\n// three\n')
  assert.deepEqual(shown(), ['5:idle', '9:idle'])
  // Cut `var b` and `function show() {` (lines 5 and 6 now): the breakpoint of `var b` goes.
  model.setSelection({ line: 4, col: 0 }, { line: 6, col: 0 })
  model.cut()
  assert.deepEqual(shown(), ['7:idle'])
  model.undo()
  assert.deepEqual(shown(), ['5:idle', '9:idle'])
})

test('finding 2: a write from outside never moves marks; they stay on the store’s lines, which is what runs', () => {
  const { model, marks, shown } = edited([3])
  const written = `'use strict';\n\n${SCRIPT}`
  model.replaceAll(written)
  // The editor learns the write is the file now (the document sync's replace).
  assert.deepEqual(marks.rebase(textLines(written)), [])
  assert.deepEqual(shown(), ['3:idle'])
  assert.equal(marks.current(3), 2, 'a stopped line at 3 is drawn on line 3')
  // A click on line 6 is line 6 of the file on disk.
  assert.deepEqual(marks.toggle(5), [{ line: 6, on: true, text: '  return a + b;' }])
})

test('a click sets a saved line at once and holds one on a written line, set once a save makes it a line of the file', () => {
  const { model, marks, shown, at } = edited([2])
  assert.deepEqual(marks.toggle(3), [{ line: 4, on: true, text: '  return a + b;' }])
  assert.deepEqual(shown(), ['2:idle', '4:idle'])
  at(0, 0)
  model.paste('// a\n// b\n')
  assert.deepEqual(shown(), ['4:idle', '6:idle'])
  assert.deepEqual(marks.toggle(0), [], 'a written line has no saved line yet')
  assert.deepEqual(shown(), ['1:pending', '4:idle', '6:idle'])
  assert.deepEqual(marks.toggle(5), [{ line: 4, on: false }])
  // Orca flushes, the person types more before the save lands: the held one is set where it was saved.
  marks.flushed()
  at(0, 0)
  model.enter()
  assert.deepEqual(marks.savedOwn(), [1])
  // The flushed text is the file now: the store's line 4 (moved there by the worker) shows on 5.
  marks.setStored([{ line: 4, verified: null }, { line: 1, verified: null }], 'none')
  assert.deepEqual(shown(), ['2:idle', '5:idle'])
})

test('finding 3: a save of the text this editor holds, from any tab, makes it the file, and nothing is counted twice', () => {
  const { model, marks, shown, at } = edited([3])
  at(0, 0)
  model.enter()
  assert.deepEqual(shown(), ['4:idle'])
  // Another tab saved this text: the worker moved the store's line 3 to 4.
  assert.deepEqual(marks.rebase([...model.buffer.lines]), [])
  marks.setStored([{ line: 4, verified: null }], 'none')
  assert.deepEqual(shown(), ['4:idle'], 'not counted twice')
})

test('states: verified, not verified, no session; joined lines verified only when all are', () => {
  const { model, marks, shown, at } = edited([])
  marks.setStored(
    [
      { line: 1, verified: true },
      { line: 2, verified: false },
      { line: 4, verified: null }
    ],
    'attached'
  )
  assert.deepEqual(shown(), ['1:verified', '2:unverified', '4:unverified'])
  marks.setStored([{ line: 4, verified: null }], 'none')
  assert.deepEqual(shown(), ['4:idle'])
  marks.setStored([{ line: 2, verified: true }], 'attached')
  // Backspace at the start of line 2 joins it to line 1: two lines became one, the first keeps its place.
  at(1, 0)
  model.deleteBy(-1, false)
  assert.deepEqual(shown(), [])
  model.undo()
  assert.deepEqual(shown(), ['2:verified'])
})

test('round 2, finding 2: a breakpoint stays on its line while the line is retyped from empty', () => {
  const { model, shown, at } = edited([4])
  model.setSelection({ line: 3, col: 0 }, { line: 3, col: model.buffer.line(3).length })
  model.cut()
  assert.deepEqual(shown(), ['4:idle'], 'emptied')
  at(3, 0)
  model.paste('  var sum = add(a, b); return sum;')
  assert.deepEqual(shown(), ['4:idle'], 'rewritten into something else')
})
