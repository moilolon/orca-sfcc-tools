// The registries and the boundaries between modules: every piece folder is known and wired, and
// only the modules that are meant to read dw.json or start a process do.
import { assert, test } from 'orca/testing'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECTIONS } from '../panel/sections'
import { WORKER_PIECES } from '../worker/pieces'
import { PIECE_IDS } from './piece'

const SRC = fileURLToPath(new URL('..', import.meta.url))
/** Pieces with no worker half: a manifest fragment and a panel entry, nothing that runs. */
const NO_WORKER = ['isml']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'test-support.ts' ? [path] : []
  })
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}

/**
 * Whether a source names the configuration file as a path: a string or template literal that is
 * `dw.json` or ends in it after a path separator or a `${…}`. A sentence that mentions the file
 * (`'… is not configured in dw.json.'`) is not a path, and neither is a comment.
 */
export function namesConfigFile(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  return /(['"`])(?:[^'"`\n]*[\\/}])?dw\.json\1/.test(code)
}

test('every folder of src/pieces is a known piece, and every piece has a folder', () => {
  const folders = readdirSync(join(SRC, 'pieces'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  assert.deepEqual([...folders].sort(), [...PIECE_IDS].sort())
})

test('each piece folder holds what its kind needs', () => {
  for (const id of PIECE_IDS) {
    const dir = join(SRC, 'pieces', id)
    const needed = ['manifest.json', 'section.tsx', 'scenarios.ts', 'i18n.ts', ...(NO_WORKER.includes(id) ? [] : ['protocol.ts', 'worker.ts'])]
    for (const file of needed) assert.ok(existsSync(join(dir, file)), `${id}/${file}`)
    assert.ok(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) !== null)
  }
})

test('the registries list every piece, in the order of PIECE_IDS', () => {
  assert.deepEqual(WORKER_PIECES.map((piece) => piece.id), PIECE_IDS.filter((id) => !NO_WORKER.includes(id)))
  assert.deepEqual(SECTIONS.map((section) => section.id), [...PIECE_IDS])
  for (const section of SECTIONS) {
    assert.ok(section.title('en'), section.id)
    assert.ok(section.title('es'), section.id)
    assert.equal(typeof section.delivered, 'boolean', section.id)
    assert.equal(typeof section.hasView, 'boolean', section.id)
  }
})

test('src/protocol.ts imports the protocol of every piece that has one', () => {
  const imports = importsOf(join(SRC, 'protocol.ts'))
  for (const id of PIECE_IDS.filter((id) => !NO_WORKER.includes(id))) assert.ok(imports.includes(`./pieces/${id}/protocol`), id)
})

test('src/panel/checks.ts merges the scenarios of every piece, and the check file hands them to Orca', () => {
  const imports = importsOf(join(SRC, 'panel', 'checks.ts'))
  for (const id of PIECE_IDS) assert.ok(imports.includes(`../pieces/${id}/scenarios`), id)
  const check = readFileSync(join(SRC, 'panel', 'panel.check.ts'), 'utf8')
  assert.deepEqual(importsOf(join(SRC, 'panel', 'panel.check.ts')), ['orca/testing', './checks'])
  assert.match(check, /^export default defineCheck\(CHECKS\)$/m)
})

test('a piece is wired by its folder alone: no shared module names a piece outside the registries', () => {
  const registries = ['core/piece.ts', 'protocol.ts', 'panel/sections.ts', 'panel/checks.ts', 'worker/pieces.ts']
  for (const file of sourceFiles(SRC)) {
    const name = relative(SRC, file).replace(/\\/g, '/')
    if (name.startsWith('pieces/') || registries.includes(name)) continue
    assert.deepEqual(importsOf(file).filter((spec) => /(^|\/)pieces\//.test(spec)), [], `${name} imports a piece`)
  }
})

/** The test files of a folder and of the folders below it. */
function testsIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return testsIn(path)
    return /\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** A request or event of a piece, as its protocol names them: `sandbox.status`, `errors.changed`. */
export function namesOfPieces(source: string): string[] {
  return [...source.matchAll(new RegExp(`['"\`]((?:${PIECE_IDS.join('|')})\\.[a-z][\\w.]*)['"\`]`, 'g'))].map((match) => match[1])
}

test('the tests of the panel and of the worker borrow no request or event name of a piece', () => {
  // A piece types its own names in its protocol. A shared test that mounts the panel or the
  // worker and used one with a payload of its own would stop compiling the day the piece is
  // delivered, and the phase would have to edit a file outside its folder.
  assert.deepEqual(namesOfPieces(`plugin.on('sandbox.changed', x); request("errors.list"); post(\`isml.x\`)`), ['sandbox.changed', 'errors.list', 'isml.x'])
  assert.deepEqual(namesOfPieces(`plugin.on('probe.changed', x); 'core.status'; 'sandbox'; 'sandboxWatching'; 'x.sandbox.y'`), [])
  const shared = [...testsIn(join(SRC, 'panel')), ...testsIn(join(SRC, 'worker'))]
  assert.ok(shared.length >= 2, 'the shared tests were found')
  for (const file of shared) {
    assert.deepEqual(namesOfPieces(readFileSync(file, 'utf8')), [], `${relative(SRC, file).replace(/\\/g, '/')} uses a piece's own names`)
  }
})

test('only src/core/b2c.ts reads dw.json through dw-config; only it, src/core/open-file.ts and the engine’s git.ts start a process', () => {
  // open-file.ts starts Orca's own command line, never b2c; the engine's checkout/git.ts starts
  // git, read-only. Neither imports anything of b2c.ts or dw-config.ts, so no value read from
  // dw.json can reach them.
  const starters = ['core/b2c.ts', 'core/open-file.ts', 'pieces/engine/checkout/git.ts']
  for (const file of sourceFiles(SRC)) {
    const name = relative(SRC, file).replace(/\\/g, '/')
    const imports = importsOf(file)
    if (imports.some((spec) => /(^|\/)dw-config$/.test(spec))) assert.equal(name, 'core/b2c.ts', `${name} imports dw-config`)
    if (imports.some((spec) => /child_process$/.test(spec))) assert.ok(starters.includes(name), `${name} imports child_process`)
    if (name === 'core/open-file.ts' || name === 'pieces/engine/checkout/git.ts') assert.deepEqual(imports.filter((spec) => /(^|\/)(b2c|dw-config)$/.test(spec)), [], `${name} imports b2c.ts or dw-config.ts`)
    if (name !== 'core/dw-config.ts') assert.ok(!namesConfigFile(readFileSync(file, 'utf8')), `${name} names dw.json as a path`)
  }
})

test('the check for dw.json catches every way of writing its path, and no sentence about it', () => {
  const paths = [
    `join(root, 'dw.json')`,
    `join(root, "dw.json")`,
    'join(root, `dw.json`)',
    `readFile('config/dw.json')`,
    `readFile('..\\\\dw.json')`,
    'readFile(`${root}/dw.json`)',
    'readFile(`${root}\\\\config/dw.json`)',
    'readFile(`${name}dw.json`)',
    `const file = "C:/work/shop/dw.json"`
  ]
  for (const source of paths) assert.ok(namesConfigFile(source), source)
  const sentences = [
    `'That environment is not configured in dw.json.'`,
    `'Read from the workspace’s dw.json. Hosts and credentials are never shown.'`,
    `'dw.json has no client id and secret for that environment.'`,
    '`No dw.json was found for ${name}`',
    `const other = ['dw.jsonc', "my-dw.json"]`,
    '// The file is `dw.json`, at the root.',
    `const url = 'https://example.com/docs' // see 'dw.json'`,
    '/**\n * Reads `dw.json`, or "config/dw.json".\n */'
  ]
  for (const source of sentences) assert.ok(!namesConfigFile(source), source)
})
