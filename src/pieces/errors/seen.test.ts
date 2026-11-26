// The seen list over a plain store: one row per signature, new until marked, marked for good,
// forgotten on request, independent per environment and bounded in size.
import { assert, test } from 'orca/testing'
import { boundSample, createSeenList, LIMITS, listKey, type Occurrence, type Sample, type SeenJson, type SeenStore } from './seen'

function memoryStore(initial: Record<string, SeenJson> = {}) {
  const data = new Map<string, SeenJson>(Object.entries(initial))
  const store: SeenStore = {
    get: async <T extends SeenJson>(key: string, fallback: T) => (data.has(key) ? (JSON.parse(JSON.stringify(data.get(key))) as T) : fallback),
    set: async (key, value) => void data.set(key, JSON.parse(JSON.stringify(value)))
  }
  return { store, data }
}

const SAMPLE: Sample = { message: 'TypeError: x is undefined', logger: 'custom.Cart', frames: [{ file: 'app_x/cartridge/scripts/a.js', function: 'run', line: 12 }] }

function occurrence(signature: string, at: number, sample: Sample = SAMPLE): Occurrence {
  return { signature, at, sample }
}

test('a new error appears once, however many times it repeats', async () => {
  const { store } = memoryStore()
  const seen = createSeenList(store)
  const first = await seen.record('sandbox', [occurrence('a', 10), occurrence('a', 30), occurrence('a', 20)])
  assert.deepEqual(first.added, ['a'])
  const second = await seen.record('sandbox', [occurrence('a', 40)])
  assert.deepEqual(second.added, [], 'a known signature is not added again')
  const rows = await seen.list('sandbox')
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0], sample: undefined }, { signature: 'a', firstSeen: 10, lastSeen: 40, count: 4, sample: undefined })
  assert.equal(await seen.newCount('sandbox'), 1)
})

test('a read that found nothing writes nothing', async () => {
  const { store } = memoryStore()
  let writes = 0
  const counting: SeenStore = { get: store.get, set: async (key, value) => void (writes++, await store.set(key, value)) }
  const seen = createSeenList(counting)
  assert.deepEqual(await seen.record('sandbox', []), { added: [] })
  assert.equal(writes, 0)
  await seen.record('sandbox', [occurrence('a', 1)])
  assert.equal(writes, 1)
})

test('the sample is the newest occurrence’s', async () => {
  const { store } = memoryStore()
  const seen = createSeenList(store)
  const newer: Sample = { ...SAMPLE, frames: [{ ...SAMPLE.frames[0], line: 99 }] }
  await seen.record('sandbox', [occurrence('a', 20, newer), occurrence('a', 10)])
  assert.equal((await seen.list('sandbox'))[0].sample.frames[0].line, 99)
})

test('marking moves an error to seen for good; forgetting makes it new again', async () => {
  const { store } = memoryStore()
  const seen = createSeenList(store)
  await seen.record('sandbox', [occurrence('a', 10), occurrence('b', 20)])
  await seen.mark('sandbox', ['a', 'missing'], 100)
  assert.equal(await seen.newCount('sandbox'), 1)
  await seen.record('sandbox', [occurrence('a', 200), occurrence('a', 210)])
  let rows = await seen.list('sandbox')
  const a = rows.find((row) => row.signature === 'a')
  assert.equal(a?.markedAt, 100, 'still marked after it repeats')
  assert.equal(a?.count, 3)
  assert.deepEqual(rows.map((row) => row.signature), ['b', 'a'], 'new first')
  await seen.mark('sandbox', ['a'], 500)
  assert.equal((await seen.list('sandbox')).find((row) => row.signature === 'a')?.markedAt, 100, 'the first mark stays')

  await seen.forget('sandbox', 'a')
  await seen.forget('sandbox', 'never-there')
  rows = await seen.list('sandbox')
  assert.deepEqual(rows.map((row) => row.signature), ['b'])
  const again = await seen.record('sandbox', [occurrence('a', 600)])
  assert.deepEqual(again.added, ['a'], 'a forgotten error comes back as new')
  assert.equal(await seen.newCount('sandbox'), 2)
})

test('the lists of two environments are independent', async () => {
  const { store, data } = memoryStore()
  const seen = createSeenList(store)
  await seen.record('sandbox', [occurrence('a', 10)])
  await seen.record('production', [occurrence('a', 10), occurrence('b', 10)])
  await seen.mark('sandbox', ['a'], 20)
  assert.equal(await seen.newCount('sandbox'), 0)
  assert.equal(await seen.newCount('production'), 2)
  await seen.forget('production', 'a')
  assert.equal((await seen.list('sandbox')).length, 1)
  assert.deepEqual([...data.keys()].sort(), [listKey('production'), listKey('sandbox')])
})

test('marking persists: a new list over the same store reads it', async () => {
  const { store } = memoryStore()
  await createSeenList(store).record('staging', [occurrence('a', 10)])
  await createSeenList(store).mark('staging', ['a'], 20)
  const reopened = createSeenList(store)
  assert.equal((await reopened.list('staging'))[0].markedAt, 20)
  await reopened.record('staging', [occurrence('a', 30)])
  assert.equal(await reopened.newCount('staging'), 0)
})

test('a mark sent while a read records is not lost', async () => {
  const { store } = memoryStore()
  const seen = createSeenList(store)
  await seen.record('sandbox', [occurrence('a', 10)])
  await Promise.all([seen.record('sandbox', [occurrence('b', 20)]), seen.mark('sandbox', ['a'], 30), seen.record('sandbox', [occurrence('c', 40)])])
  const rows = await seen.list('sandbox')
  assert.deepEqual(rows.map((row) => [row.signature, row.markedAt ?? null]), [['c', null], ['b', null], ['a', 30]])
})

test('the stored sample is bounded and holds only its own fields', async () => {
  const { store, data } = memoryStore()
  const seen = createSeenList(store)
  const huge = {
    message: 'm'.repeat(5000),
    logger: 'l'.repeat(5000),
    pipeline: 'p'.repeat(5000),
    level: 'ERROR',
    site: 'Sites-Example-Site',
    frames: Array.from({ length: 40 }, (_, i) => ({ file: 'f'.repeat(5000), function: 'g'.repeat(5000), line: i + 1, raw: 'the whole entry' })),
    raw: 'the whole entry',
    message2: 'another field'
  } as unknown as Sample
  await seen.record('sandbox', [occurrence('a', 10, huge)])
  const stored = data.get(listKey('sandbox')) as Record<string, { sample: Sample }>
  const sample = stored.a.sample
  // The pipeline and the level are kept, bounded; the site, which names the shop, never is.
  assert.deepEqual(Object.keys(sample).sort(), ['frames', 'level', 'logger', 'message', 'pipeline'])
  assert.equal(sample.message.length, LIMITS.message)
  assert.equal(sample.logger?.length, LIMITS.logger)
  assert.equal(sample.pipeline?.length, LIMITS.field)
  assert.equal(sample.level, 'ERROR')
  assert.ok(!JSON.stringify(stored).includes('Sites-Example-Site'))
  assert.equal(sample.frames.length, LIMITS.frames)
  for (const frame of sample.frames) {
    assert.deepEqual(Object.keys(frame).sort(), ['file', 'function', 'line'])
    assert.equal(frame.file.length, LIMITS.file)
    assert.equal(frame.function?.length, LIMITS.function)
  }
  assert.ok(!JSON.stringify(stored).includes('the whole entry'))
  assert.ok(JSON.stringify(stored).length < 4000, 'one signature takes a few kilobytes at most')
})

test('boundSample drops a line that is not a positive whole number', () => {
  const bounded = boundSample({ message: 'x', logger: null, frames: [{ file: 'a.js', function: null, line: -3 }, { file: 'a.js', function: null, line: 1.5 }, { file: 'a.js', function: null, line: 7 }] })
  assert.deepEqual(bounded.frames.map((frame) => frame.line), [null, null, 7])
})

test('the list is bounded: past the limit, seen ones go first, the oldest first', async () => {
  const { store } = memoryStore()
  const seen = createSeenList(store)
  const many = Array.from({ length: LIMITS.signatures }, (_, i) => occurrence(`s${i}`, 1000 + i))
  await seen.record('sandbox', many)
  await seen.mark('sandbox', ['s0', 's1', 's2'], 5000)
  const result = await seen.record('sandbox', [occurrence('new1', 9000), occurrence('new2', 9001)])
  assert.deepEqual(result.added, ['new1', 'new2'])
  const rows = await seen.list('sandbox')
  assert.equal(rows.length, LIMITS.signatures)
  const kept = new Set(rows.map((row) => row.signature))
  assert.ok(!kept.has('s0') && !kept.has('s1'), 'the two oldest seen ones went')
  assert.ok(kept.has('s2') && kept.has('s3') && kept.has('new1'))
})

test('a stored list that is not an object reads as empty', async () => {
  for (const bad of [[1, 2], 'x', 42, null] as SeenJson[]) {
    const { store } = memoryStore({ [listKey('sandbox')]: bad })
    assert.deepEqual(await createSeenList(store).list('sandbox'), [])
  }
})
