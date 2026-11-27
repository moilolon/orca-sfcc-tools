// The line diff that moves breakpoints with their text: in the worker on every save, and in the
// editor between saves. The lines are invented.
import { assert, test } from 'orca/testing'
import { mapLines, remapLines, similarity, textLines } from './line-diff'

const BEFORE = ['var a = 1;', 'var b = 2;', 'function show() {', '  return a + b;', '}']

test('equal lines match; lines added or removed above move the rest; a line deleted whole is -1', () => {
  assert.deepEqual([...mapLines(BEFORE, BEFORE)], [0, 1, 2, 3, 4])
  assert.deepEqual([...mapLines(BEFORE, ['// x', '// y', ...BEFORE])], [2, 3, 4, 5, 6])
  assert.deepEqual([...mapLines(BEFORE, BEFORE.filter((_, i) => i !== 1))], [0, -1, 1, 2, 3])
  assert.deepEqual([...mapLines(BEFORE, [])], [-1, -1, -1, -1, -1])
})

test('a line edited in place keeps its place; one split by Enter keeps it on its first part; a blank line put before an edited one does not take it', () => {
  assert.deepEqual([...mapLines(BEFORE, ['var a = 1;', 'var b = 3;', ...BEFORE.slice(2)])], [0, 1, 2, 3, 4])
  assert.deepEqual([...mapLines(BEFORE, ['var a', ' = 1;', ...BEFORE.slice(1)])], [0, 2, 3, 4, 5])
  assert.deepEqual([...mapLines(BEFORE, [...BEFORE.slice(0, 3), '', '  return a + b + c;', '}'])], [0, 1, 2, 4, 5])
  // A line rewritten into something else entirely was deleted.
  assert.equal(mapLines(BEFORE, [...BEFORE.slice(0, 3), '  throw new Error();', '}'])[3], -1)
})

test('breakpoints are carried, dropped with their line or past the end, once each, in order', () => {
  assert.deepEqual(remapLines([4, 2, 9], BEFORE, ['// x', ...BEFORE.filter((_, i) => i !== 1)]), [4])
  assert.deepEqual(remapLines([1, 2], BEFORE, ['var a = 1;var b = 2;', ...BEFORE.slice(2)]), [1])
})

test('lines are split as the editor’s buffer splits them, a BOM aside; similarity ignores indentation', () => {
  assert.deepEqual(textLines('﻿a\r\nb\rc\nd'), ['a', 'b', 'c', 'd'])
  assert.equal(similarity('  x = 1;', 'x = 1;'), 1)
  assert.equal(similarity('', 'x'), 0)
  assert.equal(similarity('', '  '), 1)
})
