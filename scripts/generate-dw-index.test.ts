// The generator on invented `b2c docs` output (src/pieces/engine/fixtures/dw), with a fake runner:
// the expected index, built only from role-less `docs` commands the runner's guard lets through,
// at most four at a time; the id of every answer checked; and a whole index or none.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { B2cError, type RunOptions, type RunResult } from '../src/core/b2c'
import { guard, refusedFlag } from '../src/core/instances'
import { loadDwIndex, type DwIndexData } from '../src/pieces/engine/dw/index'
import { DOCS_FLAGS } from '../src/pieces/engine/dw/describe'
import { CONCURRENCY, DEFAULT_OUT, GenerateError, generateIndex, listEntries, outOf, readClass, serializeIndex, writeWhole } from './generate-dw-index'

const FIXTURES = new URL('../src/pieces/engine/fixtures/dw/', import.meta.url)
/** A fixture with LF line ends, however the checkout wrote it. */
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8').replace(/\r\n?/g, '\n')
const LIST = JSON.parse(fixture('list.json')) as { entries: Array<Record<string, string>> }
const EXPECTED = JSON.parse(fixture('expected-index.json')) as DwIndexData
const TODAY = '2026-01-01'

type Call = { args: readonly string[]; options: RunOptions | undefined }
type Answer = (id: string) => unknown

/**
 * A runner that answers `docs search --list` with `list` and `docs read <id>` with the fixture
 * page, or what `answer` gives; it records every call and the most reads run at once.
 */
function fakeRunner({ list = LIST, answer, pages = {} }: { list?: unknown; answer?: Answer; pages?: Record<string, string> } = {}) {
  const calls: Call[] = []
  let running = 0
  let most = 0
  const run = async (args: readonly string[], options?: RunOptions): Promise<RunResult> => {
    calls.push({ args, options })
    if (args[1] === 'search') return { stdout: '', stderr: '', json: list }
    running++
    most = Math.max(most, running)
    try {
      await new Promise((resolve) => setTimeout(resolve, 2))
      const id = args[2]
      if (answer) {
        const json = answer(id)
        if (json instanceof Error) throw json
        return { stdout: '', stderr: '', json }
      }
      return { stdout: '', stderr: '', json: { entry: { id }, content: pages[id] ?? fixture(`${id}.md`) } }
    } finally {
      running--
    }
  }
  return { b2c: { run }, calls, most: () => most }
}

/** A list of `count` extra invented classes beside the fixture's, each with a minimal page. */
function manyClasses(count: number) {
  const ids = Array.from({ length: count }, (_, at) => `dw.garden.Seed${at}`)
  const pages: Record<string, string> = {}
  for (const id of ids) {
    const name = id.slice(id.lastIndexOf('.') + 1)
    pages[id] = [
      `# Class ${name}`,
      '',
      '- [TopLevel.Object](/script-api/TopLevel.Object.md)',
      `  - [${id}](/script-api/${id}.md)`,
      '',
      'An invented seed.',
      '',
      '## Constructor Summary',
      '',
      'This class does not have a constructor, so you cannot create it directly.',
      '',
      '## Method Summary',
      ''
    ].join('\n')
  }
  const entries = [...LIST.entries, ...ids.map((id) => ({ id, title: `Class ${id.slice(id.lastIndexOf('.') + 1)}`, url: `https://docs.example.com/script-api/${id}.html` }))]
  return { list: { entries }, pages, ids }
}

test('turns invented b2c docs output into the expected index', async () => {
  const { b2c } = fakeRunner()
  const index = await generateIndex({ b2c, today: TODAY })
  assert.deepEqual(index, EXPECTED)
  assert.equal(serializeIndex(index), fixture('expected-index.json'))
})

test('runs only role-less docs commands, which the runner’s guard and flag list let through', async () => {
  const { b2c, calls } = fakeRunner()
  await generateIndex({ b2c, today: TODAY, cwd: 'C:\\empty' })
  assert.equal(calls.length, 1 + 4)
  assert.deepEqual(calls[0].args, ['docs', 'search', '--list', '-c', 'script-api', '--workspace', 'all'])
  for (const { args, options } of calls) {
    assert.deepEqual(guard(args, undefined), { ok: true, needsRole: false }, args.join(' '))
    assert.equal(refusedFlag(args), -1, args.join(' '))
    assert.equal(options?.role, undefined)
    assert.equal(options?.cwd, 'C:\\empty')
    // Without it b2c walks its working folder before answering.
    assert.deepEqual(args.slice(-2), ['--workspace', 'all'])
  }
  assert.deepEqual(
    calls.slice(1).map((call) => call.args.slice(0, 3)).sort(),
    ['TopLevel.Object', 'dw.garden.GardenMgr', 'dw.garden.Plant', 'dw.garden.Tree'].map((id) => ['docs', 'read', id])
  )
})

test('reads at most four classes at a time, every class once', async () => {
  const many = manyClasses(17)
  const fake = fakeRunner({ list: many.list, pages: many.pages })
  const index = await generateIndex({ b2c: fake.b2c, today: TODAY })
  assert.equal(CONCURRENCY, 4)
  assert.equal(fake.most(), 4)
  assert.equal(Object.keys(index.classes).length, 4 + 17)
  const reads = fake.calls.filter((call) => call.args[1] === 'read').map((call) => call.args[2])
  assert.equal(new Set(reads).size, reads.length)
  const slower = fakeRunner({ list: many.list, pages: many.pages })
  await generateIndex({ b2c: slower.b2c, today: TODAY, concurrency: 2 })
  assert.equal(slower.most(), 2)
})

test('an answer for another class than the one asked fails, naming it', async () => {
  // b2c docs read matches a name it does not know to another class, without failing.
  const { b2c } = fakeRunner({
    answer: (id) => ({ entry: { id: id === 'dw.garden.Plant' ? 'dw.garden.PlantMgr' : id }, content: fixture(`${id}.md`) })
  })
  await assert.rejects(generateIndex({ b2c, today: TODAY }), (error: unknown) => {
    assert.ok(error instanceof GenerateError)
    assert.ok(error.problems.some((problem) => problem.startsWith('dw.garden.Plant: b2c answered another page (dw.garden.PlantMgr)')), error.message)
    return true
  })
  await assert.rejects(readClass(b2c, 'dw.garden.Plant'), /answered another page/)
  const empty = fakeRunner({ answer: (id) => ({ entry: { id }, content: '' }) })
  await assert.rejects(readClass(empty.b2c, 'dw.garden.Plant'), /no Markdown/)
})

test('a failed read stops the run: nothing new starts, the class and b2c’s code are named', async () => {
  const many = manyClasses(17)
  let reads = 0
  const fake = fakeRunner({
    list: many.list,
    answer: (id) => {
      reads++
      if (id === 'dw.garden.Seed10') return new B2cError('b2c_failed', { exitCode: 2, detail: 'Request failed with status 403' })
      return { entry: { id }, content: many.pages[id] ?? fixture(`${id}.md`) }
    }
  })
  await assert.rejects(generateIndex({ b2c: fake.b2c, today: TODAY }), (error: unknown) => {
    assert.ok(error instanceof GenerateError)
    assert.ok(error.problems.includes('dw.garden.Seed10: b2c failed (b2c_failed: Request failed with status 403)'), error.message)
    assert.ok(error.problems.some((problem) => /^stopped after a failed read: \d+ of 21 classes read, nothing written$/.test(problem)), error.message)
    return true
  })
  // The ids are read in order; once Seed10 failed, only reads already running finish.
  assert.ok(reads < 21 && reads <= 2 + 10 + CONCURRENCY, `${reads} reads`)
})

test('a page of an unexpected shape fails the run with its class and section, after every page is read', async () => {
  const tree = fixture('dw.garden.Tree.md').replace('- height: [Number]', '- height [Number]')
  const plant = fixture('dw.garden.Plant.md').replace('## Constant Summary', '## Colour Summary')
  const fake = fakeRunner({ pages: { 'dw.garden.Tree': tree, 'dw.garden.Plant': plant } })
  await assert.rejects(generateIndex({ b2c: fake.b2c, today: TODAY }), (error: unknown) => {
    assert.ok(error instanceof GenerateError)
    assert.equal(error.problems.length, 2)
    assert.match(error.problems[0], /^dw\.garden\.Plant, Colour Summary: unknown section$/)
    assert.match(error.problems[1], /^dw\.garden\.Tree, Property Details > height: /)
    return true
  })
  assert.equal(fake.calls.length, 1 + 4)
})

test('a superclass or a subclass without a page of its own fails the run', async () => {
  const list = { entries: LIST.entries.filter((entry) => entry.id !== 'dw.garden.Plant') }
  await assert.rejects(generateIndex({ b2c: fakeRunner({ list }).b2c, today: TODAY }), /dw\.garden\.Tree, inheritance: its superclass dw\.garden\.Plant has no page/)
})

test('the list of entries gives the version, the address of the pages and every class, or fails', async () => {
  const listing = await listEntries(fakeRunner().b2c)
  assert.deepEqual(listing, {
    version: '99.1',
    base: 'https://docs.example.com/script-api/',
    classes: ['TopLevel.Object', 'dw.garden.GardenMgr', 'dw.garden.Plant', 'dw.garden.Tree']
  })
  const without = (id: string) => ({ entries: LIST.entries.filter((entry) => entry.id !== id) })
  const withEntry = (entry: Record<string, string>) => ({ entries: [...LIST.entries, entry] })
  await assert.rejects(listEntries(fakeRunner({ list: without('index') }).b2c), /no index entry naming the version/)
  await assert.rejects(listEntries(fakeRunner({ list: without('dw.garden') }).b2c), /dw\.garden\.Plant: its package dw\.garden is not in the list/)
  await assert.rejects(listEntries(fakeRunner({ list: withEntry({ id: 'dw.garden.Guide', title: 'Guide to gardens', url: 'https://docs.example.com/script-api/dw.garden.Guide.html' }) }).b2c), /unexpected entry/)
  await assert.rejects(listEntries(fakeRunner({ list: withEntry({ id: 'dw.garden.Pond', title: 'Class Pond', url: 'https://other.example.com/x/dw.garden.Pond.html' }) }).b2c), /2 addresses, not one/)
  await assert.rejects(listEntries(fakeRunner({ list: { results: [] } }).b2c), /no "entries"/)
})

test('the index is written in a fixed form: sorted, one member per line, the same text whatever the key order', () => {
  const shuffled: DwIndexData = JSON.parse(JSON.stringify(EXPECTED))
  shuffled.classes = Object.fromEntries(Object.entries(shuffled.classes).reverse().map(([id, cls]) => [id, Object.fromEntries(Object.entries(cls).reverse())]))
  for (const cls of Object.values(shuffled.classes)) {
    for (const members of [cls.constants, cls.properties, cls.constructors, cls.methods]) {
      members?.forEach((member, at) => (members[at] = Object.fromEntries(Object.entries(member).reverse()) as typeof member))
    }
  }
  const text = serializeIndex(EXPECTED)
  assert.equal(serializeIndex(shuffled), text)
  assert.deepEqual(JSON.parse(text), EXPECTED)
  assert.ok(text.endsWith('}\n'))
  assert.ok(text.includes('\n        {"name":"tag","params":[{"name":"labels","type":"TopLevel.String[]"}],"returns":"void"},\n'))
  assert.ok(text.indexOf('"TopLevel.Object": {') < text.indexOf('"dw.garden.GardenMgr": {'))
})

test('writing replaces the file whole and leaves nothing beside it', () => {
  const folder = mkdtempSync(join(tmpdir(), 'dw-index-test-'))
  try {
    const target = join(folder, 'dw-api.json')
    writeWhole(target, 'first')
    writeWhole(target, serializeIndex(EXPECTED))
    assert.deepEqual(readdirSync(folder), ['dw-api.json'])
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), EXPECTED)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a rename that fails leaves no temporary file behind', () => {
  const folder = mkdtempSync(join(tmpdir(), 'dw-index-test-'))
  try {
    // Writing over a folder: the rename is refused.
    const target = join(folder, 'taken')
    mkdirSync(target)
    assert.throws(() => writeWhole(target, 'text'))
    assert.deepEqual(readdirSync(folder), ['taken'])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('--out is checked before the run: a value, naming a file in a folder that exists', () => {
  const folder = mkdtempSync(join(tmpdir(), 'dw-index-test-'))
  try {
    assert.equal(outOf([]), DEFAULT_OUT)
    assert.equal(outOf(['--out', 'index.json'], folder), join(folder, 'index.json'))
    assert.throws(() => outOf(['--out'], folder), /--out needs a file name/)
    assert.throws(() => outOf(['--out', ''], folder), /--out needs a file name/)
    assert.throws(() => outOf(['--out', '--json'], folder), /--out needs a file name/)
    assert.throws(() => outOf(['--out', '.'], folder), /is a folder/)
    assert.throws(() => outOf(['--out', join('missing', 'index.json')], folder), /does not exist/)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('the generator and the descriptions pass the same docs flags', () => {
  assert.deepEqual(DOCS_FLAGS, ['--workspace', 'all'])
})

test('the committed data/dw-api.json is in the generator’s own form and loads', () => {
  const text = readFileSync(DEFAULT_OUT, 'utf8').replace(/\r\n?/g, '\n')
  const data = JSON.parse(text) as DwIndexData
  assert.equal(serializeIndex(data), text, 'regenerate with npm run dw-index')
  loadDwIndex(data)
})
