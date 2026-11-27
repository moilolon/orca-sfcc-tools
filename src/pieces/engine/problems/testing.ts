// What the problems' tests share: the invented checkout extended with `fixtures/problems/` (a file
// there replaces the checkout's of the same path), built with the committed `dw.*` index, and a
// pass over it.
import { readdirSync, readFileSync } from 'node:fs'
import { CheckoutIndex } from '../checkout/checkout'
import { MemoryFiles } from '../checkout/memory'
import { fixtureEntries } from '../checkout/testing'
import { committedDw, dwLookup } from '../query/testing'
import { CheckoutProblems } from './checkout'
import type { Problem } from './problem'

export const PROBLEMS_ROOT = new URL('../fixtures/problems/', import.meta.url)

export const BASE = 'cartridges/app_garden_base'
export const CORE = 'cartridges/app_garden_core'
export const OUTLET = 'cartridges/app_garden_outlet'

/** The files of `fixtures/problems/`, by relative path, with LF line breaks. */
export function problemEntries(): Record<string, string> {
  const entries: Record<string, string> = {}
  const walk = (url: URL, prefix: string) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, url), `${prefix}${entry.name}/`)
      else entries[`${prefix}${entry.name}`] = readFileSync(new URL(entry.name, url), 'utf8').replace(/\r\n?/g, '\n')
    }
  }
  walk(PROBLEMS_ROOT, '')
  return entries
}

/** The invented checkout with the problem fixtures over it; `changes` replace (or, null, remove) files. */
export function problemFiles(changes: Record<string, string | null> = {}): MemoryFiles {
  const entries: Record<string, string> = { ...fixtureEntries(), ...problemEntries() }
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) delete entries[path]
    else entries[path] = text
  }
  return new MemoryFiles(entries)
}

export type Checked = { index: CheckoutIndex; files: MemoryFiles; problems: CheckoutProblems }

/** The extended checkout, indexed, and one pass over it. */
export async function checked(changes: Record<string, string | null> = {}): Promise<Checked> {
  const files = problemFiles(changes)
  const index = new CheckoutIndex(files, { dw: dwLookup })
  await index.build()
  const problems = new CheckoutProblems(index, files, () => committedDw())
  await problems.run(null)
  return { index, files, problems }
}

/** A problem as a test compares it: its code, line and column, the text of its range, and its names. */
export function brief(text: string, problem: Problem): { code: string; line: number; column: number; at: string; args: Problem['args'] } {
  return { code: problem.code, line: problem.line, column: problem.column, at: text.slice(problem.start, problem.end), args: problem.args }
}

/** The original fixture site archive of the outlet, whose path names a cartridge the checkout does not hold. */
export function outletWithMissingCartridge(): string {
  const text = fixtureEntries()['sites/site_template/sites/GardenOutlet/site.xml']
  if (!text) throw new Error('no outlet site archive')
  return text
}
