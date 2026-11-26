// The single store of breakpoints: per workspace, relative paths, whole lines, kept in storage.
import type { JsonValue } from 'orca'
import { assert, test } from 'orca/testing'
import { createStore } from '../../core/store'
import { createBreakpoints, MAX_FILES, MAX_LINES_PER_FILE, normalizeLines, normalizePath } from './breakpoints'

function memory(initial: Record<string, JsonValue> = {}) {
  const data: Record<string, JsonValue> = { ...initial }
  return {
    data,
    storage: {
      get: async (key: string) => (key in data ? data[key] : null),
      set: async (key: string, value: JsonValue) => {
        data[key] = value
      },
      delete: async (key: string) => {
        delete data[key]
      },
      keys: async () => Object.keys(data)
    }
  }
}

test('a path is kept relative, with forward slashes; nothing that leaves the workspace is', () => {
  assert.equal(normalizePath('cartridges\\app_one\\cartridge\\controllers\\Page.js'), 'cartridges/app_one/cartridge/controllers/Page.js')
  assert.equal(normalizePath('a/b.js'), 'a/b.js')
  for (const bad of ['', '/a/b.js', 'C:/a.js', 'c:\\a.js', '\\\\server\\share\\a.js', 'a/../b.js', './a.js', 'a//b.js', 'a/b.js/', 'a/\u0000.js', 42, null]) {
    assert.equal(normalizePath(bad), null, String(bad))
  }
})

test('lines are whole, from 1, once each and in order, and bounded', () => {
  assert.deepEqual(normalizeLines([24, 11, 11, 0, -3, 2.5, '7', 1]), [1, 11, 24])
  assert.deepEqual(normalizeLines('11'), [])
  assert.equal(normalizeLines(Array.from({ length: 300 }, (_, i) => i + 1)).length, MAX_LINES_PER_FILE)
})

test('set, list and remove one file or all, per workspace, in the piece’s own storage', async () => {
  const { storage, data } = memory()
  const store = createStore(storage, 'debugger')
  const breakpoints = createBreakpoints(store)
  const heard: string[] = []
  const listening = breakpoints.onChange(({ workspaceId }) => heard.push(workspaceId))
  await breakpoints.set('w1', 'cartridges\\app_one\\cartridge\\controllers\\Page.js', [24, 11])
  await breakpoints.set('w1', 'cartridges/app_one/cartridge/scripts/a.js', [3])
  await breakpoints.set('w2', 'b.js', [1])
  assert.deepEqual(await breakpoints.list('w1'), [
    { path: 'cartridges/app_one/cartridge/controllers/Page.js', lines: [11, 24] },
    { path: 'cartridges/app_one/cartridge/scripts/a.js', lines: [3] }
  ])
  assert.deepEqual(data['debugger.breakpoints'], {
    w1: { 'cartridges/app_one/cartridge/controllers/Page.js': [11, 24], 'cartridges/app_one/cartridge/scripts/a.js': [3] },
    w2: { 'b.js': [1] }
  })
  // An empty list removes the file; clearing removes the workspace.
  await breakpoints.set('w1', 'cartridges/app_one/cartridge/scripts/a.js', [])
  assert.equal((await breakpoints.list('w1')).length, 1)
  await breakpoints.clear('w1')
  assert.deepEqual(await breakpoints.list('w1'), [])
  assert.deepEqual(await breakpoints.list('w2'), [{ path: 'b.js', lines: [1] }])
  assert.deepEqual(heard, ['w1', 'w1', 'w2', 'w1', 'w1'])
  listening.dispose()
  await breakpoints.set('w2', 'c.js', [2])
  assert.equal(heard.length, 5)
})

test('two quick changes never overwrite each other', async () => {
  const breakpoints = createBreakpoints(createStore(memory().storage, 'debugger'))
  await Promise.all([breakpoints.set('w', 'a.js', [1]), breakpoints.set('w', 'b.js', [2]), breakpoints.set('w', 'c.js', [3])])
  assert.deepEqual(
    (await breakpoints.list('w')).map((file) => file.path),
    ['a.js', 'b.js', 'c.js']
  )
})

test('a bad path or too many files is refused by code; a hand-edited value is read without throwing', async () => {
  const { storage } = memory({ 'debugger.breakpoints': { w: { 'ok.js': [1, 'x', 2], '../out.js': [1], 'empty.js': [] }, broken: 'nope', list: [1] } })
  const breakpoints = createBreakpoints(createStore(storage, 'debugger'))
  assert.deepEqual(await breakpoints.list('w'), [{ path: 'ok.js', lines: [1, 2] }])
  await assert.rejects(breakpoints.set('w', '../x.js', [1]), /invalid_path/)
  for (let i = 0; i < MAX_FILES - 1; i++) await breakpoints.set('w', `f${i}.js`, [1])
  await assert.rejects(breakpoints.set('w', 'one-too-many.js', [1]), /too_many_files/)
  // A file already there can still change.
  await breakpoints.set('w', 'ok.js', [5])
})
