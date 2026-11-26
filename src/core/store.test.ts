import { assert, test } from 'orca/testing'
import type { JsonValue } from 'orca'
import { createStore } from './store'

function memory() {
  const data = new Map<string, JsonValue>()
  return {
    data,
    get: async (key: string) => (data.has(key) ? (data.get(key) as JsonValue) : null),
    set: async (key: string, value: JsonValue) => void data.set(key, value),
    delete: async (key: string) => void data.delete(key),
    keys: async () => [...data.keys()]
  }
}

test('each piece reads and writes its own namespace only', async () => {
  const storage = memory()
  const errors = createStore(storage, 'errors')
  const sandbox = createStore(storage, 'sandbox')
  await errors.set('seen', ['a'])
  await sandbox.set('seen', ['b'])
  assert.deepEqual(await errors.get('seen', []), ['a'])
  assert.deepEqual(await sandbox.get('seen', []), ['b'])
  assert.deepEqual([...storage.data.keys()].sort(), ['errors.seen', 'sandbox.seen'])
  assert.deepEqual(await errors.keys(), ['seen'])
  await errors.delete('seen')
  assert.deepEqual(await errors.get('seen', []), [])
  assert.deepEqual(await sandbox.get('seen', []), ['b'])
})

test('refuses a namespace that could reach another one', () => {
  assert.throws(() => createStore(memory(), 'errors.seen'))
  assert.throws(() => createStore(memory(), ''))
})
