// Breakpoints follow the text as the person edits it (real edits of the editing model: Enter,
// Backspace, a paste, a cut, undo, an outside change), and the editor's save hands the store every
// line where it is seen. The script is invented.
import { assert, test } from 'orca/testing'
import { EditorModel } from '../surface/model'
import { LineMap } from './line-map'
import { BreakpointMarks } from './marks'

const SCRIPT = ['var a = 1;', 'var b = 2;', 'function show() {', '  return a + b;', '}', 'module.exports.show = show;'].join('\n')

/** A model whose every buffer change reaches the marks, with the store holding `lines` (1-based). */
function edited(lines: number[], session: 'none' | 'attached' = 'none') {
  const model = new EditorModel(SCRIPT)
  const marks = new BreakpointMarks(model.buffer.lineCount)
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

test('lines inserted or removed above a breakpoint move it; edits below or on other lines do not', () => {
  const { model, shown, at } = edited([4])
  assert.deepEqual(shown(), ['4:idle'])
  // Enter at the end of line 1: a new line 2 above the breakpoint.
  at(0, 10)
  model.enter()
  assert.deepEqual(shown(), ['5:idle'])
  // Typing on a line moves nothing.
  model.type('x')
  assert.deepEqual(shown(), ['5:idle'])
  // Enter at the start of the breakpoint's own line: its text moves down, and the breakpoint with it.
  at(4, 0)
  model.enter()
  assert.deepEqual(shown(), ['6:idle'])
  // Backspace at its start joins it to the empty line above: back to 5.
  at(5, 0)
  model.deleteBy(-1, false)
  assert.deepEqual(shown(), ['5:idle'])
  // Lines below change nothing.
  at(5, 1)
  model.enter()
  model.paste('one\ntwo\n')
  assert.deepEqual(shown(), ['5:idle'])
})

test('a pasted block above moves it by its lines; a cut of lines around it keeps it on the line that took their place', () => {
  const { model, shown, at } = edited([2, 6])
  at(0, 0)
  model.paste('// one\n// two\n// three\n')
  assert.deepEqual(shown(), ['5:idle', '9:idle'])
  // Cut lines 4 to 6 (1-based) whole: the breakpoint of line 5 lands on line 4, where line 7's text is now.
  model.setSelection({ line: 3, col: 0 }, { line: 6, col: 0 })
  model.cut()
  assert.deepEqual(shown(), ['4:idle', '6:idle'])
  // Undo puts the lines back; the breakpoint stays where the text joined it.
  model.undo()
  assert.equal(model.text().split('\n')[4], 'var b = 2;')
  assert.deepEqual(shown(), ['7:idle', '9:idle'])
})

test('an outside change (an agent wrote the file) moves marks the same way', () => {
  const { model, shown } = edited([3])
  model.replaceAll(`'use strict';\n\n${SCRIPT}`)
  assert.deepEqual(shown(), ['5:idle'])
})

test('a click sets a saved line at once, and holds one on a written line until the save; the save writes where each is seen', () => {
  const { model, marks, shown, at } = edited([2])
  // A click on line 4 (saved line 4): asked of the store at once.
  assert.deepEqual(marks.toggle(3), [{ line: 4, on: true }])
  assert.deepEqual(shown(), ['2:idle', '4:idle'])
  // Two new lines at the top: both move down; a click on a new line is held.
  at(0, 0)
  model.paste('// a\n// b\n')
  assert.deepEqual(shown(), ['4:idle', '6:idle'])
  assert.deepEqual(marks.toggle(0), [], 'a written line has no saved line yet')
  assert.deepEqual(shown(), ['1:pending', '4:idle', '6:idle'])
  // A click on a shown breakpoint removes it: the store is asked for its saved line.
  assert.deepEqual(marks.toggle(5), [{ line: 4, on: false }])
  assert.deepEqual(shown(), ['1:pending', '4:idle'])
  // Orca flushes, then the person types more before the save lands.
  marks.flushed(model.buffer.lineCount)
  at(0, 0)
  model.enter()
  assert.deepEqual(marks.saved(), [1, 4], 'the store gets the lines as they were when saved')
  // Now the saved file is that text: everything shows one line lower, nothing pending.
  assert.deepEqual(shown(), ['2:idle', '5:idle'])
  assert.equal(marks.current(1), 1)
})

test('a save that moved nothing writes nothing; a save with no flush before it writes nothing', () => {
  const { model, marks, at } = edited([2])
  assert.equal(marks.saved(), null)
  at(1, 3)
  model.type('x')
  marks.flushed(model.buffer.lineCount)
  assert.equal(marks.saved(), null)
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
  marks.setStored(
    [
      { line: 1, verified: true },
      { line: 2, verified: false }
    ],
    'attached'
  )
  at(1, 0)
  model.deleteBy(-1, false)
  assert.deepEqual(shown(), ['1:unverified'])
  // A click on the joined line removes both.
  assert.deepEqual(marks.toggle(0), [
    { line: 1, on: false },
    { line: 2, on: false }
  ])
})

test('the line map: past the saved end there is no line; saved lines joined on one line are all found', () => {
  const map = new LineMap(3)
  assert.equal(map.current(3), null)
  map.apply(0, 1, 0, { from: { line: 0, col: 2 }, removed: 'x\n', inserted: '' })
  assert.deepEqual(map.savedAt(0), [0, 1])
  assert.deepEqual(map.savedAt(1), [2])
})
