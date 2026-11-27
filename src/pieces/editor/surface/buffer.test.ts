// The text buffer: lines and their breaks as written, replace and its change, offsets.
import { assert, test } from 'orca/testing'
import { diffRange, dominantBreak, endOf, splitLines, TextBuffer } from './buffer'

test('a text comes back exactly, mixed line breaks and a BOM included', () => {
  for (const text of ['', 'a', 'a\n', 'a\r\nb\rc\nd', '﻿<isif>\r\n</isif>\r\n', '\n\n\n', 'x\r']) {
    assert.equal(new TextBuffer(text).text(), text, JSON.stringify(text))
  }
  assert.deepEqual(splitLines('a\r\nb\rc'), { lines: ['a', 'b', 'c'], breaks: ['\r\n', '\r', ''] })
  assert.equal(dominantBreak(['\r\n', '\r\n', '\n', '']), '\r\n')
  assert.equal(dominantBreak(['']), '\n')
})

test('replace changes the lines, reports the range and gives back what it removed', () => {
  const buffer = new TextBuffer('one\r\ntwo\r\nthree')
  const events: [number, number, number][] = []
  buffer.onChange((from, oldEnd, newEnd) => events.push([from, oldEnd, newEnd]))
  const change = buffer.replace({ line: 0, col: 1 }, { line: 2, col: 2 }, 'X\nY')
  assert.equal(change.removed, 'ne\r\ntwo\r\nth')
  assert.deepEqual(change.end, { line: 1, col: 1 })
  assert.equal(buffer.text(), 'oX\nYree')
  assert.deepEqual(events, [[0, 2, 1]])
  // Undoing it with the removed text gives the original back, breaks and all.
  buffer.replace(change.from, change.end, change.removed)
  assert.equal(buffer.text(), 'one\r\ntwo\r\nthree')
})

test('positions are clipped, and offsets count each break as written', () => {
  const buffer = new TextBuffer('ab\r\ncd\nef')
  assert.deepEqual(buffer.clip({ line: 9, col: 9 }), { line: 2, col: 2 })
  assert.deepEqual(buffer.clip({ line: -1, col: 5 }), { line: 0, col: 2 })
  assert.equal(buffer.offsetAt({ line: 1, col: 1 }), 5)
  assert.equal(buffer.offsetAt({ line: 2, col: 0 }), 7)
  assert.deepEqual(buffer.posAt(5), { line: 1, col: 1 })
  assert.deepEqual(buffer.posAt(3), { line: 0, col: 2 }, 'inside a CRLF is the end of its line')
  assert.deepEqual(buffer.posAt(99), { line: 2, col: 2 })
  assert.equal(buffer.length, 9)
  assert.equal(buffer.slice({ line: 0, col: 1 }, { line: 1, col: 1 }), 'b\r\nc')
  assert.deepEqual(endOf({ line: 3, col: 2 }, 'xy'), { line: 3, col: 4 })
  assert.deepEqual(endOf({ line: 3, col: 2 }, 'x\r\nyz'), { line: 4, col: 2 })
})

test('a very large insertion does not overflow the stack', () => {
  const buffer = new TextBuffer('start\nend')
  const big = Array.from({ length: 150_000 }, (_, i) => `line ${i}`).join('\n')
  buffer.replace({ line: 0, col: 5 }, { line: 0, col: 5 }, big)
  assert.equal(buffer.lineCount, 150_001)
  assert.equal(buffer.line(150_000), 'end')
})

test('diffRange finds the smallest differing range and never splits a CRLF or a surrogate pair', () => {
  assert.deepEqual(diffRange('abcdef', 'abXdef'), { start: 2, oldEnd: 3, newEnd: 3 })
  assert.deepEqual(diffRange('same', 'same'), { start: 4, oldEnd: 4, newEnd: 4 })
  const crlf = diffRange('a\r\nb', 'a\rb')
  assert.ok(crlf.start <= 1, 'the change starts at or before the CR')
  const pair = diffRange('x😀y', 'x😁y')
  assert.equal(pair.start, 1)
  assert.equal(pair.oldEnd, 3)
})
