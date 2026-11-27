// The description of a `dw.*` class or member, read at run time: the index (./index.ts) holds no
// description (Salesforce's terms grant no right to copy the text, only to link to it), so the
// page is read with `b2c docs read` on the user's own machine when a hover needs it.
//
// Worker side. Each page is read once per worker life and kept in memory only, never stored. The
// answer must be the page asked for: `b2c docs read` matches a name it does not know to another
// class without failing. What is handed back is the class's own section, or one member's, masked
// like anything a piece shows of b2c's output.
import type { B2c } from '../../../core/b2c'

/**
 * Carried by every `docs` command, here and in scripts/generate-dw-index.ts. Without it `b2c`
 * guesses the kind of project from its working folder, walking it whole first: minutes in a
 * home folder.
 */
export const DOCS_FLAGS: readonly string[] = ['--workspace', 'all']

/** A class id as the index writes it: a package, a dot, a name. Nothing else reaches b2c. */
const CLASS_ID = /^[A-Za-z][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/

export type DescribeErrorCode = 'invalid_class' | 'wrong_page' | 'no_content'

export class DescribeError extends Error {
  readonly code: DescribeErrorCode
  constructor(code: DescribeErrorCode) {
    super(code)
    this.name = 'DescribeError'
    this.code = code
  }
}

export type Describer = {
  /**
   * The Markdown of a class's description (no `memberKey`) or of one member's section, found by
   * its key (the heading of its section, `getProduct(String)`, as the index's `DwMember.key`
   * gives it); null when the page has no such section. Masked. Throws a B2cError when b2c fails,
   * and a DescribeError when the class id is not one or b2c answered another page.
   */
  describe(classId: string, memberKey?: string): Promise<string | null>
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Markdown's escapes removed, as the index writes a heading (`String\[]` is `String[]`). */
function unescape(text: string): string {
  return text.replace(/\\([^A-Za-z0-9\s])/g, '$1')
}

/** What a page says before its first `## `, after its title and inheritance list. */
function classSection(lines: string[]): string {
  const end = lines.findIndex((line) => line.startsWith('## '))
  const head = end === -1 ? lines : lines.slice(0, end)
  let at = 1
  while (at < head.length && (head[at] === '' || /^\s*- \[/.test(head[at]))) at++
  return head.slice(at).join('\n')
}

/** The section of the member whose heading is `key`, in a `… Details` part of the page. */
function memberSection(lines: string[], key: string): string | null {
  let details = false
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]
    if (line.startsWith('## ')) details = line.endsWith(' Details')
    if (!details || !line.startsWith('### ') || unescape(line.slice(4).trim()) !== key) continue
    let end = at + 1
    while (end < lines.length && !lines[end].startsWith('### ') && !lines[end].startsWith('## ')) end++
    return lines.slice(at + 1, end).join('\n')
  }
  return null
}

/** Trailing rules (`***`) and blank lines removed; null when nothing is left. */
function tidy(text: string): string | null {
  const out = text.replace(/(?:\s*\n\*\*\*\s*)+$/, '').trim()
  return out ? out : null
}

export function createDescriber(b2c: Pick<B2c, 'run' | 'mask'>, options: { cwd?: string } = {}): Describer {
  const pages = new Map<string, Promise<string[]>>()

  async function read(classId: string): Promise<string[]> {
    const { json } = await b2c.run(['docs', 'read', classId, ...DOCS_FLAGS], { cwd: options.cwd })
    const entry = isObject(json) && isObject(json.entry) ? json.entry : null
    if (!entry || entry.id !== classId) throw new DescribeError('wrong_page')
    if (!isObject(json) || typeof json.content !== 'string' || !json.content) throw new DescribeError('no_content')
    // LF only and no byte order mark, so a section is found whatever the line ends.
    return json.content.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  }

  function page(classId: string): Promise<string[]> {
    let pending = pages.get(classId)
    if (!pending) {
      pending = read(classId)
      pages.set(classId, pending)
      // A failed read is not kept: the next hover tries again.
      pending.catch(() => pages.delete(classId))
    }
    return pending
  }

  return {
    async describe(classId, memberKey) {
      if (!CLASS_ID.test(classId)) throw new DescribeError('invalid_class')
      const lines = await page(classId)
      const section = tidy(memberKey === undefined ? classSection(lines) : (memberSection(lines, memberKey) ?? ''))
      return section === null ? null : b2c.mask(section)
    }
  }
}
