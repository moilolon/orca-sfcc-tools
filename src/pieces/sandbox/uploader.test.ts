// Reading `code watch --jsonl` lines, in the shapes S6 recorded (invented paths and values).
import { assert, test } from 'orca/testing'
import { readWatchEvent } from './uploader'

const line = (json: Record<string, unknown>) => ({ json: { level: 'info', time: 1, command: 'code:watch', ...json } })

test('a file event announces an upload, its result counts the files', () => {
  assert.deepEqual(readWatchEvent(line({ event: 'change', path: 'C:\\work\\app_example\\cartridge\\scripts\\a.js', msg: 'File event: change …' })), { kind: 'changed' })
  assert.deepEqual(readWatchEvent(line({ event: 'add', path: 'x', msg: 'File event: add x' })), { kind: 'changed' })
  assert.deepEqual(readWatchEvent(line({ event: 'unlink', path: 'x', msg: 'File event: unlink x' })), { kind: 'changed' })
  assert.deepEqual(readWatchEvent(line({ msg: '[UPLOAD] 3 file(s)' })), { kind: 'uploaded', files: 3 })
  assert.deepEqual(readWatchEvent(line({ msg: '[DELETE] 1 file(s)' })), { kind: 'uploaded', files: 1 })
})

test('an error line is a failed upload, whatever level spelling b2c uses', () => {
  assert.deepEqual(readWatchEvent(line({ level: 'error', msg: 'Upload failed' })), { kind: 'error' })
  assert.deepEqual(readWatchEvent(line({ level: 50, msg: 'Upload failed' })), { kind: 'error' })
  assert.deepEqual(readWatchEvent(line({ level: 60, msg: 'fatal' })), { kind: 'error' })
})

test('the banner, a deleted-file note and the update notice say nothing', () => {
  assert.equal(readWatchEvent(line({ msg: 'Starting watcher for cartridges' })), null)
  assert.equal(readWatchEvent(line({ msg: 'Code Version: ws-shop' })), null)
  assert.equal(readWatchEvent(line({ path: 'Cartridges/ws-shop/app_example/x.js', msg: 'Deleted: Cartridges/ws-shop/app_example/x.js' })), null)
  assert.equal(readWatchEvent({ text: ' »   Warning: b2c-cli update available' }), null)
  assert.equal(readWatchEvent({ json: [1, 2] }), null)
  assert.equal(readWatchEvent({ json: 'text' }), null)
})
