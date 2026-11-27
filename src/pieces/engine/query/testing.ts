// What the query tests share: the committed `dw.*` index, the invented checkout built once, and a
// text with its cursor written as `‸`.
import { readFileSync } from 'node:fs'
import { CheckoutIndex } from '../checkout/checkout'
import { fixtureEntries, fixtureFiles } from '../checkout/testing'
import { loadDwIndex, type DwIndex } from '../dw/index'
import { analyse, type Analysis } from './analysis'
import type { QueryContext } from './modules'

export const BASE = 'cartridges/app_garden_base'
export const CORE = 'cartridges/app_garden_core'
export const OUTLET = 'cartridges/app_garden_outlet'

/** The cursor in a test's text. */
export const CURSOR = '‸'

let dwIndex: DwIndex | null = null

/** The committed index of data/dw-api.json, loaded once. */
export function committedDw(): DwIndex {
  dwIndex ??= loadDwIndex(JSON.parse(readFileSync(new URL('../../../../data/dw-api.json', import.meta.url), 'utf8')))
  return dwIndex
}

/** A lookup of `dw/…` module paths over the committed index, as the worker gives the checkout index. */
export function dwLookup(module: string): string | null {
  const dw = committedDw()
  return dw.findClass(module)?.id ?? (dw.packageClasses(module).length > 0 ? module.replace(/\//g, '.') : null)
}

let built: Promise<QueryContext> | null = null

/** The invented checkout, built once for every test of a file. */
export function fixtureContext(): Promise<QueryContext> {
  built ??= (async () => {
    const index = new CheckoutIndex(fixtureFiles(), { dw: dwLookup })
    await index.build()
    return { index, dw: committedDw() }
  })()
  return built
}

/** A text with `‸` marking the offset: the text without it, and the offset. */
export function cursor(marked: string): { text: string; offset: number } {
  const offset = marked.indexOf(CURSOR)
  if (offset === -1 || marked.indexOf(CURSOR, offset + 1) !== -1) throw new Error('one cursor expected')
  return { text: marked.slice(0, offset) + marked.slice(offset + CURSOR.length), offset }
}

/** Reads a marked text as the file at `path`: its analysis and the offset. */
export function at(path: string, marked: string): { analysis: Analysis; offset: number; text: string } {
  const { text, offset } = cursor(marked)
  return { analysis: analyse(path, text), offset, text }
}

/** A file of the invented checkout, with LF line breaks. */
export function fixtureText(path: string): string {
  const text = fixtureEntries()[path]
  if (text === undefined) throw new Error(`no fixture ${path}`)
  return text
}
