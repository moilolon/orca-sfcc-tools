// The text as the engine reads it, and which file a query names. Pure: no DOM, no Orca.
//
// Every query of one text sends the same string, built once per change (`QueryDocument`), so the
// worker's analysis cache (it keeps the last texts read) parses it once for all the features. The
// text sent is the editor's without its byte order mark, as the engine reads files from disk: the
// offsets of every answer (a query's and a problem's alike) are then offsets of the buffer.
//
// A file the editor could not name (7.1's identity: unsaved edits, identical copies) is asked about
// under a stand-in path of its language and an empty workspace id, which no index answers: only
// what needs no other file comes back (ISML tags, `dw.*` members, a name declared in the text), and
// no feature that reads another file can reach one. Problems are only asked for a named file.
import type { Pos } from '../surface/buffer'
import type { EditorModel } from '../surface/model'
import type { Identity } from '../identity'
import type { Language } from '../highlight/language'

/** What a query names: the workspace, the file, and what may be asked about it. */
export type QueryFile = {
  workspaceId: string
  path: string
  /** Named by 7.1's identity: other files may be read. */
  located: boolean
  /** Completion, hover, definition, references and signature help: scripts and templates only. */
  queries: boolean
  /** The engine's problems: a named file only (S3). */
  problems: boolean
}

/** The stand-in names of a file not identified, by language; none for XML and `.properties`. */
export const STAND_IN: Partial<Record<Language, string>> = { isml: 'unnamed.isml', javascript: 'unnamed.js' }

/** A workspace id no index has: a query under it answers from the text and `dw.*` alone. */
export const NO_WORKSPACE = ''

/** What a query names for the identity and language the editor has now; null when nothing may be asked. */
export function fileFor(identity: Identity, language: Language): QueryFile | null {
  if (identity.state === 'identified') {
    return { workspaceId: identity.workspaceId, path: identity.path, located: true, queries: /\.(isml|js|ds)$/i.test(identity.path), problems: true }
  }
  const path = STAND_IN[language]
  return path ? { workspaceId: NO_WORKSPACE, path, located: false, queries: true, problems: false } : null
}

/** The offset of each line's start in a text, every break (CRLF, CR, LF) as the buffer splits it. */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10) starts.push(i + 1)
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++
      starts.push(i + 1)
    }
  }
  return starts
}

/** The editor's text for the engine: one string per change, and offsets to positions both ways. */
export class QueryDocument {
  private readonly model: EditorModel
  /** Raised by every change of the text, a composition's provisional text included. */
  version = 0
  private cache: { version: number; text: string; starts: number[] | null } | null = null

  constructor(model: EditorModel) {
    this.model = model
    model.buffer.onChange(() => {
      this.version++
    })
  }

  /** The text without its byte order mark, built once per version. */
  text(): string {
    if (this.cache?.version !== this.version) this.cache = { version: this.version, text: this.model.buffer.text(), starts: null }
    return this.cache.text
  }

  private starts(): number[] {
    const text = this.text()
    const cache = this.cache as { starts: number[] | null }
    cache.starts ??= lineStarts(text)
    return cache.starts
  }

  get length(): number {
    return this.text().length
  }

  offsetOf(p: Pos): number {
    const starts = this.starts()
    const line = Math.max(0, Math.min(p.line, starts.length - 1))
    const end = line + 1 < starts.length ? starts[line + 1] : this.text().length
    return Math.min(starts[line] + Math.max(0, p.col), end)
  }

  /** The position of an offset; an offset inside a line break is the end of its line. */
  posOf(offset: number): Pos {
    const starts = this.starts()
    const at = Math.max(0, Math.min(offset, this.text().length))
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= at) lo = mid
      else hi = mid - 1
    }
    return { line: lo, col: Math.min(at - starts[lo], this.model.buffer.line(lo).length) }
  }

  /** The caret's offset. */
  caret(): number {
    return this.offsetOf(this.model.selection.head)
  }
}

/**
 * Which answer of a feature may still be drawn: only the latest asked, and only while the text is
 * the one it was asked on. A newer request, a change of the text or a close makes the older stale.
 */
export class Latest {
  private asked = 0
  private readonly document: QueryDocument

  constructor(document: QueryDocument) {
    this.document = document
  }

  /** A new request: the test that says whether its answer may still be drawn. */
  begin(): () => boolean {
    const mine = ++this.asked
    const version = this.document.version
    return () => mine === this.asked && version === this.document.version
  }

  /** Every request asked so far is stale. */
  cancel(): void {
    this.asked++
  }
}
