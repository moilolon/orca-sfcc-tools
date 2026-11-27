// Starts the editor's debugging features (phase 7.3) on a surface: the controller over Orca's
// requests, the gutter's clicks and F9 (Orca binds no F9), the stopped line, and the value pop-up
// under the pointer while a thread is halted in the file. app.ts calls `attachDebug` once and tells
// it of a flush and of the editor's own save; the rest it listens to itself.
import type { OrcaFrameApi } from 'orca/frame'
import { t } from '../../../core/i18n'
import type { IdentityStore } from '../identity'
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

export function attachDebug(options: { api: OrcaFrameApi; view: SurfaceView; model: EditorModel; identity: IdentityStore; notify: (text: string) => void }): AttachedDebug {
  const { api, view, model, identity } = options
  const word: DebugWords = (key, vars) => t(debugMessages, api.locale, key, vars)
  const controller = new DebugController(
    {
      file: (input) => api.plugin.request('debugger.file', input),
      breakpoint: (input) => api.plugin.request('debugger.breakpoint', input),
      setBreakpoints: (input) => api.plugin.request('debugger.setBreakpoints', input),
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
    () => model.buffer.lineCount
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
    saved: () => void controller.saved()
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
