// Starts the editor's debugging features (phase 7.3) on a surface: the controller over Orca's
// requests, the gutter's clicks and F9 (Orca binds no F9), the stopped line, and the value pop-up
// under the pointer while a thread is halted in a script. app.ts calls `attachDebug` once and tells
// it of a flush and of the editor's own save; the rest it listens to itself: which text is on disk
// after a write from outside (the document sync's replace) or a save of a text it holds.
import type { OrcaFrameApi } from 'orca/frame'
import { t } from '../../../core/i18n'
import { textLines } from '../../debugger/line-diff'
import type { IdentityStore } from '../identity'
import { sha256Hex } from '../locate-client'
import type { DocumentSync } from '../sync'
import type { EditorModel } from '../surface/model'
import type { SurfaceView } from '../surface/view'
import { DebugController, type DebugWords } from './controller'
import { HoverReader } from './expression'
import { debugMessages } from './i18n'

/** How long the pointer rests on a name before its value is asked. */
export const HOVER_DELAY_MS = 350

export type AttachedDebug = {
  /** Orca flushed this editor for a save. */
  flushed(): void
  /** The save that followed was this editor's, of its file. */
  saved(): void
}

export function attachDebug(options: { api: OrcaFrameApi; view: SurfaceView; model: EditorModel; identity: IdentityStore; sync: DocumentSync; notify: (text: string) => void }): AttachedDebug {
  const { api, view, model, identity, sync } = options
  const word: DebugWords = (key, vars) => t(debugMessages, api.locale, key, vars)
  const controller = new DebugController(
    {
      file: (input) => api.plugin.request('debugger.file', input),
      breakpoint: (input) => api.plugin.request('debugger.breakpoint', input),
      hover: (input) => api.plugin.request('debugger.hover', input)
    },
    {
      setMarks: (marks) => view.setLineMarks(marks),
      setClickable: (clickable) => {
        view.setMarksClickable(clickable)
        view.onMarkClick = clickable ? (line) => void controller.toggle(line) : null
      },
      setHighlight: (highlight) => view.setLineHighlight(highlight),
      reveal: (line) => view.revealLine(line + 1),
      notify: options.notify
    },
    word,
    () => model.buffer.lines
  )

  const follow = () => {
    const current = identity.value
    controller.setFile(current.state === 'identified' ? { workspaceId: current.workspaceId, path: current.path } : null)
  }
  identity.subscribe(follow)
  follow()
  model.buffer.onChange((fromLine, oldEnd, newEnd, change) => controller.bufferChanged(fromLine, oldEnd, newEnd, change))
  // Any change of the session or the store: the file's state is asked again.
  api.plugin.on('debugger.state', () => void controller.refresh())
  // A write from outside: its text is the file now (the outside side of a merge, else the text
  // given), and the marks stay on the store's lines.
  let lastMerge = sync.lastMerge()
  sync.onReplace((text) => {
    const merge = sync.lastMerge()
    const outside = merge && merge !== lastMerge ? merge.outside : text
    lastMerge = merge
    void controller.rebase(textLines(outside))
  })
  // A save of this file from any tab whose text this editor holds: that text is the file now.
  api.plugin.on('editor.saved', (payload) => {
    const current = identity.value
    if (current.state !== 'identified' || payload?.workspaceId !== current.workspaceId || payload.path !== current.path) return
    const text = model.text()
    void sha256Hex(text).then((hash) => {
      if (hash === payload.hash && model.text() === text) void controller.rebase([...model.buffer.lines])
    })
  })

  const hover = valuePopup(view, model, controller, word)
  view.addKeyHandler((event) => {
    if (event.key === 'Escape') hover.hide()
    if (event.key !== 'F9' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false
    hover.hide()
    void controller.toggle(model.selection.head.line)
    return true
  })
  controller.onState(() => hover.hide())

  return {
    flushed: () => controller.flushed(),
    saved: () => void controller.savedOwn()
  }
}

/** The value under the pointer: asked after it rests, shown below the name, gone when it moves off. */
function valuePopup(view: SurfaceView, model: EditorModel, controller: DebugController, word: DebugWords): { hide(): void } {
  const reader = new HoverReader()
  let timer: ReturnType<typeof setTimeout> | null = null
  let asked = 0
  let shown: { box: HTMLDivElement; from: number; to: number } | null = null

  function hide(): void {
    asked++
    if (timer) clearTimeout(timer)
    timer = null
    shown?.box.remove()
    shown = null
  }

  async function show(clientX: number, clientY: number): Promise<void> {
    if (!controller.stopped) return hide()
    const at = view.posAtPoint(clientX, clientY)
    if (!at) return hide()
    const buffer = model.buffer
    const offset = buffer.offsetAt(at)
    if (shown && offset >= shown.from && offset < shown.to) return
    const target = reader.at(buffer.text(), offset)
    if (!target) return hide()
    const mine = ++asked
    const value = await controller.hoverValue(target.expression)
    if (mine !== asked) return
    shown?.box.remove()
    shown = null
    if (!value) return
    const box = document.createElement('div')
    box.className = 'ed-debug-value'
    box.setAttribute('role', 'tooltip')
    box.setAttribute('aria-label', word('valueLabel'))
    const name = document.createElement('span')
    name.className = 'ed-debug-expression'
    name.textContent = value.expression
    box.append(name, document.createTextNode(` = ${value.value}`))
    if (value.expandable) {
      const more = document.createElement('div')
      more.className = 'ed-debug-muted'
      more.textContent = word('valueMembers')
      box.appendChild(more)
    }
    const place = view.boxAt(buffer.posAt(target.from))
    box.style.left = `${Math.max(0, place.x)}px`
    box.style.top = `${place.y + place.height + 2}px`
    view.popupLayer.appendChild(box)
    // Above the line when it would run past the bottom.
    const room = view.root.clientHeight
    if (room > 0 && place.y + place.height + 2 + box.offsetHeight > room) box.style.top = `${Math.max(0, place.y - box.offsetHeight - 2)}px`
    shown = { box, from: target.from, to: target.to }
  }

  view.scroller.addEventListener('mousemove', (event) => {
    if (!controller.stopped) {
      if (shown || timer) hide()
      return
    }
    if (timer) clearTimeout(timer)
    const { clientX, clientY } = event
    timer = setTimeout(() => {
      timer = null
      void show(clientX, clientY)
    }, HOVER_DELAY_MS)
  })
  view.scroller.addEventListener('mouseleave', hide)
  view.scroller.addEventListener('scroll', hide, { passive: true })
  view.scroller.addEventListener('mousedown', hide)
  return { hide }
}
