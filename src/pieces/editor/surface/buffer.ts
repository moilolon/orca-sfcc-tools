// The editor's text: an array of lines, each with the line break written after it, so the text
// comes back exactly as it was read (CRLF, LF and a lone CR alike, mixed ones included, a BOM kept
// as U+FEFF). Positions are `{ line, col }`, the column a UTF-16 index into the line; one replace
// primitive changes the text and says enough to undo it. Pure: no DOM, no Orca.

export type Pos = { readonly line: number; readonly col: number }

/** One replace: what was removed and inserted at `from`, and where the inserted text ends. */
export type Change = {
  readonly from: Pos
  /** The text removed, with its line breaks as they were written. */
  readonly removed: string
  /** The text inserted, with its line breaks as given. */
  readonly inserted: string
  /** Where the inserted text ends. */
  readonly end: Pos
}

/** Called after each replace: the lines `fromLine..oldEndLine` became `fromLine..newEndLine`. */
export type ChangeListener = (fromLine: number, oldEndLine: number, newEndLine: number, change: Change) => void

export const pos = (line: number, col: number): Pos => ({ line, col })
export const comparePos = (a: Pos, b: Pos): number => a.line - b.line || a.col - b.col
export const samePos = (a: Pos, b: Pos): boolean => a.line === b.line && a.col === b.col

const BREAK = /\r\n|\r|\n/g

/** A text as lines and the break after each (the last line's is empty). */
export function splitLines(text: string): { lines: string[]; breaks: string[] } {
  const lines: string[] = []
  const breaks: string[] = []
  let at = 0
  BREAK.lastIndex = 0
  for (let match = BREAK.exec(text); match; match = BREAK.exec(text)) {
    lines.push(text.slice(at, match.index))
    breaks.push(match[0])
    at = match.index + match[0].length
  }
  lines.push(text.slice(at))
  breaks.push('')
  return { lines, breaks }
}

/** The line break most lines of a text end with; LF for a text of one line. */
export function dominantBreak(breaks: readonly string[]): '\n' | '\r\n' | '\r' {
  let lf = 0
  let crlf = 0
  let cr = 0
  for (const b of breaks) {
    if (b === '\n') lf++
    else if (b === '\r\n') crlf++
    else if (b === '\r') cr++
  }
  if (crlf > lf && crlf >= cr) return '\r\n'
  if (cr > lf && cr > crlf) return '\r'
  return '\n'
}

/** Where a text inserted at `from` ends. */
export function endOf(from: Pos, text: string): Pos {
  const { lines } = splitLines(text)
  const last = lines.length - 1
  return { line: from.line + last, col: lines[last].length + (last === 0 ? from.col : 0) }
}

export class TextBuffer {
  private lineList: string[] = ['']
  private breakList: string[] = ['']
  /** The break new lines get: the one most lines of the text as read end with. */
  eol: '\n' | '\r\n' | '\r' = '\n'
  /** Rises with every change. */
  version = 0
  private readonly listeners: ChangeListener[] = []

  constructor(text = '') {
    this.load(text)
  }

  /** Replaces everything, with no change event: for a new document. */
  load(text: string): void {
    const { lines, breaks } = splitLines(text)
    this.lineList = lines
    this.breakList = breaks
    this.eol = dominantBreak(breaks)
    this.version++
  }

  get lineCount(): number {
    return this.lineList.length
  }

  /** The lines, without their breaks. Read only: change them through `replace`. */
  get lines(): readonly string[] {
    return this.lineList
  }

  line(index: number): string {
    return this.lineList[index] ?? ''
  }

  /** The whole text, every break as written. */
  text(): string {
    const lines = this.lineList
    const breaks = this.breakList
    let out = ''
    for (let i = 0; i < lines.length; i++) out += lines[i] + breaks[i]
    return out
  }

  /** Characters of the text, breaks included. */
  get length(): number {
    let n = 0
    for (let i = 0; i < this.lineList.length; i++) n += this.lineList[i].length + this.breakList[i].length
    return n
  }

  /** The nearest position inside the text. */
  clip(p: Pos): Pos {
    const line = Math.max(0, Math.min(Math.trunc(p.line) || 0, this.lineList.length - 1))
    const col = Math.max(0, Math.min(Math.trunc(p.col) || 0, this.lineList[line].length))
    return line === p.line && col === p.col ? p : { line, col }
  }

  /** The offset of a position in `text()`. */
  offsetAt(p: Pos): number {
    const at = this.clip(p)
    let offset = 0
    for (let i = 0; i < at.line; i++) offset += this.lineList[i].length + this.breakList[i].length
    return offset + at.col
  }

  /** The position of an offset of `text()`; an offset inside a CRLF is the end of its line. */
  posAt(offset: number): Pos {
    let rest = Math.max(0, offset)
    for (let i = 0; i < this.lineList.length; i++) {
      const length = this.lineList[i].length
      if (rest <= length) return { line: i, col: rest }
      rest -= length
      const breakLength = this.breakList[i].length
      if (rest < breakLength || i === this.lineList.length - 1) return { line: i, col: length }
      rest -= breakLength
    }
    const last = this.lineList.length - 1
    return { line: last, col: this.lineList[last].length }
  }

  /** The text between two positions, breaks as written. */
  slice(from: Pos, to: Pos): string {
    const a = this.clip(from)
    const b = this.clip(to)
    if (comparePos(a, b) >= 0) return ''
    if (a.line === b.line) return this.lineList[a.line].slice(a.col, b.col)
    let out = this.lineList[a.line].slice(a.col) + this.breakList[a.line]
    for (let l = a.line + 1; l < b.line; l++) out += this.lineList[l] + this.breakList[l]
    return out + this.lineList[b.line].slice(0, b.col)
  }

  /** Replaces the text between `from` and `to` with `text` (its breaks kept as given). */
  replace(from: Pos, to: Pos, text: string): Change {
    let a = this.clip(from)
    let b = this.clip(to)
    if (comparePos(a, b) > 0) [a, b] = [b, a]
    const removed = this.slice(a, b)
    const before = this.lineList[a.line].slice(0, a.col)
    const after = this.lineList[b.line].slice(b.col)
    const tailBreak = this.breakList[b.line]
    const { lines, breaks } = splitLines(text)
    const last = lines.length - 1
    const endCol = lines[last].length + (last === 0 ? before.length : 0)
    lines[0] = before + lines[0]
    lines[last] = lines[last] + after
    breaks[last] = tailBreak
    const count = b.line - a.line + 1
    if (lines.length < 20_000 && count < 20_000) {
      this.lineList.splice(a.line, count, ...lines)
      this.breakList.splice(a.line, count, ...breaks)
    } else {
      // A spread of very many arguments overflows the stack.
      this.lineList = this.lineList.slice(0, a.line).concat(lines, this.lineList.slice(b.line + 1))
      this.breakList = this.breakList.slice(0, a.line).concat(breaks, this.breakList.slice(b.line + 1))
    }
    this.version++
    const change: Change = { from: a, removed, inserted: text, end: { line: a.line + last, col: endCol } }
    for (const listener of this.listeners) listener(a.line, b.line, a.line + last, change)
    return change
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.push(listener)
    return () => {
      const at = this.listeners.indexOf(listener)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }
}

/** The smallest range two texts differ in: a common start and a common end left out. */
export function diffRange(oldText: string, newText: string): { start: number; oldEnd: number; newEnd: number } {
  const max = Math.min(oldText.length, newText.length)
  let start = 0
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++
  let tail = 0
  while (tail < max - start && oldText.charCodeAt(oldText.length - 1 - tail) === newText.charCodeAt(newText.length - 1 - tail)) tail++
  // Never cut a CRLF or a surrogate pair in two.
  while (start > 0 && (splitsPair(oldText, start) || splitsPair(newText, start))) start--
  while (tail > 0 && (splitsPair(oldText, oldText.length - tail) || splitsPair(newText, newText.length - tail))) tail--
  return { start, oldEnd: oldText.length - tail, newEnd: newText.length - tail }
}

function splitsPair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false
  const before = text.charCodeAt(at - 1)
  const after = text.charCodeAt(at)
  return (before === 13 && after === 10) || (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}
