// Reading the fixtures and finding positions in them, for the engine's tests.
import { readFileSync } from 'node:fs'

/** Every fixture the engine's tests read, scripts first. */
export const SCRIPT_FIXTURES = ['controller.js', 'model.js', 'shapes.js', 'helper.js', 'broken.js', 'truncated.js']
export const TEMPLATE_FIXTURES = ['template.isml', 'broken.isml']

/**
 * The text of a fixture of this folder, with LF line breaks whatever the checkout wrote (with
 * `core.autocrlf` it holds CRLF): the tests' snippets are written with LF. How the parsers read
 * CRLF and CR is tested on its own, in `line-endings.test.ts`.
 */
export function fixture(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n?/g, '\n')
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
