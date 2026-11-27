// Starts the editor's debugging features (phase 7.3) on a surface: the controller over Orca's
// requests, the gutter's clicks and F9 (Orca binds no F9), the stopped line, and the value of the
// name under the pointer while a thread is halted in a script, which the language features' one
// pointer pop-up shows first (features/hover.ts). app.ts calls `attachDebug` once and tells
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
import type { Section, ValueAt } from '../features/ui'
import { HoverReader } from './expression'
import { debugMessages } from './i18n'

export type AttachedDebug = {
  /** Orca flushed this editor for a save. */
  flushed(): void
  /** The save that followed was this editor's, of its file. */
  saved(): void
  /** The value under a place while halted, for the editor's pointer pop-up. */
  valueAt: ValueAt
  /** The session or the file's state changed: a value shown may be gone. */
  onState(listener: () => void): void
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

  view.addKeyHandler((event) => {
    if (event.key !== 'F9' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false
    void controller.toggle(model.selection.head.line)
    return true
  })

  return {
    flushed: () => controller.flushed(),
    saved: () => void controller.savedOwn(),
    valueAt: valueSource(model, controller, word),
    onState: (listener) => controller.onState(listener)
  }
}

/**
 * The value of the name at an offset while a thread is halted in this script: its range in the
 * text and its lines, for the editor's one pointer pop-up (features/hover.ts draws it first, the
 * language hover under it); null when not halted or there is no value.
 */
function valueSource(model: EditorModel, controller: DebugController, word: DebugWords): ValueAt {
  const reader = new HoverReader()
  return async (offset) => {
    if (!controller.stopped) return null
    const target = reader.at(model.buffer.text(), offset)
    if (!target) return null
    const value = await controller.hoverValue(target.expression)
    if (!value || !controller.stopped) return null
    const sections: Section[] = [{ tone: 'code', text: `${value.expression} = ${value.value}` }]
    if (value.expandable) sections.push({ tone: 'muted', text: word('valueMembers') })
    return { from: target.from, to: target.to, label: word('valueLabel'), sections }
  }
}
