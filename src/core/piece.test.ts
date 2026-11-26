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
/** Pieces with only a manifest fragment: no worker half and no panel section. */
const MANIFEST_ONLY = ['isml']

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

test('every folder of src/pieces is a known piece, and every piece has a folder', () => {
  const folders = readdirSync(join(SRC, 'pieces'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  assert.deepEqual([...folders].sort(), [...PIECE_IDS].sort())
})

test('each piece folder holds what its kind needs', () => {
  for (const id of PIECE_IDS) {
    const dir = join(SRC, 'pieces', id)
    const needed = MANIFEST_ONLY.includes(id) ? ['manifest.json'] : ['manifest.json', 'protocol.ts', 'worker.ts', 'section.tsx', 'i18n.ts']
    for (const file of needed) assert.ok(existsSync(join(dir, file)), `${id}/${file}`)
    assert.ok(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) !== null)
  }
})

test('both registries list every piece that has code, in the order of PIECE_IDS', () => {
  const withCode = PIECE_IDS.filter((id) => !MANIFEST_ONLY.includes(id))
  assert.deepEqual(WORKER_PIECES.map((piece) => piece.id), withCode)
  assert.deepEqual(SECTIONS.map((section) => section.id), withCode)
  for (const section of SECTIONS) {
    assert.ok(section.title('en'), section.id)
    assert.ok(section.title('es'), section.id)
  }
})

test('src/protocol.ts imports the protocol of every piece that has one', () => {
  const imports = importsOf(join(SRC, 'protocol.ts'))
  for (const id of PIECE_IDS.filter((id) => !MANIFEST_ONLY.includes(id))) assert.ok(imports.includes(`./pieces/${id}/protocol`), id)
})

test('only src/core/b2c.ts reads dw.json through dw-config, and only it starts a process', () => {
  for (const file of sourceFiles(SRC)) {
    const name = relative(SRC, file).replace(/\\/g, '/')
    const imports = importsOf(file)
    if (imports.some((spec) => /(^|\/)dw-config$/.test(spec))) assert.equal(name, 'core/b2c.ts', `${name} imports dw-config`)
    if (imports.some((spec) => /child_process$/.test(spec))) assert.equal(name, 'core/b2c.ts', `${name} imports child_process`)
    if (name !== 'core/dw-config.ts') assert.ok(!/['"]dw\.json['"]/.test(readFileSync(file, 'utf8')), `${name} names dw.json`)
  }
})
