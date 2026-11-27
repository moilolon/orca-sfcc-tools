// The plugin's data folder: where it is on each system, the lock and the atomic rename of its files
// (two writers at once lose nothing, a write cut off halfway never replaces the good file, a lock a
// dead process left is taken over), and the seen list's store over `seen.json`. Every folder here
// is a temporary one.
import { assert, test } from 'orca/testing'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createSeenFileStore,
  DATA_FOLDER_ENV,
  DataFileError,
  dataFiles,
  dataFolder,
  NODE_IO,
  readDataFile,
  STALE_LOCK_MS,
  updateDataFile,
  type DataFile
} from './data-folder'
import { createSeenList, type Sample } from './seen'

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'sfcc-tools-data-test-'))
}

type Counters = Record<string, number>

/** Raises `key` by one, under the lock. */
function bump(path: string, key: string) {
  return updateDataFile<Counters>(path, (current) => {
    const counters = { ...(current?.roles.counters ?? {}) }
    counters[key] = (counters[key] ?? 0) + 1
    return { version: 1, roles: { ...(current?.roles ?? {}), counters } }
  })
}

test('the data folder is the system’s own folder for application data, from the home folder only', () => {
  assert.equal(dataFolder({ platform: 'win32', home: 'C:\\Users\\someone', env: {} }), 'C:\\Users\\someone\\AppData\\Roaming\\orca-sfcc-tools')
  assert.equal(dataFolder({ platform: 'darwin', home: '/Users/someone', env: {} }), '/Users/someone/Library/Application Support/orca-sfcc-tools')
  assert.equal(dataFolder({ platform: 'linux', home: '/home/someone', env: {} }), '/home/someone/.local/share/orca-sfcc-tools')
  // The worker has no APPDATA: the command line, which has, must find the same folder.
  assert.equal(dataFolder({ platform: 'win32', home: 'C:\\Users\\someone', env: { APPDATA: 'D:\\Elsewhere' } }), 'C:\\Users\\someone\\AppData\\Roaming\\orca-sfcc-tools')
  assert.equal(dataFolder({ platform: 'linux', home: '/home/someone', env: { [DATA_FOLDER_ENV]: '/tmp/data' } }), '/tmp/data')
  assert.equal(dataFolder({ platform: 'linux', home: '/home/someone', env: { [DATA_FOLDER_ENV]: 'relative' } }), '/home/someone/.local/share/orca-sfcc-tools', 'only an absolute override')
  assert.deepEqual(dataFiles('/data'), { seen: join('/data', 'seen.json'), report: join('/data', 'report.json') })
})

test('a file that does not exist reads as null; the folder is made on the first write', async () => {
  const root = folder()
  try {
    const path = join(root, 'nested', 'seen.json')
    assert.equal(await readDataFile(path), null)
    await updateDataFile<number>(path, () => ({ version: 1, roles: { sandbox: 1 } }))
    assert.deepEqual(await readDataFile(path), { version: 1, roles: { sandbox: 1 } })
    assert.deepEqual(readdirSync(join(root, 'nested')), ['seen.json'], 'no lock or temporary file is left')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file that is not a data file of this version is refused, never read as empty or overwritten', async () => {
  const root = folder()
  try {
    const path = join(root, 'seen.json')
    for (const [text, code] of [
      ['{"version":1,"roles":{"sandbox":{', 'data_file_invalid'],
      ['[]', 'data_file_invalid'],
      ['{"version":1}', 'data_file_invalid'],
      ['{"version":2,"roles":{}}', 'data_file_version']
    ] as const) {
      writeFileSync(path, text)
      await assert.rejects(readDataFile(path), (error: unknown) => error instanceof DataFileError && error.code === code && error.message === code)
      await assert.rejects(updateDataFile(path, () => ({ version: 1, roles: {} })), (error: unknown) => error instanceof DataFileError)
      assert.equal(readFileSync(path, 'utf8'), text, 'left as it was')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two writers at once lose nothing: in one process', async () => {
  const root = folder()
  try {
    const path = join(root, 'seen.json')
    // Each writer's updates interleave with the other's at every await: only the lock orders them.
    const writer = async (key: string) => {
      for (let i = 0; i < 10; i++) await bump(path, key)
    }
    await Promise.all([writer('a'), writer('b'), writer('c')])
    assert.deepEqual((await readDataFile<Counters>(path))?.roles.counters, { a: 10, b: 10, c: 10 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two writers at once lose nothing: two processes, with a reader that never sees half a file', async () => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  // Type stripping without a flag: Node 22.18 or later, as the command line needs.
  if (major < 22 || (major === 22 && minor < 18)) return
  const root = folder()
  try {
    const path = join(root, 'seen.json')
    const module = new URL('./data-folder.ts', import.meta.url).href
    const script = (key: string) =>
      `import { updateDataFile } from ${JSON.stringify(module)}
       for (let i = 0; i < 40; i++) {
         await updateDataFile(${JSON.stringify(path)}, (current) => {
           const counters = { ...(current?.roles.counters ?? {}) }
           counters[${JSON.stringify(key)}] = (counters[${JSON.stringify(key)}] ?? 0) + 1
           return { version: 1, roles: { ...(current?.roles ?? {}), counters } }
         })
       }`
    const run = (key: string) =>
      new Promise<number | null>((done) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script(key)], { stdio: ['ignore', 'ignore', 'inherit'] })
        child.on('exit', done)
      })
    let reading = true
    let reads = 0
    const reader = (async () => {
      while (reading) {
        // Throws on a torn or half-written file.
        await readDataFile(path)
        reads++
        // A reader as the command line is one: it reads, then does something else.
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    })()
    const codes = await Promise.all([run('a'), run('b')])
    reading = false
    await reader
    assert.deepEqual(codes, [0, 0])
    assert.deepEqual((await readDataFile<Counters>(path))?.roles.counters, { a: 40, b: 40 })
    assert.ok(reads > 0)
    assert.deepEqual(readdirSync(root), ['seen.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a write cut off halfway never replaces the good file, and leaves no lock behind', async () => {
  const root = folder()
  try {
    const path = join(root, 'seen.json')
    await updateDataFile<string>(path, () => ({ version: 1, roles: { sandbox: 'good' } }))
    const good = readFileSync(path, 'utf8')
    // The temporary file gets half of the text, then the disk fills up.
    const cut = {
      ...NODE_IO,
      async writeTemp(temp: string, text: string) {
        writeFileSync(temp, text.slice(0, Math.floor(text.length / 2)))
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      }
    }
    await assert.rejects(
      updateDataFile<string>(path, () => ({ version: 1, roles: { sandbox: 'x'.repeat(10_000) } }), { io: cut }),
      (error: unknown) => error instanceof DataFileError && error.code === 'data_file_failed'
    )
    assert.equal(readFileSync(path, 'utf8'), good, 'the good file is whole')
    assert.deepEqual(readdirSync(root), ['seen.json'], 'its temporary file and the lock are gone')
    // A temporary file a dead writer left changes nothing either.
    writeFileSync(`${path}.4242.abcdef.tmp`, '{"version":1,"roles":{"sandbox":"ha')
    assert.deepEqual(await readDataFile(path), { version: 1, roles: { sandbox: 'good' } })
    await updateDataFile<string>(path, () => ({ version: 1, roles: { sandbox: 'next' } }))
    assert.deepEqual(await readDataFile(path), { version: 1, roles: { sandbox: 'next' } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a lock is waited for, a stale one is taken over, and one never released fails in time', async () => {
  const root = folder()
  try {
    const path = join(root, 'seen.json')
    // A live writer holds the lock: the update waits, then gives up.
    writeFileSync(`${path}.lock`, 'another')
    const started = Date.now()
    await assert.rejects(
      updateDataFile(path, () => ({ version: 1, roles: {} }), { lockTimeoutMs: 200 }),
      (error: unknown) => error instanceof DataFileError && error.code === 'lock_timeout'
    )
    assert.ok(Date.now() - started >= 200)
    assert.equal(readFileSync(`${path}.lock`, 'utf8'), 'another', 'another writer’s lock is never removed')
    // The same lock, left by a process that died long ago.
    const old = (Date.now() - STALE_LOCK_MS - 5_000) / 1000
    utimesSync(`${path}.lock`, old, old)
    await updateDataFile<number>(path, () => ({ version: 1, roles: { sandbox: 1 } }))
    assert.deepEqual(await readDataFile(path), { version: 1, roles: { sandbox: 1 } })
    assert.deepEqual(readdirSync(root), ['seen.json'])
    // Released by its writer while the update waits: it goes on.
    writeFileSync(`${path}.lock`, 'another')
    setTimeout(() => rmSync(`${path}.lock`), 50)
    await updateDataFile<number>(path, () => ({ version: 1, roles: { sandbox: 2 } }))
    assert.deepEqual(await readDataFile(path), { version: 1, roles: { sandbox: 2 } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a change that answers undefined writes nothing', async () => {
  const root = folder()
  try {
    const path = join(root, 'seen.json')
    assert.equal(await updateDataFile(path, () => undefined), null)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const SAMPLE: Sample = { message: 'TypeError: x is undefined', logger: 'custom.Cart', frames: [{ file: 'app_x/cartridge/scripts/a.js', function: 'run', line: 12 }] }

test('the seen list over seen.json: one table per role, and two workers recording at once lose nothing', async () => {
  const root = folder()
  try {
    const { seen: path } = dataFiles(root)
    // An old worker still stopping and the new one, or two copies of the plugin.
    const first = createSeenList(createSeenFileStore(path))
    const second = createSeenList(createSeenFileStore(path))
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => first.record('sandbox', [{ signature: `first-${i}`, at: i, sample: SAMPLE }])),
      ...Array.from({ length: 20 }, (_, i) => second.record('sandbox', [{ signature: `second-${i}`, at: i, sample: SAMPLE }])),
      second.record('staging', [{ signature: 'stg', at: 1, sample: SAMPLE }])
    ])
    assert.equal((await first.list('sandbox')).length, 40)
    await first.mark('sandbox', ['first-0'], 99)
    assert.equal(await second.newCount('sandbox'), 39, 'a mark by one is seen by the other')
    assert.equal(await second.newCount('staging'), 1)
    const file = (await readDataFile<Record<string, unknown>>(path)) as DataFile<Record<string, unknown>>
    assert.equal(file.version, 1)
    assert.deepEqual(Object.keys(file.roles).sort(), ['sandbox', 'staging'])
    await first.forget('sandbox', 'first-0')
    assert.equal((await second.list('sandbox')).length, 39)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the seen list never overwrites a seen.json it cannot read', async () => {
  const root = folder()
  try {
    const { seen: path } = dataFiles(root)
    writeFileSync(path, 'not json')
    const seen = createSeenList(createSeenFileStore(path))
    await assert.rejects(seen.list('sandbox'), (error: unknown) => error instanceof DataFileError)
    await assert.rejects(seen.record('sandbox', [{ signature: 'a', at: 1, sample: SAMPLE }]), (error: unknown) => error instanceof DataFileError)
    assert.equal(readFileSync(path, 'utf8'), 'not json')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('data-folder.ts loads under plain Node: it imports only Node and explicit .ts files', () => {
  const source = readFileSync(fileURLToPath(new URL('./data-folder.ts', import.meta.url)), 'utf8')
  const imports = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  for (const spec of imports) assert.ok(spec.startsWith('node:') || spec.endsWith('.ts'), spec)
})
