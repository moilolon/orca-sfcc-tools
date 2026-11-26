// Builds orca-plugin.json from src/manifest.base.json and every src/pieces/*/manifest.json, so
// each piece declares its own commands, settings, hooks, events and status bar items in its
// folder. Pieces are merged in alphabetical order; the output is the same on every machine.
//
//   node scripts/build-manifest.ts           write orca-plugin.json
//   node scripts/build-manifest.ts --check   exit 1 when the committed file differs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }
export type Fragment = { piece: string; manifest: JsonObject }

/** The field that names an entry of each contribution list; two entries may not share it. */
const IDENTITY: Record<string, string> = {
  panels: 'id',
  commands: 'id',
  events: 'on',
  hooks: 'event',
  settings: 'key',
  statusBarItems: 'id',
  keybindings: 'key',
  syntaxes: 'id',
  customEditors: 'id',
  newFiles: 'id',
  languagePacks: 'locale',
  themes: 'id',
  terminalThemes: 'id',
  iconThemes: 'id'
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The base with each fragment's `contributes` lists appended, fragment by fragment in the order
 * given. A fragment holds `contributes` and nothing else: identity, engine and the access list
 * stay in the base, where a change is seen.
 */
export function mergeManifest(base: JsonObject, fragments: readonly Fragment[]): JsonObject {
  const merged: JsonObject = JSON.parse(JSON.stringify(base))
  const contributes: JsonObject = isObject(merged.contributes) ? merged.contributes : {}
  merged.contributes = contributes
  for (const { piece, manifest } of fragments) {
    if (!isObject(manifest)) throw new Error(`${piece}: manifest.json must be an object`)
    for (const key of Object.keys(manifest)) {
      if (key !== 'contributes') throw new Error(`${piece}: manifest.json may only hold "contributes", not "${key}"`)
    }
    const own = manifest.contributes
    if (own === undefined) continue
    if (!isObject(own)) throw new Error(`${piece}: "contributes" must be an object`)
    for (const [kind, entries] of Object.entries(own)) {
      if (!Array.isArray(entries)) throw new Error(`${piece}: contributes.${kind} must be a list`)
      const list = Array.isArray(contributes[kind]) ? (contributes[kind] as Json[]) : []
      const field = IDENTITY[kind]
      for (const entry of entries) {
        if (field && isObject(entry)) {
          const clash = list.some((other) => isObject(other) && other[field] === entry[field])
          if (clash) throw new Error(`${piece}: contributes.${kind} already has ${field} "${String(entry[field])}"`)
        }
        list.push(entry)
      }
      contributes[kind] = list
    }
  }
  return merged
}

export function serialize(manifest: JsonObject): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The base and the fragments as they are on disk, pieces in alphabetical order. */
export function readSources(root = ROOT): { base: JsonObject; fragments: Fragment[] } {
  const base = JSON.parse(readFileSync(join(root, 'src', 'manifest.base.json'), 'utf8'))
  const piecesDir = join(root, 'src', 'pieces')
  const pieces = readdirSync(piecesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const fragments = pieces.map((piece) => ({ piece, manifest: JSON.parse(readFileSync(join(piecesDir, piece, 'manifest.json'), 'utf8')) }))
  return { base, fragments }
}

export function buildManifest(root = ROOT): string {
  const { base, fragments } = readSources(root)
  return serialize(mergeManifest(base, fragments))
}

function main(): void {
  const target = join(ROOT, 'orca-plugin.json')
  const built = buildManifest()
  if (process.argv.includes('--check')) {
    let committed = ''
    try {
      committed = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      // A missing file differs.
    }
    if (committed !== built) {
      console.error('orca-plugin.json differs from the merge of its fragments: run npm run manifest')
      process.exit(1)
    }
    console.log('orca-plugin.json matches the merge of its fragments')
    return
  }
  writeFileSync(target, built)
  console.log('wrote orca-plugin.json')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
