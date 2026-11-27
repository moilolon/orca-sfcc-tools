// The text the engine reads: without the byte order mark (as the engine reads files from disk), its
// offsets and positions in agreement with the buffer's for every line break, one string per change;
// and which file a query names, a stand-in for a file not identified.
import { assert, test } from 'orca/testing'
import { EditorModel } from '../surface/model'
import { fileFor, Latest, lineStarts, NO_WORKSPACE, QueryDocument } from './document'

test('the text sent has no BOM; offsets and positions agree with the buffer for LF, CRLF and CR', () => {
  const model = new EditorModel('﻿one\r\ntwo\rthree\nfour')
  const document = new QueryDocument(model)
  assert.equal(document.text(), 'one\r\ntwo\rthree\nfour')
  for (let offset = 0; offset <= document.length; offset++) {
    const at = document.posOf(offset)
    assert.deepEqual(at, model.buffer.posAt(offset), `offset ${offset}`)
    if (offset === 4) continue // inside CRLF: its line's end, as the buffer reads it
    assert.equal(document.offsetOf(at), offset, `position of ${offset}`)
  }
  assert.deepEqual(lineStarts('a\r\nb\rc\nd'), [0, 3, 5, 7])
  // One string per version: a change makes a new one.
  const first = document.text()
  const version = document.version
  model.setSelection({ line: 0, col: 3 })
  model.type('!')
  assert.equal(document.version, version + 1)
  assert.equal(document.text(), 'one!\r\ntwo\rthree\nfour')
  assert.notEqual(document.text(), first)
})

test('an answer is current only while it is the newest asked and the text is the one it was asked on', () => {
  const model = new EditorModel('abc')
  const document = new QueryDocument(model)
  const latest = new Latest(document)
  const first = latest.begin()
  assert.equal(first(), true)
  const second = latest.begin()
  assert.equal(first(), false)
  assert.equal(second(), true)
  model.type('x')
  assert.equal(second(), false)
  const third = latest.begin()
  latest.cancel()
  assert.equal(third(), false)
})

test('a named file is asked about as itself; one not identified under no workspace and a stand-in name, never for problems', () => {
  assert.deepEqual(fileFor({ state: 'identified', workspaceId: 'w', path: 'c/x.isml' }, 'isml'), { workspaceId: 'w', path: 'c/x.isml', located: true, queries: true, problems: true })
  assert.deepEqual(fileFor({ state: 'identified', workspaceId: 'w', path: 'c/forms/f.xml' }, 'xml'), { workspaceId: 'w', path: 'c/forms/f.xml', located: true, queries: false, problems: true })
  assert.deepEqual(fileFor({ state: 'unknown' }, 'isml'), { workspaceId: NO_WORKSPACE, path: 'unnamed.isml', located: false, queries: true, problems: false })
  assert.deepEqual(fileFor({ state: 'ambiguous', workspaceId: 'w', candidates: ['a.js', 'b.js'], more: 0 }, 'javascript')?.path, 'unnamed.js')
  assert.equal(fileFor({ state: 'pending' }, 'properties'), null)
  assert.equal(fileFor({ state: 'unknown' }, 'xml'), null)
})
