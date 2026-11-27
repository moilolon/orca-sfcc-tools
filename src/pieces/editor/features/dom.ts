// The language features in the editor frame: the frame's events turned into calls of features.ts,
// and what the features decide drawn in the surface's pop-up layer (a list, a hover, the signature,
// a hint) and its underline layer. Keys and clicks are taken in the capture phase on the surface's
// root, before the surface's own handlers, and only when a feature wants them. Every text is set
// with `textContent`: nothing the engine answers is read as HTML. Nothing is logged or stored.
import type { OrcaFrameApi } from 'orca/frame'
import type { Language } from '../highlight/language'
import type { IdentityStore } from '../identity'
import type { Pos } from '../surface/buffer'
import type { EditorModel } from '../surface/model'
import type { SurfaceView } from '../surface/view'
import type { FeatureContext, FeatureName } from './context'
import { fileFor, QueryDocument } from './document'
import { Features } from './features'
import { HOVER_DELAY_MS } from './hover'
import type { KeyPress } from './keys'
import { frameRequests, type EngineRequests } from './requests'
import type { FeatureUi, HintView, HoverView, ListView, Section, SignatureView } from './ui'
import { word } from './words'

/** How long a hint stays when no key comes. */
export const HINT_MS = 4_000
/** The answers' times kept per feature, for a live check (`latency()`). */
export const KEPT_TIMES = 50

export const FEATURE_STYLES = `
.ed-pop { position: absolute; max-width: min(560px, calc(100vw - 16px)); box-sizing: border-box; font-size: 12px; line-height: 1.45;
  color: var(--orca-popover-foreground, var(--orca-foreground, #1f2328)); background: var(--orca-popover, var(--orca-background, #fff));
  border: 1px solid var(--orca-border, #d1d9e0); border-radius: calc(var(--orca-radius, 6px) - 2px); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16); }
.ed-pop[hidden] { display: none; }
.ed-pop .ed-code { font-family: var(--ed-font); white-space: pre-wrap; word-break: break-word; }
.ed-pop .ed-muted { color: var(--orca-muted-foreground, #59636e); }
.ed-list { min-width: 240px; max-width: min(620px, calc(100vw - 16px)); }
.ed-list-title { padding: 4px 8px; border-bottom: 1px solid var(--orca-border, #d1d9e0); color: var(--orca-muted-foreground, #59636e); }
.ed-list-rows { max-height: calc(12 * 22px); overflow-y: auto; }
.ed-row { display: flex; align-items: baseline; gap: 8px; height: 22px; padding: 0 8px; cursor: pointer; white-space: nowrap; }
.ed-row > * { overflow: hidden; text-overflow: ellipsis; }
.ed-row .ed-label { flex: 0 1 auto; font-family: var(--ed-font); }
.ed-row .ed-detail { flex: 1 1 auto; min-width: 0; color: var(--orca-muted-foreground, #59636e); font-family: var(--ed-font); font-size: 11px; }
.ed-row .ed-note { flex: none; margin-left: auto; color: var(--orca-muted-foreground, #59636e); font-size: 11px; }
.ed-row.ed-deprecated .ed-label { text-decoration: line-through; }
.ed-row:hover { background: color-mix(in srgb, var(--orca-accent, #eef1f4) 60%, transparent); }
.ed-row.ed-selected { background: var(--orca-accent, #eef1f4); color: var(--orca-accent-foreground, inherit); }
.ed-sections { padding: 6px 8px; max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.ed-list .ed-sections { border-top: 1px solid var(--orca-border, #d1d9e0); }
.ed-sections > div { white-space: pre-wrap; word-break: break-word; }
.ed-tone-error, .ed-tone-warning, .ed-tone-info { padding-left: 14px; position: relative; }
.ed-tone-error::before, .ed-tone-warning::before, .ed-tone-info::before { content: ''; position: absolute; left: 0; top: 0.45em; width: 8px; height: 8px; border-radius: 50%; }
.ed-tone-error::before { background: var(--ed-error); } .ed-tone-warning::before { background: var(--ed-warning); } .ed-tone-info::before { background: var(--ed-info); }
.ed-pop button { font: inherit; color: var(--orca-primary, #0969da); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.ed-pop button:focus-visible { outline: 2px solid var(--orca-ring, #0969da); outline-offset: 1px; }
.ed-signature { padding: 4px 8px; }
.ed-signature .ed-active { font-weight: 700; text-decoration: underline; }
.ed-signature .ed-sections { padding: 4px 0 0; }
.ed-hint { padding: 3px 8px; color: var(--orca-muted-foreground, #59636e); }
`

type Box = { x: number; y: number; height: number }

/** Draws the features' pop-ups in the surface's pop-up layer, each placed at its anchor. */
export class PopupLayer implements FeatureUi {
  private readonly view: SurfaceView
  private readonly api: OrcaFrameApi
  private readonly elements = new Map<'list' | 'hover' | 'signature' | 'hint', HTMLDivElement>()
  private readonly anchors = new Map<'list' | 'hover' | 'signature' | 'hint', { anchor: Pos; below: boolean }>()
  private hintTimer: ReturnType<typeof setTimeout> | null = null
  /** A row of the list clicked; a row's index. */
  onChoose: (role: ListView['role'], index: number) => void = () => {}
  /** The pointer left the hover's box. */
  onHoverLeave: (related: EventTarget | null) => void = () => {}

  constructor(view: SurfaceView, api: OrcaFrameApi) {
    this.view = view
    this.api = api
  }

  /** Whether a node is inside one of the pop-ups. */
  holds(node: EventTarget | null): boolean {
    return node instanceof Node && this.view.popupLayer.contains(node)
  }

  private element(name: 'list' | 'hover' | 'signature' | 'hint'): HTMLDivElement {
    let element = this.elements.get(name)
    if (!element) {
      element = document.createElement('div')
      element.className = `ed-pop ed-${name}`
      element.hidden = true
      // A press inside a pop-up keeps the focus (and the caret) in the text.
      element.addEventListener('mousedown', (event) => event.preventDefault())
      if (name === 'hover') element.addEventListener('mouseleave', (event) => this.onHoverLeave(event.relatedTarget))
      this.view.popupLayer.appendChild(element)
      this.elements.set(name, element)
    }
    return element
  }

  private hide(name: 'list' | 'hover' | 'signature' | 'hint'): void {
    const element = this.elements.get(name)
    if (element) {
      element.hidden = true
      element.replaceChildren()
    }
    this.anchors.delete(name)
  }

  /** Places a pop-up under its anchor's line (or over it), inside the editor's box. */
  private place(name: 'list' | 'hover' | 'signature' | 'hint', anchor: Pos, below: boolean): void {
    const element = this.elements.get(name)
    if (!element) return
    this.anchors.set(name, { anchor, below })
    const box: Box = this.view.boxAt(anchor)
    const width = this.view.root.clientWidth
    const height = this.view.root.clientHeight
    const own = element.getBoundingClientRect()
    const left = Math.max(4, Math.min(box.x, width - own.width - 4))
    let top = below ? box.y + box.height : box.y - own.height
    if (below && top + own.height > height && box.y - own.height >= 0) top = box.y - own.height
    if (!below && top < 0) top = box.y + box.height
    element.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }

  /** After a scroll: every pop-up placed again at its anchor. */
  relayout(): void {
    for (const [name, { anchor, below }] of this.anchors) this.place(name, anchor, below)
  }

  private sections(sections: readonly Section[]): HTMLDivElement {
    const box = document.createElement('div')
    box.className = 'ed-sections'
    for (const section of sections) {
      const line = document.createElement('div')
      line.className = section.tone === 'code' ? 'ed-code' : section.tone === 'muted' ? 'ed-muted' : section.tone === 'text' ? '' : `ed-tone-${section.tone}`
      line.textContent = section.text
      box.appendChild(line)
    }
    return box
  }

  list(view: ListView | null): void {
    if (!view) return this.hide('list')
    const element = this.element('list')
    const children: HTMLElement[] = []
    if (view.title) {
      const title = document.createElement('div')
      title.className = 'ed-list-title'
      title.textContent = view.title
      children.push(title)
    }
    const rows = document.createElement('div')
    rows.className = 'ed-list-rows'
    rows.setAttribute('role', 'listbox')
    let selected: HTMLElement | null = null
    view.items.forEach((item, index) => {
      const row = document.createElement('div')
      row.className = `ed-row${index === view.selected ? ' ed-selected' : ''}${item.deprecated ? ' ed-deprecated' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(index === view.selected))
      const label = document.createElement('span')
      label.className = 'ed-label'
      label.textContent = item.label
      row.appendChild(label)
      if (item.detail) {
        const detail = document.createElement('span')
        detail.className = 'ed-detail'
        detail.textContent = item.detail
        row.appendChild(detail)
      }
      if (item.note) {
        const note = document.createElement('span')
        note.className = 'ed-note'
        note.textContent = item.note
        row.appendChild(note)
      }
      row.addEventListener('click', () => this.onChoose(view.role, index))
      if (index === view.selected) selected = row
      rows.appendChild(row)
    })
    children.push(rows)
    if (view.description && view.description.length > 0) children.push(this.sections(view.description))
    element.replaceChildren(...children)
    element.hidden = false
    ;(selected as HTMLElement | null)?.scrollIntoView({ block: 'nearest' })
    this.place('list', view.anchor, true)
  }

  hover(view: HoverView | null): void {
    if (!view) return this.hide('hover')
    const element = this.element('hover')
    const children: HTMLElement[] = [this.sections(view.sections)]
    const shell = this.api.shell
    if (view.link && shell) {
      const link = view.link
      const open = document.createElement('button')
      open.type = 'button'
      open.textContent = word(this.api.locale, 'documentation')
      open.addEventListener('click', () => void shell.openExternal(link).catch(() => undefined))
      const footer = document.createElement('div')
      footer.className = 'ed-sections'
      footer.appendChild(open)
      children.push(footer)
    }
    element.replaceChildren(...children)
    element.hidden = false
    this.place('hover', view.anchor, false)
  }

  signature(view: SignatureView | null): void {
    if (!view) return this.hide('signature')
    const element = this.element('signature')
    const label = document.createElement('div')
    label.className = 'ed-code'
    const active = document.createElement('span')
    active.className = 'ed-active'
    active.textContent = view.active
    label.append(view.before, active, view.after)
    const children: HTMLElement[] = [label]
    if (view.note) {
      const note = document.createElement('div')
      note.className = 'ed-muted'
      note.textContent = view.note
      children.push(note)
    }
    if (view.sections.length > 0) children.push(this.sections(view.sections))
    element.replaceChildren(...children)
    element.hidden = false
    this.place('signature', view.anchor, false)
  }

  hint(view: HintView | null): void {
    if (this.hintTimer !== null) clearTimeout(this.hintTimer)
    this.hintTimer = null
    if (!view) return this.hide('hint')
    const element = this.element('hint')
    element.textContent = view.text
    element.setAttribute('role', 'status')
    element.hidden = false
    this.place('hint', view.anchor, true)
    this.hintTimer = setTimeout(() => this.hide('hint'), HINT_MS)
  }

  underlines(list: Parameters<FeatureUi['underlines']>[0]): void {
    this.view.setUnderlines(list)
  }
}

export type FeaturesOptions = {
  api: OrcaFrameApi
  view: SurfaceView
  model: EditorModel
  identity: IdentityStore
  /** The language the editor shows until its file is named. */
  language: () => Language
  /** The engine's requests; the worker's through the frame's bridge when left out. */
  requests?: EngineRequests
}

export type FeaturesHandle = {
  features: Features
  /** The answers' times drawn per feature (ms from the key to the draw), the newest last. */
  latency(): Partial<Record<FeatureName, number[]>>
  dispose(): void
}

const press = (event: KeyboardEvent): KeyPress => ({ key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey })

/** Starts the language features on a surface: what app.ts calls once the editor is drawn. */
export function startFeatures(options: FeaturesOptions): FeaturesHandle {
  const { api, view, model, identity } = options
  const style = document.createElement('style')
  style.textContent = FEATURE_STYLES
  document.head.appendChild(style)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  const ui = new PopupLayer(view, api)
  const queryDocument = new QueryDocument(model)
  const told = new Set<string>()
  const times: Partial<Record<FeatureName, number[]>> = {}
  const ctx: FeatureContext = {
    model,
    document: queryDocument,
    requests: options.requests ?? frameRequests(api.plugin),
    ui,
    file: () => fileFor(identity.value, options.language()),
    locale: api.locale,
    reveal: (at) => {
      model.setSelection(at)
      view.revealCaret()
    },
    now: () => performance.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    measured: (feature, ms) => {
      const list = (times[feature] ??= [])
      list.push(Math.round(ms * 10) / 10)
      if (list.length > KEPT_TIMES) list.shift()
    },
    tellOnce: (key, text) => {
      if (told.has(key)) return
      told.add(key)
      ui.hint({ anchor: model.selection.head, text })
    }
  }
  const features = new Features(ctx, { isMac })
  ui.onChoose = (role, index) => {
    if (role === 'completion') features.completion.choose(index)
    else void features.navigation.choose(index)
    view.focus()
  }

  const root = view.root
  const scroller = view.scroller
  const listeners: [EventTarget, string, EventListener, boolean][] = []
  const on = <E extends Event>(target: EventTarget, type: string, listener: (event: E) => void, capture = false) => {
    target.addEventListener(type, listener as EventListener, capture)
    listeners.push([target, type, listener as EventListener, capture])
  }
  const offsetAt = (event: MouseEvent): number | null => {
    const at = view.hitTest(event.clientX, event.clientY)
    return at ? queryDocument.offsetOf(at) : null
  }

  // Keys first to the features, in the capture phase: a key a feature takes never reaches the surface.
  on<KeyboardEvent>(root, 'keydown', (event) => {
    if (event.target !== view.input || event.isComposing || event.keyCode === 229) return
    if (features.keyDown(press(event), performance.now())) {
      event.preventDefault()
      event.stopPropagation()
    }
  }, true)
  // What a key typed, once the surface has put it in the text.
  on<InputEvent>(view.input, 'input', (event) => {
    if (!model.composition && event.inputType === 'insertText' && event.data) features.typed(event.data, performance.now())
  })
  model.onUpdate((event) => {
    if (event.provisional) return
    if (event.textChanged) features.changed(performance.now())
    else features.caretMoved(performance.now())
  })
  const unsubscribe = identity.subscribe(() => {
    told.clear()
    features.identityChanged()
  })

  // The pointer: a hover once it rests on a name; Mod+click goes to the definition.
  let rest: ReturnType<typeof setTimeout> | null = null
  on<MouseEvent>(scroller, 'mousemove', (event) => {
    if (event.buttons !== 0) return
    const offset = offsetAt(event)
    features.pointerMoved(offset, false)
    if (rest !== null) clearTimeout(rest)
    rest = setTimeout(() => features.pointerRest(offset, performance.now()), HOVER_DELAY_MS)
  })
  on<MouseEvent>(scroller, 'mouseleave', (event) => {
    if (rest !== null) clearTimeout(rest)
    features.pointerMoved(null, ui.holds(event.relatedTarget))
  })
  ui.onHoverLeave = (related) => {
    if (!(related instanceof Node && scroller.contains(related))) features.hover.close()
  }
  on<MouseEvent>(root, 'mousedown', (event) => {
    if (ui.holds(event.target)) return
    const mod = isMac ? event.metaKey : event.ctrlKey
    if (event.button === 0 && mod && !event.altKey && !event.shiftKey) {
      const offset = offsetAt(event)
      if (offset !== null) {
        event.preventDefault()
        event.stopPropagation()
        view.focus()
        features.definitionAt(offset, performance.now())
        return
      }
    }
    features.dismiss()
  }, true)
  on(scroller, 'scroll', () => ui.relayout())
  on(view.input, 'blur', () => features.dismiss())

  return {
    features,
    latency: () => times,
    dispose() {
      if (rest !== null) clearTimeout(rest)
      for (const [target, type, listener, capture] of listeners) target.removeEventListener(type, listener, capture)
      unsubscribe()
      features.dispose()
      style.remove()
    }
  }
}
