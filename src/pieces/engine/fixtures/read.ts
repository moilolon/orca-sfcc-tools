// Reading the fixtures and finding positions in them, for the engine's tests.
import { readFileSync } from 'node:fs'

/** The text of a fixture of this folder. */
export function fixture(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8')
}

/** The offset of `snippet` in `text` (its `nth` occurrence, from 0); fails when it is not there. */
export function offsetOf(text: string, snippet: string, nth = 0): number {
  let at = -1
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(snippet, at + 1)
    if (at === -1) throw new Error(`not found: ${snippet} (#${i})`)
  }
  return at
}

/** The range of `snippet` in `text`. */
export function rangeOf(text: string, snippet: string, nth = 0): { start: number; end: number } {
  const start = offsetOf(text, snippet, nth)
  return { start, end: start + snippet.length }
}
