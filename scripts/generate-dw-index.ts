// Builds data/dw-api.json, the `dw.*` index, from the public Script API documentation:
//
//   npm run dw-index                     (node --import ./scripts/resolve-ts.ts scripts/generate-dw-index.ts)
//   npm run dw-index -- --out <file>     writes elsewhere
//
// Run by the owner on his own machine, never on a hosted runner (the documentation's CDN blocks
// those). It lists the Script API entries with `b2c docs search --list` and reads each class with
// `b2c docs read`, through the plugin's own runner (src/core/b2c.ts) with no role: `docs` reads
// public pages and gets no credentials, and the runner's guard and masking apply as in the
// plugin. At most four reads run at a time, in an empty folder of their own.
//
// The index holds the facts of the interface (./dw-pages.ts) and no description. It is written
// whole or not at all: any read that fails stops the run, and every page whose shape is not the
// expected one is named with its section before the run fails.
import { existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { B2cError, createB2c, type B2c } from '../src/core/b2c'
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings'
import { DOCS_FLAGS } from '../src/pieces/engine/dw/describe'
import { DW_INDEX_FORMAT, loadDwIndex, type DwClassData, type DwIndexData } from '../src/pieces/engine/dw/index'
import { PageShapeError, parseClassPage, versionOf } from './dw-pages'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_OUT = join(ROOT, 'data', 'dw-api.json')

/** Reads at the same time. Each one is a `b2c` process and one request to the documentation. */
export const CONCURRENCY = 4

/** The id of the documentation's own index entry, whose title names its version. */
const INDEX_ENTRY = 'index'

type Runner = Pick<B2c, 'run'>

/** Why the run stopped: every problem found, each on its own line. */
export class GenerateError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(problems.join('\n'))
    this.name = 'GenerateError'
    this.problems = problems
  }
}

export type Listing = { version: string; base: string; classes: string[] }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The documentation's version, the address its pages are under, and every class id, sorted. */
export async function listEntries(b2c: Runner, cwd?: string): Promise<Listing> {
  const { json } = await b2c.run(['docs', 'search', '--list', '-c', 'script-api', ...DOCS_FLAGS], { cwd })
  const entries = isObject(json) && Array.isArray(json.entries) ? json.entries : null
  if (!entries) throw new GenerateError(['the list of entries: no "entries" in the answer'])
  let version: string | null = null
  const bases = new Set<string>()
  const packages = new Set<string>()
  const classes: string[] = []
  const problems: string[] = []
  for (const entry of entries) {
    const id = isObject(entry) && typeof entry.id === 'string' ? entry.id : null
    const title = isObject(entry) && typeof entry.title === 'string' ? entry.title : null
    const url = isObject(entry) && typeof entry.url === 'string' ? entry.url : null
    if (!id || !title || !url) {
      problems.push(`the list of entries: an entry without an id, a title or an address`)
      continue
    }
    if (url.endsWith(`/${id}.html`)) bases.add(url.slice(0, -`${id}.html`.length))
    else problems.push(`${id}: its address does not end with its id`)
    if (id === INDEX_ENTRY) {
      try {
        version = versionOf(title)
      } catch (error) {
        problems.push((error as Error).message)
      }
    } else if (title === `Package ${id}`) packages.add(id)
    else if (title === `Class ${id.slice(id.lastIndexOf('.') + 1)}` && id.includes('.')) classes.push(id)
    else problems.push(`${id}: unexpected entry "${title}"`)
  }
  if (!version) problems.push('the list of entries: no index entry naming the version')
  if (!classes.length) problems.push('the list of entries: no class')
  if (bases.size !== 1) problems.push(`the list of entries: the pages are under ${bases.size} addresses, not one`)
  for (const id of classes) {
    const pkg = id.slice(0, id.lastIndexOf('.'))
    if (!packages.has(pkg)) problems.push(`${id}: its package ${pkg} is not in the list`)
  }
  if (problems.length) throw new GenerateError(problems)
  return { version: version as string, base: [...bases][0], classes: classes.sort() }
}

/**
 * A class page's Markdown. `b2c docs read` matches a name it does not know to another class
 * without failing: the answer must be the page asked for.
 */
export async function readClass(b2c: Runner, id: string, cwd?: string): Promise<string> {
  const { json } = await b2c.run(['docs', 'read', id, ...DOCS_FLAGS], { cwd })
  const entry = isObject(json) && isObject(json.entry) ? json.entry : null
  if (!entry || entry.id !== id) throw new Error(`${id}: b2c answered another page (${typeof entry?.id === 'string' ? entry.id : 'none'})`)
  if (!isObject(json) || typeof json.content !== 'string' || !json.content) throw new Error(`${id}: b2c answered no Markdown`)
  return json.content
}

/** What a failed read says: the class and b2c's error code, with its (masked) detail. */
function readProblem(id: string, error: unknown): string {
  if (error instanceof B2cError) return `${id}: b2c failed (${error.code}${error.detail ? `: ${error.detail}` : ''})`
  return error instanceof Error ? error.message : `${id}: ${String(error)}`
}

export type GenerateOptions = {
  b2c: Runner
  /** The date written in the index, `YYYY-MM-DD`. */
  today: string
  /** Where `b2c` runs: best an empty folder. */
  cwd?: string
  concurrency?: number
  onProgress?: (done: number, total: number) => void
}

/** The whole index, or a GenerateError naming every problem. */
export async function generateIndex(options: GenerateOptions): Promise<DwIndexData> {
  const { b2c, cwd } = options
  const listing = await listEntries(b2c, cwd)
  const pages = new Map<string, DwClassData>()
  const problems: string[] = []
  let failedRead = false
  let next = 0
  let done = 0
  const worker = async () => {
    // After a failed read nothing new starts: a refusal is not lifted by asking again.
    while (next < listing.classes.length && !failedRead) {
      const id = listing.classes[next++]
      let markdown: string
      try {
        markdown = await readClass(b2c, id, cwd)
      } catch (error) {
        failedRead = true
        problems.push(readProblem(id, error))
        continue
      }
      try {
        pages.set(id, parseClassPage(id, markdown))
      } catch (error) {
        if (!(error instanceof PageShapeError)) throw error
        problems.push(error.message)
      }
      options.onProgress?.(++done, listing.classes.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? CONCURRENCY) }, worker))
  if (failedRead) problems.push(`stopped after a failed read: ${done} of ${listing.classes.length} classes read, nothing written`)
  if (problems.length) throw new GenerateError(problems.sort())

  const classes: Record<string, DwClassData> = {}
  for (const id of listing.classes) {
    const entry = pages.get(id) as DwClassData
    if (entry.super && !pages.has(entry.super)) problems.push(`${id}, inheritance: its superclass ${entry.super} has no page`)
    for (const sub of entry.subclasses ?? []) if (!pages.has(sub)) problems.push(`${id}, All Known Subclasses: ${sub} has no page`)
    classes[id] = entry
  }
  if (problems.length) throw new GenerateError(problems)
  const index: DwIndexData = { format: DW_INDEX_FORMAT, version: listing.version, generated: options.today, base: listing.base, classes }
  loadDwIndex(index)
  return index
}

const CLASS_KEYS = ['super', 'subclasses', 'deprecated', 'constants', 'properties', 'constructors', 'methods'] as const
const MEMBER_KEYS = ['name', 'key', 'type', 'value', 'params', 'returns', 'static', 'readOnly', 'deprecated'] as const
const PARAM_KEYS = ['name', 'type', 'rest'] as const

/** `value` with only `keys`, in that order. */
function ordered(value: object, keys: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

/**
 * The index as written: one class per block, one member per line, keys in a fixed order and
 * classes sorted by id, so a regeneration changes only the lines of what changed.
 */
export function serializeIndex(index: DwIndexData): string {
  const lines = ['{']
  lines.push(`  "format": ${JSON.stringify(index.format)},`)
  lines.push(`  "version": ${JSON.stringify(index.version)},`)
  lines.push(`  "generated": ${JSON.stringify(index.generated)},`)
  lines.push(`  "base": ${JSON.stringify(index.base)},`)
  lines.push('  "classes": {')
  const ids = Object.keys(index.classes).sort()
  ids.forEach((id, at) => {
    const cls = ordered(index.classes[id], CLASS_KEYS)
    const fields = Object.entries(cls).map(([key, value]) => {
      if (!Array.isArray(value) || key === 'subclasses') return `      ${JSON.stringify(key)}: ${JSON.stringify(value)}`
      const members = value.map((member: Record<string, unknown>) => {
        const tidy = ordered(member, MEMBER_KEYS)
        if (Array.isArray(tidy.params)) tidy.params = tidy.params.map((param: object) => ordered(param, PARAM_KEYS))
        return `        ${JSON.stringify(tidy)}`
      })
      return `      ${JSON.stringify(key)}: [\n${members.join(',\n')}\n      ]`
    })
    const body = fields.length ? `{\n${fields.join(',\n')}\n    }` : '{}'
    lines.push(`    ${JSON.stringify(id)}: ${body}${at < ids.length - 1 ? ',' : ''}`)
  })
  lines.push('  }', '}', '')
  return lines.join('\n')
}

/** Writes `text` to `path` whole: to a file beside it first, then renamed over it. */
export function writeWhole(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, text)
    renameSync(temporary, path)
  } catch (error) {
    // A rename refused (the target is a folder, or held open) leaves nothing behind.
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Where to write, from the command line: `--out <file>`, else data/dw-api.json. Checked before
 * the run, so a mistake is not found after a quarter of an hour: the value must be given, and
 * name a file (not a folder) in a folder that exists.
 */
export function outOf(argv: readonly string[], base: string = process.cwd()): string {
  const at = argv.indexOf('--out')
  if (at === -1) return DEFAULT_OUT
  const value = argv[at + 1]
  if (!value || value.startsWith('-')) throw new Error('--out needs a file name')
  const out = resolve(base, value)
  if (!existsSync(dirname(out)) || !statSync(dirname(out)).isDirectory()) throw new Error(`--out: the folder ${dirname(out)} does not exist`)
  if (existsSync(out) && statSync(out).isDirectory()) throw new Error(`--out: ${out} is a folder`)
  return out
}

/** Settings with nothing set: `b2c` from the PATH, and no dw.json is ever looked for. */
const NO_SETTINGS: Settings = {
  read: async () => ({ ...DEFAULT_SETTINGS }),
  suffixes: async () => ({ development: DEFAULT_SETTINGS.developmentSuffix, staging: DEFAULT_SETTINGS.stagingSuffix, production: DEFAULT_SETTINGS.productionSuffix }),
  onDidChange: () => ({ dispose() {} })
}

async function main(): Promise<void> {
  let out: string
  try {
    out = outOf(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
    return
  }
  // The runner logs every exit; only the ones that went wrong are worth a line here.
  const log = (message: string) => {
    if (!message.endsWith(': exit 0')) console.error(message)
  }
  const b2c = createB2c({ settings: NO_SETTINGS, configRoot: async () => null, log })
  const cwd = mkdtempSync(join(tmpdir(), 'dw-index-'))
  const started = Date.now()
  try {
    const index = await generateIndex({
      b2c,
      cwd,
      today: new Date().toISOString().slice(0, 10),
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) console.error(`${done} of ${total} classes read`)
      }
    })
    writeWhole(out, serializeIndex(index))
    console.log(`wrote ${out}: ${Object.keys(index.classes).length} classes, Script API ${index.version}, in ${Math.round((Date.now() - started) / 1000)} s`)
  } catch (error) {
    console.error(error instanceof GenerateError ? `nothing written:\n${error.message}` : error)
    process.exitCode = 1
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
