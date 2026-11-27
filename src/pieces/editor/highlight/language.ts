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

/** A guess from the start of the text: ISML when it holds `<is…>` or `${`, XML for markup, `.properties` for `key=value` lines, else JavaScript. */
export function guessLanguage(text: string): Language {
  const head = text.slice(0, 20_000)
  if (/<\/?is[a-z]/i.test(head) || (/\$\{/.test(head) && /<[A-Za-z]/.test(head))) return 'isml'
  const first = /^﻿?\s*(\S)/.exec(head)?.[1]
  if (first === '<') return /^﻿?\s*<\?xml/.test(head) || !/<(html|div|span|body|head)\b/i.test(head) ? 'xml' : 'isml'
  const lines = head.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '')
  if (lines.length > 0) {
    const looks = lines.filter((line) => /^\s*([#!].*|[\w.\-\\]+\s*[=:].*)$/.test(line) && !/[;{}()]\s*$/.test(line)).length
    if (looks / lines.length >= 0.8) return 'properties'
  }
  return 'javascript'
}
