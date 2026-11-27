// Go to definition (F12, Mod+click: `engine.definition`) and references (Shift+F12:
// `engine.references`). One place in this file moves the caret; one in another file opens it in
// this editor at its line, through the worker (`editor.open`, src/core/open-file.ts with
// `inEditor`); several places (one copy per storefront, the references) are a list to choose
// from, each labelled with its file, line and storefronts. A file 7.1 could not name is asked
// under no workspace (document.ts), so only its own declarations are found. Pure: no DOM.
import { openFailureKey } from '../../engine/i18n'
import type { EngineDefinition, EngineReferences } from '../../engine/protocol'
import { hint, noteState, plain, queryAt, type FeatureContext } from './context'
import { Latest } from './document'
import { listKey, type KeyPress } from './keys'
import { PAGE_ROWS } from './completion'
import { engineWord, placeItem, word } from './words'

/** The most places a list draws; the title says how many there are. */
export const MAX_PLACES = 200

/**
 * A place to go: its file and line, and its range when it is an offset of the text the editor sent
 * (a declaration of the file, a reference read from the text) rather than of the file on disk.
 */
export type Place = { path: string; line: number; start: number | null; storefronts: string[] | null; definition: boolean }

type Shown = { role: 'definition' | 'references'; title: string; places: Place[]; selected: number; version: number; anchor: number }

export class NavigationController {
  private readonly ctx: FeatureContext
  private readonly latest: Latest
  private shown: Shown | null = null

  constructor(ctx: FeatureContext) {
    this.ctx = ctx
    this.latest = new Latest(ctx.document)
  }

  get isOpen(): boolean {
    return this.shown !== null
  }

  /** F12 at the caret, or Mod+click at an offset. */
  async definition(offset: number, startedAt: number): Promise<void> {
    this.close()
    const query = queryAt(this.ctx, offset)
    if (!query) return hint(this.ctx, 'noDefinition')
    const current = this.latest.begin()
    let answer: EngineDefinition
    try {
      answer = await this.ctx.requests.definition(plain(query))
    } catch {
      return
    }
    if (!current()) return
    noteState(this.ctx, answer, query.located)
    const definition = answer.definition
    if (!definition || definition.targets.length === 0) {
      hint(this.ctx, query.located ? 'noDefinition' : 'noDefinitionHere')
      this.ctx.measured('definition', this.ctx.now() - startedAt)
      return
    }
    // A declaration of this file is found in the text sent: its offsets are this text's.
    const local = definition.kind === 'declaration'
    const places = definition.targets.map((target) => ({
      path: target.path,
      line: target.line,
      start: local && target.path === query.path ? target.start : null,
      storefronts: target.storefronts,
      definition: true
    }))
    if (places.length === 1) {
      await this.go(places[0], this.ctx.document.version)
    } else {
      this.shown = { role: 'definition', title: word(this.ctx.locale, 'definitions', { count: places.length }), places, selected: 0, version: this.ctx.document.version, anchor: definition.range.start }
      this.draw()
    }
    this.ctx.measured('definition', this.ctx.now() - startedAt)
  }

  /** Shift+F12 at the caret: every read of the exported function there. */
  async references(offset: number, startedAt: number): Promise<void> {
    this.close()
    const query = queryAt(this.ctx, offset)
    if (!query) return hint(this.ctx, 'noReferences')
    const current = this.latest.begin()
    let answer: EngineReferences
    try {
      answer = await this.ctx.requests.references(plain(query))
    } catch {
      return
    }
    if (!current()) return
    noteState(this.ctx, answer, query.located)
    const found = answer.references
    if (!found || found.references.length === 0) {
      hint(this.ctx, 'noReferences')
      this.ctx.measured('references', this.ctx.now() - startedAt)
      return
    }
    // The file asked on is read from its text: those offsets are this text's.
    const places = found.references.map((entry) => ({
      path: entry.path,
      line: entry.line,
      start: entry.path === query.path ? entry.start : null,
      storefronts: entry.storefronts,
      definition: entry.kind === 'definition'
    }))
    const name = found.name
    const title = found.truncated ? word(this.ctx.locale, 'referencesMore', { count: places.length, name }) : word(this.ctx.locale, 'references', { count: places.length, name })
    this.shown = { role: 'references', title, places, selected: 0, version: this.ctx.document.version, anchor: found.range.start }
    this.draw()
    this.ctx.measured('references', this.ctx.now() - startedAt)
  }

  /** A key while the list of places is open: true when it took it. */
  key(press: KeyPress): boolean {
    const shown = this.shown
    if (!shown) return false
    const action = listKey(press, false)
    if (!action) return false
    if (action === 'close') {
      this.close()
      return true
    }
    if (action === 'accept') {
      void this.choose(shown.selected)
      return true
    }
    const count = Math.min(shown.places.length, MAX_PLACES)
    const step = action === 'up' ? -1 : action === 'down' ? 1 : action === 'pageUp' ? -PAGE_ROWS : PAGE_ROWS
    shown.selected = action === 'up' || action === 'down' ? (shown.selected + step + count) % count : Math.max(0, Math.min(count - 1, shown.selected + step))
    this.draw()
    return true
  }

  select(index: number): void {
    const shown = this.shown
    if (!shown || index < 0 || index >= Math.min(shown.places.length, MAX_PLACES) || index === shown.selected) return
    shown.selected = index
    this.draw()
  }

  /** A place of the list chosen: the list closes and the place opens. */
  async choose(index: number): Promise<void> {
    const shown = this.shown
    const place = shown?.places[index]
    if (!shown || !place) return
    this.close()
    await this.go(place, shown.version)
  }

  close(): void {
    if (this.shown) {
      this.shown = null
      this.ctx.ui.list(null)
    }
  }

  /** Goes to a place: in this file, the caret; in another, the file opened in this editor at its line. */
  async go(place: Place, version: number): Promise<void> {
    const file = this.ctx.file()
    if (!file) return
    if (place.path === file.path) {
      const document = this.ctx.document
      // An offset of the text the answer read, while that text is still the one shown; else its line.
      const at = place.start !== null && version === document.version ? document.posOf(place.start) : { line: Math.max(0, place.line - 1), col: 0 }
      this.ctx.reveal(at)
      return
    }
    if (!file.located) return hint(this.ctx, 'noDefinitionHere')
    try {
      const result = await this.ctx.requests.open({ workspaceId: file.workspaceId, path: place.path, line: place.line })
      if (!result.opened) this.ctx.ui.hint({ anchor: this.ctx.model.selection.head, text: engineWord(this.ctx.locale, openFailureKey(result.reason)) })
    } catch {
      this.ctx.ui.hint({ anchor: this.ctx.model.selection.head, text: engineWord(this.ctx.locale, 'openFailed') })
    }
  }

  private draw(): void {
    const shown = this.shown
    if (!shown) return
    const locale = this.ctx.locale
    const items = shown.places.slice(0, MAX_PLACES).map((place) => placeItem(locale, place, place.definition && shown.role === 'references' ? word(locale, 'definitionPlace') : null))
    this.ctx.ui.list({ role: shown.role, anchor: this.ctx.document.posOf(shown.anchor), title: shown.title, items, selected: shown.selected, description: null })
  }
}
