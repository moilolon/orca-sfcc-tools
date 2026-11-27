// The three-way merge: changes of both sides apply where they do not overlap, the same change
// applies once, an overlap keeps the person's version, line breaks stay as written.
import { assert, test } from 'orca/testing'
import { diffLines, linesOf, merge3 } from './merge'

const BASE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', ''].join('\n')
const edit = (text: string, from: string, to: string) => text.replace(from, to)

test('lines keep their breaks', () => {
  assert.deepEqual(linesOf('a\r\nb\nc'), ['a\r\n', 'b\n', 'c'])
  assert.deepEqual(linesOf(''), [])
  assert.equal(linesOf('x\r\ny\r').join(''), 'x\r\ny\r')
})

test('the diff of two line lists finds the smallest changes', () => {
  const a = linesOf(BASE)
  const b = linesOf(edit(edit(BASE, 'b\n', 'B\n'), 'f\n', 'f\nF2\n'))
  assert.deepEqual(diffLines(a, b), [
    { start: 1, end: 2, lines: ['B\n'] },
    { start: 6, end: 6, lines: ['F2\n'] }
  ])
  assert.deepEqual(diffLines(a, a), [])
  // Past the distance allowed the middle is one change.
  const far = diffLines(linesOf('1\n2\n3\n4\n'), linesOf('5\n6\n7\n8\n'), 2)
  assert.deepEqual(far, [{ start: 0, end: 4, lines: ['5\n', '6\n', '7\n', '8\n'] }])
})

test('changes of both sides that do not overlap are both applied', () => {
  const mine = edit(BASE, 'b\n', 'mine\n')
  const outside = edit(BASE, 'f\n', 'outside\n')
  assert.deepEqual(merge3(BASE, outside, mine), { text: edit(mine, 'f\n', 'outside\n'), conflicts: 0 })
  // Adjacent lines are not an overlap.
  const next = edit(BASE, 'c\n', 'C\n')
  assert.equal(merge3(BASE, next, mine).text, edit(mine, 'c\n', 'C\n'))
})

test('the same change on both sides applies once', () => {
  const both = edit(BASE, 'd\n', 'same\n')
  assert.deepEqual(merge3(BASE, both, both), { text: both, conflicts: 0 })
  const mine = edit(both, 'a\n', 'A\n')
  assert.deepEqual(merge3(BASE, both, mine), { text: mine, conflicts: 0 })
})

test('an overlap keeps the person’s version there and counts a conflict', () => {
  const mine = edit(BASE, 'd\n', 'mine\n')
  const outside = edit(edit(BASE, 'd\n', 'theirs\n'), 'a\n', 'A\n')
  assert.deepEqual(merge3(BASE, outside, mine), { text: edit(mine, 'a\n', 'A\n'), conflicts: 1 })
  // Two insertions at one place that differ.
  const insertMine = edit(BASE, 'c\n', 'c\nX\n')
  const insertOutside = edit(BASE, 'c\n', 'c\nY\n')
  assert.deepEqual(merge3(BASE, insertOutside, insertMine), { text: insertMine, conflicts: 1 })
})

test('trivial cases: one side unchanged', () => {
  const changed = edit(BASE, 'a\n', 'z\n')
  assert.equal(merge3(BASE, changed, BASE).text, changed)
  assert.equal(merge3(BASE, BASE, changed).text, changed)
})

test('CRLF lines merge as written, and a deleted region next to an insertion', () => {
  const base = 'one\r\ntwo\r\nthree\r\nfour\r\n'
  const mine = 'one\r\ntwo\r\nfour\r\n'
  const outside = 'zero\r\none\r\ntwo\r\nthree\r\nfour\r\n'
  assert.equal(merge3(base, outside, mine).text, 'zero\r\none\r\ntwo\r\nfour\r\n')
})

test('a large file with scattered edits on both sides merges every one', () => {
  const lines = Array.from({ length: 3_000 }, (_, i) => `<div>${i}</div>\n`)
  const base = lines.join('')
  const mineLines = [...lines]
  const outsideLines = [...lines]
  for (let i = 10; i < 3_000; i += 300) mineLines[i] = `<p>mine ${i}</p>\n`
  for (let i = 160; i < 3_000; i += 300) outsideLines[i] = `<p>outside ${i}</p>\n`
  const expected = lines.map((line, i) => (mineLines[i] !== line ? mineLines[i] : outsideLines[i]))
  const started = performance.now()
  const result = merge3(base, outsideLines.join(''), mineLines.join(''))
  assert.equal(result.text, expected.join(''))
  assert.equal(result.conflicts, 0)
  assert.ok(performance.now() - started < 500, 'fast enough to run while typing')
})
