// The editing model: the text, the selection and every command a key or the clipboard runs on
// them, with no DOM. The view (view.ts) turns events into these calls and draws the result, so
// what typing does is tested here in Node. One selection (no multiple cursors).
import { comparePos, diffRange, pos, samePos, TextBuffer, type Change, type Pos } from './buffer'
import { History, type ChangeKind, type Selection } from './history'
import { merge3 } from '../merge'

export type { Selection }

/** How far a caret moves. */
export type Unit = 'char' | 'word' | 'line' | 'page' | 'lineEdge' | 'docEdge'

/** Horizontal place on screen, for keeping the column of vertical moves: the view measures it. */
export type Geometry = {
  x(line: number, col: number): number
  colAt(line: number, x: number): number
}

export const TAB_SIZE = 4

/** The visual column of `col` in a line, tabs expanded to `TAB_SIZE`. */
export function visualColumn(text: string, col: number): number {
  let v = 0
  for (let i = 0; i < col && i < text.length; i++) v = text.charCodeAt(i) === 9 ? v + TAB_SIZE - (v % TAB_SIZE) : v + 1
  return v
}

/** The column whose visual column is nearest `x` (in columns). */
export function columnAt(text: string, x: number): number {
  let v = 0
  for (let i = 0; i < text.length; i++) {
    const next = text.charCodeAt(i) === 9 ? v + TAB_SIZE - (v % TAB_SIZE) : v + 1
    if (x < (v + next) / 2) return i
    v = next
  }
  return text.length
}

const isWord = (c: string) => /[\p{L}\p{N}_$]/u.test(c)
const isSpace = (c: string) => c === ' ' || c === '\t'

export const ordered = (s: Selection): [Pos, Pos] => (comparePos(s.anchor, s.head) <= 0 ? [s.anchor, s.head] : [s.head, s.anchor])
export const isEmpty = (s: Selection): boolean => samePos(s.anchor, s.head)

/** The indentation a text uses: a tab when most indented lines start with one, else 2 or 4 spaces. */
export function detectIndent(lines: readonly string[]): string {
  let tabs = 0
  let spaces = 0
  let twos = 0
  for (let i = 0; i < lines.length && i < 2000; i++) {
    const line = lines[i]
    if (line.startsWith('\t')) tabs++
    else if (line.startsWith('  ')) {
      spaces++
      const n = /^ */.exec(line)?.[0].length ?? 0
      if (n % 4 === 2) twos++
    }
  }
  if (tabs > spaces) return '\t'
  return spaces > 0 && twos * 3 >= spaces ? '  ' : '    '
}

/** What a model reports after a change: whether it is provisional (a composition in progress). */
export type ModelEvent = { textChanged: boolean; provisional: boolean }

export class EditorModel {
  readonly buffer: TextBuffer
  readonly history: History
  selection: Selection = { anchor: pos(0, 0), head: pos(0, 0) }
  readOnly: boolean
  indentUnit: string
  /** The column vertical moves keep, in the geometry's units; null until one starts. */
  private goal: number | null = null
  /** An IME composition: where it started and the provisional text it has put in. */
  composition: { from: Pos; text: string } | null = null
  geometry: Geometry | null = null
  /**
   * Whether the file starts with a byte order mark. It is held apart from the editable text, so
   * no key, selection or paste can delete it or put text before it, and `text()` puts it back.
   */
  bom: boolean
  /**
   * An outside write that came during a composition: held, then merged with what the composition
   * committed when it ends. `base` is the text (without the provisional part) when it first came.
   */
  private heldOutside: { base: string; outside: string } | null = null
  private readonly listeners: ((event: ModelEvent) => void)[] = []

  constructor(text: string, options: { readOnly?: boolean; now?: () => number } = {}) {
    this.bom = text.charCodeAt(0) === 0xfeff
    this.buffer = new TextBuffer(this.bom ? text.slice(1) : text)
    this.history = new History(options.now)
    this.readOnly = Boolean(options.readOnly)
    this.indentUnit = detectIndent(this.buffer.lines)
  }

  onUpdate(listener: (event: ModelEvent) => void): void {
    this.listeners.push(listener)
  }

  private emit(textChanged: boolean, provisional = false): void {
    for (const listener of this.listeners) listener({ textChanged, provisional })
  }

  /** The whole text as the file holds it: the byte order mark (when there is one) and every break as written. */
  text(): string {
    return (this.bom ? '﻿' : '') + this.buffer.text()
  }

  /** The offset of a position in `text()` (a byte order mark counted): what the engine's queries take. */
  textOffset(p: Pos): number {
    return (this.bom ? 1 : 0) + this.buffer.offsetAt(p)
  }

  /** The text without the provisional part of a composition in progress, as `text()` writes it. */
  private committedText(): string {
    const composition = this.composition
    const full = this.text()
    if (!composition || !composition.text) return full
    const at = this.textOffset(composition.from)
    return full.slice(0, at) + full.slice(at + composition.text.length)
  }

  selectedText(): string {
    const [a, b] = ordered(this.selection)
    return this.buffer.slice(a, b)
  }

  // ---- selection ----

  setSelection(anchor: Pos, head: Pos = anchor, keepGoal = false): void {
    this.selection = { anchor: this.buffer.clip(anchor), head: this.buffer.clip(head) }
    if (!keepGoal) this.goal = null
    this.emit(false)
  }

  selectAll(): void {
    const last = this.buffer.lineCount - 1
    this.history.seal()
    this.setSelection(pos(0, 0), pos(last, this.buffer.line(last).length))
  }

  /** Moves the caret (or the head, extending the selection) by a unit, -1 back and 1 forward. */
  move(unit: Unit, dir: -1 | 1, extend: boolean, pageLines = 20): void {
    const head = this.selection.head
    this.history.seal()
    if (!extend && !isEmpty(this.selection) && (unit === 'char' || unit === 'word')) {
      // An arrow on a selection lands on its edge.
      const [a, b] = ordered(this.selection)
      this.setSelection(dir < 0 ? a : b)
      return
    }
    let next: Pos
    let keepGoal = false
    switch (unit) {
      case 'char':
        next = this.charStep(head, dir)
        break
      case 'word':
        next = this.wordStep(head, dir)
        break
      case 'line':
      case 'page':
        next = this.vertical(head, dir * (unit === 'page' ? Math.max(1, pageLines) : 1))
        keepGoal = true
        break
      case 'lineEdge':
        next = dir < 0 ? this.smartHome(head) : pos(head.line, this.buffer.line(head.line).length)
        break
      case 'docEdge': {
        const last = this.buffer.lineCount - 1
        next = dir < 0 ? pos(0, 0) : pos(last, this.buffer.line(last).length)
        break
      }
    }
    this.setSelection(extend ? this.selection.anchor : next, next, keepGoal)
  }

  /** One character back or forward, a surrogate pair and a line break counting as one. */
  charStep(p: Pos, dir: -1 | 1): Pos {
    const line = this.buffer.line(p.line)
    if (dir < 0) {
      if (p.col > 0) {
        const c = line.charCodeAt(p.col - 1)
        return pos(p.line, p.col - (c >= 0xdc00 && c <= 0xdfff && p.col > 1 ? 2 : 1))
      }
      return p.line > 0 ? pos(p.line - 1, this.buffer.line(p.line - 1).length) : p
    }
    if (p.col < line.length) {
      const c = line.charCodeAt(p.col)
      return pos(p.line, p.col + (c >= 0xd800 && c <= 0xdbff && p.col + 1 < line.length ? 2 : 1))
    }
    return p.line < this.buffer.lineCount - 1 ? pos(p.line + 1, 0) : p
  }

  /** To the start (back) or end (forward) of a word, over spaces first; at a line's edge, to the next line. */
  wordStep(p: Pos, dir: -1 | 1): Pos {
    const text = this.buffer.line(p.line)
    let c = p.col
    if (dir < 0) {
      if (c === 0) return this.charStep(p, -1)
      while (c > 0 && isSpace(text[c - 1])) c--
      if (c === 0) return pos(p.line, 0)
      const word = isWord(text[c - 1])
      while (c > 0 && !isSpace(text[c - 1]) && isWord(text[c - 1]) === word) c--
    } else {
      if (c === text.length) return this.charStep(p, 1)
      while (c < text.length && isSpace(text[c])) c++
      if (c === text.length) return pos(p.line, c)
      const word = isWord(text[c])
      while (c < text.length && !isSpace(text[c]) && isWord(text[c]) === word) c++
    }
    return pos(p.line, c)
  }

  /** The word around a position, for a double click; null on spaces or punctuation. */
  wordAt(p: Pos): { from: Pos; to: Pos } | null {
    const text = this.buffer.line(p.line)
    let a = p.col
    if (!isWord(text[a] ?? '') && a > 0 && isWord(text[a - 1])) a--
    if (!isWord(text[a] ?? '')) return null
    while (a > 0 && isWord(text[a - 1])) a--
    let b = a
    while (b < text.length && isWord(text[b])) b++
    return { from: pos(p.line, a), to: pos(p.line, b) }
  }

  /** A whole line with its break, for a triple click. */
  lineAt(line: number): { from: Pos; to: Pos } {
    const end = pos(line, this.buffer.line(line).length)
    return { from: pos(line, 0), to: this.charStep(end, 1) }
  }

  /** Home: to the first non-space character, or to the start when already there. */
  smartHome(p: Pos): Pos {
    const indent = /^[ \t]*/.exec(this.buffer.line(p.line))?.[0].length ?? 0
    return pos(p.line, p.col === indent ? 0 : indent)
  }

  private vertical(head: Pos, lines: number): Pos {
    const geometry = this.geometry
    if (this.goal === null) this.goal = geometry ? geometry.x(head.line, head.col) : visualColumn(this.buffer.line(head.line), head.col)
    const line = Math.max(0, Math.min(this.buffer.lineCount - 1, head.line + lines))
    if (line === head.line) return lines < 0 ? pos(line, 0) : pos(line, this.buffer.line(line).length)
    const text = this.buffer.line(line)
    return pos(line, geometry ? geometry.colAt(line, this.goal) : columnAt(text, this.goal))
  }

  // ---- editing ----

  /** Replaces `from..to` with `text` as one undo step; the caret lands after the text. */
  edit(from: Pos, to: Pos, text: string, kind: ChangeKind, caret?: Pos): Change | null {
    if (this.readOnly) return null
    const before = this.selection
    const change = this.buffer.replace(from, to, text)
    this.selection = { anchor: caret ?? change.end, head: caret ?? change.end }
    this.goal = null
    this.history.record([change], before, this.selection, kind)
    this.emit(true)
    return change
  }

  /** Replaces the selection. */
  replaceSelection(text: string, kind: ChangeKind): Change | null {
    const [a, b] = ordered(this.selection)
    return this.edit(a, b, text, kind)
  }

  /** Typed text: one character joins the typing step, more (an autocorrection, a commit) is its own. */
  type(text: string): void {
    if (!text) return
    this.replaceSelection(this.normalize(text), [...text].length === 1 ? 'type' : 'insert')
  }

  /** Pasted text: its line breaks become the text's own. */
  paste(text: string): void {
    if (!text) return
    this.replaceSelection(this.normalize(text), 'paste')
  }

  /** Cut: the selected text, removed; nothing with no selection. */
  cut(): string {
    const text = this.selectedText()
    if (text && !this.readOnly) this.replaceSelection('', 'cut')
    return text
  }

  private normalize(text: string): string {
    return text.indexOf('\r') === -1 && this.buffer.eol === '\n' ? text : text.replace(/\r\n|\r|\n/g, this.buffer.eol)
  }

  /** Backspace (-1) or Delete (1): the selection, else a character or (with `word`) a word. */
  deleteBy(dir: -1 | 1, word: boolean): void {
    if (!isEmpty(this.selection)) {
      this.replaceSelection('', 'delete')
      return
    }
    const head = this.selection.head
    const other = word ? this.wordStep(head, dir) : this.charStep(head, dir)
    if (samePos(other, head)) return
    const [a, b] = comparePos(other, head) < 0 ? [other, head] : [head, other]
    this.edit(a, b, '', 'delete')
  }

  /** Enter: a line break, and the indentation of the line it breaks (up to the caret). */
  enter(): void {
    const [a] = ordered(this.selection)
    const indent = (/^[ \t]*/.exec(this.buffer.line(a.line))?.[0] ?? '').slice(0, a.col)
    this.history.seal()
    this.replaceSelection(this.buffer.eol + indent, 'enter')
  }

  /** Tab: on a caret or within a line, an indent unit; on lines (or Shift), their indentation. */
  tab(outdent: boolean): void {
    const [a, b] = ordered(this.selection)
    if (a.line === b.line && !outdent) {
      const unit = this.indentUnit
      const text = unit === '\t' ? '\t' : ' '.repeat(unit.length - (visualColumn(this.buffer.line(a.line), a.col) % unit.length))
      this.replaceSelection(text, 'insert')
      return
    }
    const last = b.line - (b.col === 0 && b.line > a.line ? 1 : 0)
    this.indentLines(a.line, last, outdent ? -1 : 1)
  }

  /** Indents (1) or outdents (-1) whole lines as one step, the selection moving with the text. */
  indentLines(first: number, last: number, dir: -1 | 1): void {
    if (this.readOnly) return
    const before = this.selection
    const changes: Change[] = []
    const shift = new Map<number, number>()
    for (let l = first; l <= last; l++) {
      const line = this.buffer.line(l)
      if (dir > 0) {
        if (line.length === 0 && first !== last) continue
        changes.push(this.buffer.replace(pos(l, 0), pos(l, 0), this.indentUnit))
        shift.set(l, this.indentUnit.length)
      } else {
        const n = line.startsWith('\t') ? 1 : (/^ */.exec(line)?.[0].length ?? 0)
        const remove = line.startsWith('\t') ? 1 : Math.min(n, this.indentUnit === '\t' ? TAB_SIZE : this.indentUnit.length)
        if (remove === 0) continue
        changes.push(this.buffer.replace(pos(l, 0), pos(l, remove), ''))
        shift.set(l, -remove)
      }
    }
    if (changes.length === 0) return
    const moved = (p: Pos) => pos(p.line, Math.max(0, p.col + (shift.get(p.line) ?? 0)))
    this.selection = { anchor: this.buffer.clip(moved(before.anchor)), head: this.buffer.clip(moved(before.head)) }
    this.history.record(changes, before, this.selection, 'indent')
    this.history.seal()
    this.emit(true)
  }

  undo(): boolean {
    if (this.readOnly) return false
    this.cancelComposition()
    const selection = this.history.undo(this.buffer)
    if (!selection) return false
    this.selection = { anchor: this.buffer.clip(selection.anchor), head: this.buffer.clip(selection.head) }
    this.goal = null
    this.emit(true)
    return true
  }

  redo(): boolean {
    if (this.readOnly) return false
    this.cancelComposition()
    const selection = this.history.redo(this.buffer)
    if (!selection) return false
    this.selection = { anchor: this.buffer.clip(selection.anchor), head: this.buffer.clip(selection.head) }
    this.goal = null
    this.emit(true)
    return true
  }

  // ---- IME composition ----

  /** A composition starts: the selection goes (one step) and the provisional text will sit at its start. */
  startComposition(): void {
    if (this.readOnly) return
    if (!isEmpty(this.selection)) this.replaceSelection('', 'delete')
    this.history.seal()
    this.composition = { from: ordered(this.selection)[0], text: '' }
  }

  /** The provisional text changed: drawn, never recorded, never sent. */
  updateComposition(text: string): void {
    const composition = this.composition
    if (!composition) return
    const change = this.buffer.replace(composition.from, this.provisionalEnd(composition), text)
    composition.text = text
    this.selection = { anchor: change.end, head: change.end }
    this.emit(true, true)
  }

  /** The composition ends with its final text (empty when cancelled): one undo step. */
  endComposition(text: string): void {
    const composition = this.composition
    if (!composition) return
    this.composition = null
    this.buffer.replace(composition.from, this.provisionalEnd(composition), '')
    this.selection = { anchor: composition.from, head: composition.from }
    if (text) this.replaceSelection(this.normalize(text), 'compose')
    else this.emit(true)
    this.history.seal()
    // An outside write that came while composing: merged now with what was composed, never over it.
    const held = this.heldOutside
    if (held) {
      this.heldOutside = null
      this.replaceAll(merge3(held.base, held.outside, this.text()).text)
    }
  }

  /** Drops a composition in progress and its provisional text. */
  cancelComposition(): void {
    if (this.composition) this.endComposition('')
  }

  private provisionalEnd(composition: { from: Pos; text: string }): Pos {
    const lines = composition.text.split(/\r\n|\r|\n/)
    const last = lines.length - 1
    return pos(composition.from.line + last, lines[last].length + (last === 0 ? composition.from.col : 0))
  }

  // ---- outside changes ----

  /**
   * The text changed outside (an agent wrote the file, or a merge): only the range that differs is
   * replaced, as one undo step, and the caret keeps its place in the text around it. During an IME
   * composition the write is held (the input method still owns the provisional text) and merged
   * with what the composition commits when it ends: false then, as nothing changed yet.
   */
  replaceAll(incoming: string): boolean {
    if (this.composition) {
      this.heldOutside = { base: this.heldOutside?.base ?? this.committedText(), outside: incoming }
      return false
    }
    const bom = incoming.charCodeAt(0) === 0xfeff
    const text = bom ? incoming.slice(1) : incoming
    const bomChanged = bom !== this.bom
    this.bom = bom
    const current = this.buffer.text()
    if (current === text) {
      if (bomChanged) this.emit(true)
      return bomChanged
    }
    const range = diffRange(current, text)
    const from = this.buffer.posAt(range.start)
    const to = this.buffer.posAt(range.oldEnd)
    // A place before the change stays; one after it moves with the text; one inside goes to its end.
    const moved = (offset: number): number => (offset <= range.start ? offset : offset >= range.oldEnd ? offset - range.oldEnd + range.newEnd : range.newEnd)
    const before = this.selection
    const anchor = moved(this.buffer.offsetAt(before.anchor))
    const head = moved(this.buffer.offsetAt(before.head))
    const change = this.buffer.replace(from, to, text.slice(range.start, range.newEnd))
    this.selection = { anchor: this.buffer.posAt(anchor), head: this.buffer.posAt(head) }
    this.goal = null
    this.history.record([change], before, this.selection, 'outside')
    this.history.seal()
    this.emit(true)
    return true
  }
}
