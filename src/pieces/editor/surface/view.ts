// The editing surface's DOM (spike S9): a hidden textarea at the caret takes every key, IME
// composition and clipboard event, and the editor draws the text itself in a virtualised layer:
// only the lines in view and `OVERSCAN` around them are in the DOM, each line's element kept while
// its tokens stay the same. No contenteditable: the browser never edits the DOM, so the text, the
// history and the colours stay the model's. A gutter holds the line numbers and a column for
// marks (the breakpoints of 7.3). The hooks the language features (7.2, ../features/) draw with: a
// layer of underlines drawn from ranges, a layer for pop-ups, a place's box on screen, the place
// under the pointer, and a callback when the caret moves. The features take keys and clicks before
// the surface does, in the capture phase on `root`, so the surface knows nothing of them.
import { comparePos, type Pos } from './buffer'
import { Highlighter } from '../highlight/highlighter'
import { CLASSES, type LineLexer } from '../highlight/tokens'
import { EditorModel, isEmpty, ordered, TAB_SIZE, visualColumn, type Geometry } from './model'

/** Lines drawn above and below the visible ones. */
export const OVERSCAN = 30
/** Lines longer than this are drawn without colours. */
export const MAX_COLOURED_LINE = 10_000

export type Typography = { fontFamily?: string; fontSize?: number; fontWeight?: string; lineHeight?: number; fontLigatures?: boolean }

/** A range to underline (7.2's warnings): its tone picks the colour. */
export type Underline = { from: Pos; to: Pos; tone: 'error' | 'warning' | 'info' }

/**
 * A mark in the gutter's mark column (7.3's breakpoints): each kind draws as `ed-mark-<kind>`, and
 * the title says in words what the shape shows.
 */
export type LineMark = { kinds: readonly string[]; title: string }

/** A whole line drawn behind the text (7.3's stopped line), with a label after its end. */
export type LineHighlight = { line: number; kind: string; label: string }

const escapeHtml = (text: string) => text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
const escapeAttribute = (text: string) => escapeHtml(text).replace(/"/g, '&quot;')
const isAscii = (text: string) => !/[^\x00-\x7f]/.test(text)

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (parent) parent.appendChild(node)
  return node
}

/** The line's HTML: a span per token, the text between them escaped as is. */
export function lineHtml(text: string, tokens: readonly number[]): string {
  if (!text) return ''
  if (text.length > MAX_COLOURED_LINE) return escapeHtml(text)
  let html = ''
  let at = 0
  for (let k = 0; k < tokens.length; k += 3) {
    const start = tokens[k]
    const end = tokens[k + 1]
    if (start > at) html += escapeHtml(text.slice(at, start))
    const cls = CLASSES[tokens[k + 2]]
    html += cls === 'plain' ? escapeHtml(text.slice(start, end)) : `<span class="t-${cls}">${escapeHtml(text.slice(start, end))}</span>`
    at = end
  }
  if (at < text.length) html += escapeHtml(text.slice(at))
  return html
}

export type ViewOptions = {
  lexer: LineLexer
  label: string
  isMac?: boolean
}

export class SurfaceView implements Geometry {
  readonly model: EditorModel
  readonly highlighter: Highlighter
  readonly root: HTMLElement
  readonly scroller: HTMLDivElement
  readonly input: HTMLTextAreaElement
  /** Where 7.2 puts its pop-ups (completion, hover, signature): above the text, in the editor's coordinates. */
  readonly popupLayer: HTMLDivElement
  private readonly inner: HTMLDivElement
  private readonly gutter: HTMLDivElement
  private readonly gutterLines: HTMLDivElement
  private readonly textLayer: HTMLDivElement
  private readonly selectionLayer: HTMLDivElement
  private readonly lineLayer: HTMLDivElement
  private readonly underlineLayer: HTMLDivElement
  private readonly compositionLayer: HTMLDivElement
  private readonly caret: HTMLDivElement
  private readonly probe: HTMLSpanElement
  private readonly isMac: boolean
  private canvas: CanvasRenderingContext2D | null = null
  charWidth = 8
  lineHeight = 20
  private gutterWidth = 48
  private slab = { first: -1, last: -1 }
  private textDirty = true
  private gutterKey = ''
  private readonly lineCache = new WeakMap<object, HTMLDivElement>()
  private queued = false
  private underlines: Underline[] = []
  private marks = new Map<number, LineMark>()
  private readonly caretListeners: ((head: Pos) => void)[] = []
  /** Called when the mark column of a line is clicked (7.3 sets a breakpoint there); null takes no click. */
  onMarkClick: ((line: number) => void) | null = null
  private highlight: LineHighlight | null = null
  private highlightKey = ''
  private readonly highlightLayer: HTMLDivElement
  private readonly keyHandlers: ((event: KeyboardEvent) => boolean)[] = []
  /** How long the last draw took, for the measurements of a live check. */
  lastRenderMs = 0

  constructor(root: HTMLElement, model: EditorModel, options: ViewOptions) {
    this.root = root
    this.model = model
    this.isMac = options.isMac ?? /Mac|iPhone|iPad/.test(navigator.platform)
    this.highlighter = new Highlighter(model.buffer, options.lexer)
    model.geometry = this
    root.classList.add('ed')
    this.scroller = element('div', 'ed-scroller', root)
    this.inner = element('div', 'ed-inner', this.scroller)
    this.gutter = element('div', 'ed-gutter', this.inner)
    this.gutterLines = element('div', 'ed-gutter-lines', this.gutter)
    this.textLayer = element('div', 'ed-text', this.inner)
    this.highlightLayer = element('div', 'ed-highlight', this.textLayer)
    this.selectionLayer = element('div', 'ed-selection', this.textLayer)
    this.lineLayer = element('div', 'ed-lines', this.textLayer)
    this.underlineLayer = element('div', 'ed-underlines', this.textLayer)
    this.compositionLayer = element('div', 'ed-composition', this.textLayer)
    this.caret = element('div', 'ed-caret', this.textLayer)
    this.input = element('textarea', 'ed-input', this.textLayer)
    this.input.setAttribute('autocorrect', 'off')
    this.input.setAttribute('autocapitalize', 'off')
    this.input.setAttribute('autocomplete', 'off')
    this.input.setAttribute('spellcheck', 'false')
    this.input.setAttribute('aria-label', options.label)
    this.input.setAttribute('aria-multiline', 'true')
    this.popupLayer = element('div', 'ed-popups', root)
    this.probe = element('span', 'ed-probe', this.textLayer)
    model.buffer.onChange(() => {
      this.textDirty = true
    })
    model.onUpdate(() => {
      this.queue()
      for (const listener of this.caretListeners) listener(model.selection.head)
    })
    this.listen()
    this.measure()
    this.render()
  }

  // ---- hooks for 7.2 and 7.3 ----

  onCaretMove(listener: (head: Pos) => void): void {
    this.caretListeners.push(listener)
  }

  setUnderlines(underlines: Underline[]): void {
    this.underlines = underlines
    this.textDirty = true
    this.queue()
  }

  setLineMarks(marks: Map<number, LineMark>): void {
    this.marks = marks
    this.gutterKey = ''
    this.queue()
  }

  /** Whether the mark column takes a click (7.3: only in a script a breakpoint can go in). */
  setMarksClickable(clickable: boolean): void {
    this.gutter.classList.toggle('ed-gutter-marks', clickable)
  }

  /** The line drawn behind the text, or none (7.3's stopped line). */
  setLineHighlight(highlight: LineHighlight | null): void {
    this.highlight = highlight
    // Never a key drawHighlight makes: the next draw puts it, or takes it away.
    this.highlightKey = '\u0000'
    this.queue()
  }

  /** A key before the editor's own handling: a handler that returns true took it (7.3's F9). */
  addKeyHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandlers.push(handler)
  }

  /** The position of the text under a point of the window, or null outside the text or past a line's end. */
  posAtPoint(clientX: number, clientY: number): Pos | null {
    const box = this.textLayer.getBoundingClientRect()
    const line = Math.floor((clientY - box.top) / this.lineHeight)
    if (clientX < box.left || line < 0 || line >= this.model.buffer.lineCount) return null
    const x = clientX - box.left
    if (x > this.x(line, this.model.buffer.line(line).length)) return null
    return { line, col: this.colAt(line, x) }
  }

  /** A position's box in the editor's own coordinates (for a pop-up). */
  boxAt(p: Pos): { x: number; y: number; height: number } {
    const text = this.textLayer.getBoundingClientRect()
    const root = this.root.getBoundingClientRect()
    return { x: text.left - root.left + this.x(p.line, p.col), y: text.top - root.top + p.line * this.lineHeight, height: this.lineHeight }
  }

  /** The caret's box in the editor's own coordinates (for a pop-up). */
  caretBox(): { x: number; y: number; height: number } {
    return this.boxAt(this.model.selection.head)
  }

  // ---- language, typography, theme ----

  setLexer(lexer: LineLexer): void {
    this.highlighter.setLexer(lexer)
    this.textDirty = true
    this.slab = { first: -1, last: -1 }
    this.queue()
  }

  setTypography(typography: Typography): void {
    const style = this.root.style
    if (typography.fontFamily) style.setProperty('--ed-font', typography.fontFamily)
    if (typography.fontSize && typography.fontSize > 0) style.setProperty('--ed-size', `${typography.fontSize}px`)
    if (typography.fontWeight) style.setProperty('--ed-weight', typography.fontWeight)
    style.setProperty('--ed-ligatures', typography.fontLigatures === false ? 'none' : 'normal')
    const size = typography.fontSize && typography.fontSize > 0 ? typography.fontSize : 13
    const raw = typography.lineHeight ?? 0
    // As Orca's editor reads it: 0 is automatic, a small number a multiple of the font size.
    const height = raw <= 0 ? Math.round(size * 1.5) : raw < 8 ? Math.round(raw * size) : Math.round(raw)
    style.setProperty('--ed-line', `${height}px`)
    this.redrawAll()
  }

  /** After a theme or font change: everything measured and drawn again. */
  redrawAll(): void {
    this.measure()
    this.slab = { first: -1, last: -1 }
    this.gutterKey = ''
    this.textDirty = true
    this.render()
  }

  private measure(): void {
    this.probe.textContent = 'x'.repeat(100)
    const box = this.probe.getBoundingClientRect()
    this.charWidth = box.width / 100 || 8
    const line = parseFloat(getComputedStyle(this.root).getPropertyValue('--ed-line'))
    this.lineHeight = line > 0 ? line : Math.round(box.height) || 20
    const style = getComputedStyle(this.probe)
    if (!this.canvas) this.canvas = document.createElement('canvas').getContext('2d')
    if (this.canvas) this.canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    this.probe.textContent = ''
    this.sizeGutter()
  }

  private sizeGutter(): void {
    const digits = Math.max(3, String(this.model.buffer.lineCount).length)
    const width = Math.round(this.charWidth * digits + 34)
    if (width !== this.gutterWidth) {
      this.gutterWidth = width
      this.gutterKey = ''
    }
    this.root.style.setProperty('--ed-gutter', `${this.gutterWidth}px`)
  }

  // ---- geometry ----

  private expand(text: string): string {
    if (text.indexOf('\t') === -1) return text
    let out = ''
    for (const c of text) out += c === '\t' ? ' '.repeat(TAB_SIZE - (out.length % TAB_SIZE)) : c
    return out
  }

  /** The x of a column in the text layer's coordinates. */
  x(line: number, col: number): number {
    const text = this.model.buffer.line(line)
    const before = text.slice(0, col)
    if (isAscii(before)) {
      let v = 0
      for (let i = 0; i < before.length; i++) v = before.charCodeAt(i) === 9 ? v + TAB_SIZE - (v % TAB_SIZE) : v + 1
      return v * this.charWidth
    }
    return this.canvas ? this.canvas.measureText(this.expand(before)).width : before.length * this.charWidth
  }

  /** The column nearest an x of the text layer. */
  colAt(line: number, x: number): number {
    const text = this.model.buffer.line(line)
    if (x <= 0) return 0
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((this.x(line, mid - 1) + this.x(line, mid)) / 2 <= x) lo = mid
      else hi = mid - 1
    }
    // Never between the halves of a surrogate pair.
    const c = text.charCodeAt(lo - 1)
    return c >= 0xd800 && c <= 0xdbff ? lo - 1 : lo
  }

  private posFromPoint(clientX: number, clientY: number): Pos {
    const box = this.textLayer.getBoundingClientRect()
    const line = Math.max(0, Math.min(this.model.buffer.lineCount - 1, Math.floor((clientY - box.top) / this.lineHeight)))
    return { line, col: this.colAt(line, clientX - box.left) }
  }

  // ---- drawing ----

  queue(): void {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      this.render()
    })
  }

  render(): void {
    const started = performance.now()
    const buffer = this.model.buffer
    const count = buffer.lineCount
    const height = this.lineHeight
    const top = this.scroller.scrollTop
    const viewHeight = this.scroller.clientHeight || 400
    const firstVisible = Math.max(0, Math.floor(top / height))
    const lastVisible = Math.min(count - 1, Math.ceil((top + viewHeight) / height))
    if (this.textDirty) {
      let widest = 0
      const lines = buffer.lines
      // In columns as drawn: a tab counts as the columns it takes.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const width = line.indexOf('\t') === -1 ? line.length : visualColumn(line, line.length)
        if (width > widest) widest = width
      }
      this.inner.style.height = `${(count + 3) * height}px`
      this.inner.style.width = `${this.gutterWidth + (widest * 1.2 + 8) * this.charWidth}px`
      this.sizeGutter()
    }
    if (this.textDirty || firstVisible < this.slab.first || lastVisible > this.slab.last || this.slab.first < 0) {
      if (!(this.textDirty && firstVisible >= this.slab.first && lastVisible <= this.slab.last && this.slab.first >= 0)) {
        this.slab = { first: Math.max(0, firstVisible - OVERSCAN), last: Math.min(count - 1, lastVisible + OVERSCAN) }
      }
      this.slab.last = Math.min(Math.max(this.slab.last, lastVisible), count - 1)
      this.slab.first = Math.min(this.slab.first, this.slab.last)
      this.drawLines()
    }
    this.textDirty = false
    this.drawGutter()
    this.drawHighlight()
    this.drawSelection()
    this.lastRenderMs = performance.now() - started
  }

  private drawLines(): void {
    const { first, last } = this.slab
    this.highlighter.ensure(last)
    const nodes: HTMLDivElement[] = []
    for (let i = first; i <= last; i++) {
      const entry = this.highlighter.entry(i)
      let node = entry ? this.lineCache.get(entry) : undefined
      if (!node) {
        node = document.createElement('div')
        node.className = 'ed-line'
        node.innerHTML = lineHtml(this.model.buffer.line(i), this.highlighter.tokens(i))
        if (entry) this.lineCache.set(entry, node)
      }
      nodes.push(node)
    }
    this.lineLayer.style.transform = `translateY(${first * this.lineHeight}px)`
    let current = this.lineLayer.firstChild
    for (const node of nodes) {
      if (node === current) {
        current = current.nextSibling
        continue
      }
      this.lineLayer.insertBefore(node, current)
    }
    while (current) {
      const next = current.nextSibling
      this.lineLayer.removeChild(current)
      current = next
    }
    this.drawUnderlines()
  }

  private drawUnderlines(): void {
    const { first, last } = this.slab
    let html = ''
    for (const underline of this.underlines) {
      const from = underline.from.line < first ? { line: first, col: 0 } : underline.from
      const to = underline.to.line > last ? { line: last, col: this.model.buffer.line(last).length } : underline.to
      for (let line = Math.max(from.line, first); line <= Math.min(to.line, last); line++) {
        const a = line === from.line ? from.col : 0
        const b = line === to.line ? to.col : this.model.buffer.line(line).length
        const x0 = this.x(line, a)
        const width = Math.max(this.x(line, b) - x0, this.charWidth)
        html += `<div class="ed-underline ed-${underline.tone}" style="transform:translate(${x0}px,${line * this.lineHeight}px);width:${width}px"></div>`
      }
    }
    this.underlineLayer.innerHTML = html
  }

  private drawGutter(): void {
    const { first, last } = this.slab
    const head = this.model.selection.head.line
    const key = `${first}:${last}:${head}:${this.gutterWidth}:${this.lineHeight}:${this.marks.size}`
    if (key === this.gutterKey) return
    this.gutterKey = key
    let html = ''
    for (let i = first; i <= last; i++) {
      const mark = this.marks.get(i)
      const kinds = mark ? mark.kinds.map((kind) => ` ed-mark-${kind}`).join('') : ''
      const title = mark ? ` title="${escapeAttribute(mark.title)}" aria-label="${escapeAttribute(mark.title)}"` : ''
      html += `<div class="ed-gutter-line${i === head ? ' ed-current' : ''}" data-line="${i}"><span class="ed-mark${kinds}"${title}></span>${i + 1}</div>`
    }
    this.gutterLines.style.transform = `translateY(${first * this.lineHeight}px)`
    this.gutterLines.innerHTML = html
  }

  /** The highlighted line, with its label after the line's text; drawn again only when it moved. */
  private drawHighlight(): void {
    const highlight = this.highlight
    const line = highlight && highlight.line < this.model.buffer.lineCount ? highlight.line : -1
    const x = line >= 0 ? this.x(line, this.model.buffer.line(line).length) + this.charWidth * 3 : 0
    const key = highlight && line >= 0 ? `${line}:${highlight.kind}:${highlight.label}:${x}:${this.lineHeight}` : ''
    if (key === this.highlightKey) return
    this.highlightKey = key
    if (!highlight || line < 0) {
      this.highlightLayer.innerHTML = ''
      return
    }
    this.highlightLayer.innerHTML = `<div class="ed-highlight-line ed-highlight-${escapeAttribute(highlight.kind)}" style="transform:translateY(${line * this.lineHeight}px)"><span class="ed-highlight-label" style="left:${x}px">${escapeHtml(highlight.label)}</span></div>`
  }

  private drawSelection(): void {
    const selection = this.model.selection
    const [from, to] = ordered(selection)
    const height = this.lineHeight
    let html = ''
    if (!isEmpty(selection)) {
      const first = Math.max(from.line, this.slab.first)
      const last = Math.min(to.line, this.slab.last)
      for (let line = first; line <= last; line++) {
        const x0 = line === from.line ? this.x(line, from.col) : 0
        const x1 = line === to.line ? this.x(line, to.col) : this.x(line, this.model.buffer.line(line).length) + this.charWidth / 2
        html += `<div style="transform:translate(${x0}px,${line * height}px);width:${Math.max(x1 - x0, 2)}px"></div>`
      }
    }
    this.selectionLayer.innerHTML = html
    const head = selection.head
    const x = this.x(head.line, head.col)
    const y = head.line * height
    this.caret.style.transform = `translate(${x}px,${y}px)`
    this.input.style.transform = `translate(${x}px,${y}px)`
    // The caret shows steadily after a move, then blinks.
    this.caret.classList.remove('ed-blink')
    void this.caret.offsetWidth
    this.caret.classList.add('ed-blink')
    const composition = this.model.composition
    if (composition && composition.text) {
      const end = this.model.buffer.clip({ line: composition.from.line, col: composition.from.col + composition.text.length })
      const x0 = this.x(composition.from.line, composition.from.col)
      const x1 = end.line === composition.from.line ? this.x(end.line, end.col) : x0 + this.charWidth
      this.compositionLayer.innerHTML = `<div style="transform:translate(${x0}px,${composition.from.line * height}px);width:${Math.max(x1 - x0, 2)}px"></div>`
    } else if (this.compositionLayer.firstChild) this.compositionLayer.innerHTML = ''
  }

  /** Scrolls so the caret is in view. */
  revealCaret(): void {
    const head = this.model.selection.head
    const top = head.line * this.lineHeight
    const scroller = this.scroller
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (top + this.lineHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + this.lineHeight - scroller.clientHeight
    const x = this.x(head.line, head.col)
    const visible = scroller.clientWidth - this.gutterWidth
    if (x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - 40)
    else if (x + 20 > scroller.scrollLeft + visible) scroller.scrollLeft = x + 60 - visible
  }

  /** Puts the caret on a line (1-based, as a stack trace names it) and centres it. */
  revealLine(line: number, column = 1): void {
    const target = this.model.buffer.clip({ line: line - 1, col: Math.max(0, column - 1) })
    this.model.setSelection(target)
    this.scroller.scrollTop = Math.max(0, target.line * this.lineHeight - this.scroller.clientHeight / 2)
    this.render()
  }

  focus(): void {
    this.input.focus({ preventScroll: true })
  }

  // ---- events ----

  private listen(): void {
    const input = this.input
    input.addEventListener('keydown', (event) => this.onKeyDown(event))
    input.addEventListener('beforeinput', (event) => {
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault()
        if (event.inputType === 'historyUndo') this.model.undo()
        else this.model.redo()
        this.revealCaret()
      }
    })
    input.addEventListener('input', () => this.onInput())
    input.addEventListener('compositionstart', () => {
      this.model.startComposition()
      input.value = ''
    })
    input.addEventListener('compositionend', (event) => {
      const text = event.data ?? input.value
      input.value = ''
      this.model.endComposition(text)
      this.revealCaret()
    })
    input.addEventListener('copy', (event) => this.onCopy(event, false))
    input.addEventListener('cut', (event) => this.onCopy(event, true))
    input.addEventListener('paste', (event) => {
      event.preventDefault()
      const text = event.clipboardData?.getData('text/plain')
      if (text) {
        this.model.paste(text)
        this.revealCaret()
      }
    })
    input.addEventListener('focus', () => this.root.classList.add('ed-focused'))
    input.addEventListener('blur', () => {
      this.root.classList.remove('ed-focused')
      this.model.history.seal()
    })
    this.scroller.addEventListener('scroll', () => this.render(), { passive: true })
    this.textLayer.addEventListener('mousedown', (event) => this.onMouseDown(event))
    this.gutter.addEventListener('mousedown', (event) => this.onGutterDown(event))
    new ResizeObserver(() => this.render()).observe(this.scroller)
  }

  private onInput(): void {
    const value = this.input.value
    if (this.model.composition) {
      this.model.updateComposition(value)
      return
    }
    if (!value) return
    this.input.value = ''
    this.model.type(value)
    this.revealCaret()
  }

  private onCopy(event: ClipboardEvent, cut: boolean): void {
    event.preventDefault()
    const text = this.model.selectedText()
    this.input.value = ''
    if (!text) return
    event.clipboardData?.setData('text/plain', text)
    if (cut) {
      this.model.cut()
      this.revealCaret()
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return
    if (this.keyHandlers.some((handler) => handler(event))) {
      event.preventDefault()
      return
    }
    const handled = this.command(event)
    if (handled) {
      event.preventDefault()
      this.revealCaret()
      return
    }
    const mod = this.isMac ? event.metaKey : event.ctrlKey
    if (mod && !event.altKey && (event.key === 'c' || event.key === 'x' || event.key === 'C' || event.key === 'X')) {
      // A copy or cut event fires only with something selected in the textarea.
      this.input.value = ' '
      this.input.select()
    }
  }

  /** A key that edits or moves; false for one left to the browser or to Orca (Ctrl+S, Ctrl+V, …). */
  private command(event: KeyboardEvent): boolean {
    const model = this.model
    const key = event.key
    const shift = event.shiftKey
    const mod = this.isMac ? event.metaKey : event.ctrlKey
    // A word: Ctrl on Windows and Linux, Option on a Mac.
    const word = this.isMac ? event.altKey : event.ctrlKey
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / this.lineHeight) - 1)
    switch (key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = key === 'ArrowLeft' ? -1 : 1
        if (this.isMac && event.metaKey) model.move('lineEdge', dir, shift)
        else model.move(word ? 'word' : 'char', dir, shift)
        return true
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = key === 'ArrowUp' ? -1 : 1
        if (this.isMac && event.metaKey) model.move('docEdge', dir, shift)
        else if (!this.isMac && event.ctrlKey) {
          this.scroller.scrollTop += dir * this.lineHeight
          return false
        } else model.move('line', dir, shift)
        return true
      }
      case 'PageUp':
      case 'PageDown':
        model.move('page', key === 'PageUp' ? -1 : 1, shift, page)
        this.scroller.scrollTop += (key === 'PageUp' ? -1 : 1) * page * this.lineHeight
        return true
      case 'Home':
      case 'End':
        model.move(mod ? 'docEdge' : 'lineEdge', key === 'Home' ? -1 : 1, shift)
        return true
      case 'Backspace':
      case 'Delete':
        model.deleteBy(key === 'Backspace' ? -1 : 1, word)
        return true
      case 'Enter':
        if (mod || event.altKey) return false
        model.enter()
        return true
      case 'Tab':
        if (mod || event.altKey) return false
        model.tab(shift)
        return true
    }
    if (!mod || event.altKey) return false
    switch (key.toLowerCase()) {
      case 'a':
        model.selectAll()
        return true
      case 'z':
        if (shift) model.redo()
        else model.undo()
        return true
      case 'y':
        if (this.isMac) return false
        model.redo()
        return true
    }
    return false
  }

  private onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    this.focus()
    const model = this.model
    model.history.seal()
    const at = this.posFromPoint(event.clientX, event.clientY)
    let unit: 'char' | 'word' | 'line' = 'char'
    let base: { from: Pos; to: Pos } = { from: at, to: at }
    if (event.detail === 2) {
      const word = model.wordAt(at)
      if (word) {
        unit = 'word'
        base = word
        model.setSelection(word.from, word.to)
      } else model.setSelection(at)
    } else if (event.detail >= 3) {
      unit = 'line'
      base = model.lineAt(at.line)
      model.setSelection(base.from, base.to)
    } else model.setSelection(event.shiftKey ? model.selection.anchor : at, at)
    const anchor = model.selection.anchor
    let last = event
    const extend = (move: MouseEvent) => {
      const to = this.posFromPoint(move.clientX, move.clientY)
      if (unit === 'char') model.setSelection(anchor, to)
      else {
        const around = unit === 'word' ? (model.wordAt(to) ?? { from: to, to }) : model.lineAt(to.line)
        if (comparePos(to, base.from) < 0) model.setSelection(base.to, around.from)
        else model.setSelection(base.from, around.to)
      }
    }
    // Dragging past the edge scrolls.
    const timer = setInterval(() => {
      const box = this.scroller.getBoundingClientRect()
      const dy = last.clientY < box.top ? last.clientY - box.top : last.clientY > box.bottom ? last.clientY - box.bottom : 0
      if (dy) {
        this.scroller.scrollTop += dy
        extend(last)
      }
    }, 30)
    const move = (next: MouseEvent) => {
      last = next
      extend(next)
    }
    const up = () => {
      clearInterval(timer)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private onGutterDown(event: MouseEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    this.focus()
    const box = this.inner.getBoundingClientRect()
    const line = Math.floor((event.clientY - box.top) / this.lineHeight)
    if (line < 0 || line >= this.model.buffer.lineCount) return
    const target = event.target as HTMLElement | null
    if (target?.classList.contains('ed-mark') && this.onMarkClick) {
      this.onMarkClick(line)
      return
    }
    // A line number selects its line.
    const range = this.model.lineAt(line)
    this.model.setSelection(range.from, range.to)
  }
}
