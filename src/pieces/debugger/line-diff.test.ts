// The line diff that moves breakpoints with their text: in the worker on every save, and in the
// editor between saves. The lines are invented.
import { assert, test } from 'orca/testing'
import { MAX_DIFF_EDITS, mapLines, remapLines, similarity, textLines } from './line-diff'

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
  // In a hunk of uneven size, an old line like none of the new ones was deleted.
  assert.equal(mapLines(BEFORE, [...BEFORE.slice(0, 3), '  throw new Error();', '  // gone', '}'])[3], -1)
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

test('round 2, finding 2: a line rewritten in place keeps its breakpoint, however different, emptied or a comment', () => {
  for (const rewritten of ['  var sum = add(a, b); return sum;', '', '  // TODO', '  return a+b']) {
    assert.deepEqual(remapLines([4], BEFORE, [...BEFORE.slice(0, 3), rewritten, '}']), [4], JSON.stringify(rewritten))
  }
  // Two lines rewritten as two keep theirs, in order.
  assert.deepEqual(remapLines([3, 4], BEFORE, [...BEFORE.slice(0, 2), 'function total() {', '  return 0;', '}']), [3, 4])
})

/** A file of `n` invented lines, every one different. */
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `statement${i + 1}();`)

/** The best of a few runs, so a busy machine's pause does not count. */
function fastest(work: () => void): number {
  let best = Infinity
  for (let run = 0; run < 3; run++) {
    const started = performance.now()
    work()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

test('round 2, finding 1: in files of 1,000, 10,000 and 50,000 lines, edits at both ends and in the middle move every breakpoint, in bounded time', () => {
  for (const n of [1_000, 10_000, 50_000]) {
    const before = numbered(n)
    const mid = n / 2
    // Two lines at the top, one in the middle, the last line changed.
    const after = ['// one', '// two', ...before.slice(0, mid), '// added', ...before.slice(mid, -1), 'changed();']
    let moved: number[] = []
    const ms = fastest(() => (moved = remapLines([10, mid - 5, mid + 5, n], before, after)))
    assert.deepEqual(moved, [12, mid - 3, mid + 8, n + 3], `${n} lines`)
    assert.ok(ms < 250, `${n} lines took ${ms.toFixed(1)} ms`)
  }
})

test('past the exact diff’s bound, unchanged lines still keep their breakpoints, in bounded time', () => {
  const n = 50_000
  const before = numbered(n)
  // A third of the lines rewritten: far more edits than the exact diff takes on.
  const after = before.map((line, i) => (i % 3 === 0 ? `rewritten${i}();` : line))
  // And a block inserted near the top, so the rest must move.
  after.splice(100, 0, '// a', '// b')
  assert.ok(n / 3 > MAX_DIFF_EDITS)
  let moved: number[] = []
  const ms = fastest(() => (moved = remapLines([2, 500, 25_001, 49_999], before, after)))
  assert.deepEqual(moved, [2, 502, 25_003, 50_001])
  assert.ok(ms < 1_000, `took ${ms.toFixed(1)} ms`)
})
