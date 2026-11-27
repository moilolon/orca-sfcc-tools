// Which lexer colours a document. The editor frame gets the text, never the file's name: until the
// worker names the file (`editor.locate`), the language is guessed from the text, then taken from
// the file's extension.
import { isml } from './isml'
import { javascript } from './js'
import { properties } from './properties'
import type { LineLexer } from './tokens'
import { xml } from './xml'

export type Language = 'isml' | 'javascript' | 'xml' | 'properties'

export const LEXERS: { readonly [L in Language]: LineLexer } = { isml, javascript, xml, properties }

/** The language of a file's extension; null for one the editor does not colour. */
export function languageOfPath(path: string): Language | null {
  const match = /\.([A-Za-z]+)$/.exec(path)
  switch (match?.[1].toLowerCase()) {
    case 'isml':
      return 'isml'
    case 'js':
    case 'ds':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'xml':
      return 'xml'
    case 'properties':
      return 'properties'
    default:
      return null
  }
}

/** Lines that only a script has: a statement or a block ending a line, a declaration, a comment opener. */
// A keyword must be followed by what follows it in code: `return.label=` is a key, not a return.
const SCRIPT_LINE = /(;|\{|\(|,)\s*$|^\s*(\}|\/\/|\/\*|\*|(var|let|const)\s+[\w$[{]|function\s*[\w$(]|return[\s;(]|if\s*\(|module\.exports|require\()/
// A bundle's comment: `#`, or `!` but not a minified script's `!function(…)` or `!(…)`.
const BUNDLE_COMMENT = /^\s*(#|!(?!\s*(function\b|\()))/

/** Whether most lines are `key=value` (or comments) and almost none read as script. */
function looksLikeProperties(lines: readonly string[]): boolean {
  let pairs = 0
  let script = 0
  let counted = 0
  let continued = false
  for (const line of lines) {
    const wasContinued = continued
    continued = /(^|[^\\])(\\\\)*\\$/.test(line)
    if (wasContinued) continue
    counted++
    const comment = BUNDLE_COMMENT.test(line)
    if (comment || /^\s*[^\s=:#!/*{}][^\s=:]*\s*[=:]/.test(line)) pairs++
    if (!comment && SCRIPT_LINE.test(line)) script++
  }
  return counted > 0 && pairs / counted >= 0.7 && script / counted < 0.1
}

/**
 * A guess from the start of the text, among `among` (every language by default): ISML when it
 * holds `<is…>` or `${` with markup, XML for other markup, `.properties` for `key=value` lines,
 * else JavaScript.
 */
export function guessLanguage(text: string, among: readonly Language[] = ['isml', 'javascript', 'xml', 'properties']): Language {
  const head = text.slice(0, 20_000)
  const first = /^﻿?\s*(\S)/.exec(head)?.[1]
  const markup = first === '<'
  if (among.includes('isml') && (/<\/?is[a-z]+[\s/>]/i.test(head) || (markup && /\$\{/.test(head)))) return 'isml'
  if (markup) {
    if (among.includes('xml') && (/^﻿?\s*<\?xml/.test(head) || !among.includes('isml') || !/<(html|div|span|body|head|p|a|ul|li)\b/i.test(head))) return 'xml'
    if (among.includes('isml')) return 'isml'
  }
  const lines = head.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '')
  if (among.includes('properties') && looksLikeProperties(lines)) return 'properties'
  return among.includes('javascript') ? 'javascript' : among[0]
}
