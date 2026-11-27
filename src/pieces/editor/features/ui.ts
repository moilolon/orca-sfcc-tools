// What the language features draw, as plain data: the controllers decide it with no DOM (tested in
// Node), and dom.ts draws it in the surface's pop-up layer and underline layer.
import type { Pos } from '../surface/buffer'
import type { Underline } from '../surface/view'

/** A line of a pop-up: code (a signature, a name), text, a muted note, or a problem by its severity. */
export type Section = { tone: 'code' | 'text' | 'muted' | 'error' | 'warning' | 'info'; text: string }

export type ListItemView = {
  label: string
  /** A signature, a type, a folder, the storefronts. */
  detail: string | null
  /** The kind as a word (`method`, `template`), or a place's line. */
  note: string | null
  deprecated: boolean
}

/** A list under a place: the completion list, or the places a definition or references lead to. */
export type ListView = {
  role: 'completion' | 'definition' | 'references'
  anchor: Pos
  /** A title over the places (`3 references to price`); none over the completion list. */
  title: string | null
  items: ListItemView[]
  selected: number
  /** The selected completion item's description, once read. */
  description: Section[] | null
}

/** A hover over a range: what the engine says of it, and the problems there. */
export type HoverView = { anchor: Pos; sections: Section[]; link: string | null }

/** Signature help over the line: the active signature split around its active parameter. */
export type SignatureView = { anchor: Pos; before: string; active: string; after: string; note: string | null; sections: Section[] }

/** A one-line message at a place, gone at the next key: nothing found, a file that did not open. */
export type HintView = { anchor: Pos; text: string }

/** Where the features draw; one of each at a time, null hides it. */
export type FeatureUi = {
  list(view: ListView | null): void
  hover(view: HoverView | null): void
  signature(view: SignatureView | null): void
  hint(view: HintView | null): void
  underlines(list: Underline[]): void
}
