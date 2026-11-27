// What every language feature is given: the model, the text as the engine reads it, the engine's
// requests, where to draw, which file a query names, and the clock. Pure: no DOM, no Orca.
import type { EngineAnswerState, EngineQuery } from '../../engine/protocol'
import type { Pos } from '../surface/buffer'
import type { EditorModel } from '../surface/model'
import type { QueryDocument, QueryFile } from './document'
import type { EngineRequests } from './requests'
import type { FeatureUi } from './ui'
import { engineWord, word, type EditorWord } from './words'

export type FeatureName = 'complete' | 'hover' | 'definition' | 'references' | 'signature' | 'problems'

export type FeatureContext = {
  model: EditorModel
  document: QueryDocument
  requests: EngineRequests
  ui: FeatureUi
  /** What a query names now; null when nothing may be asked (XML or `.properties` not identified). */
  file: () => QueryFile | null
  locale: string
  /** Puts the caret at a place and brings it into view. */
  reveal: (at: Pos) => void
  now: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Each answer drawn: the feature, and the time from the key (or the pause) that asked to the draw. */
  measured: (feature: FeatureName, ms: number) => void
  /** Says something once per state at the caret: the index is not ready, the file is too large. */
  tellOnce: (key: string, text: string) => void
}

/** A query at an offset of the text now, for the file named now; null when nothing may be asked. */
export function queryAt(ctx: FeatureContext, offset: number): (EngineQuery & { located: boolean }) | null {
  const file = ctx.file()
  if (!file || !file.queries || ctx.model.composition) return null
  return { workspaceId: file.workspaceId, path: file.path, text: ctx.document.text(), offset, located: file.located }
}

/** The plain query of `queryAt`, as the engine takes it. */
export const plain = ({ workspaceId, path, text, offset }: EngineQuery): EngineQuery => ({ workspaceId, path, text, offset })

/**
 * What an answer's state says that the person should hear, once per state: the workspace is being
 * indexed, its index failed, or the file is too large to read. A file not identified asks under no
 * workspace on purpose (document.ts): its `none` is said by 7.1's notice already.
 */
export function noteState(ctx: FeatureContext, answer: EngineAnswerState, located: boolean): void {
  if (answer.error === 'text_too_large') ctx.tellOnce('tooLarge', word(ctx.locale, 'tooLarge'))
  else if (!located) return
  else if (answer.index === 'building') ctx.tellOnce('building', word(ctx.locale, 'indexBuilding'))
  else if (answer.index === 'failed') ctx.tellOnce('failed', word(ctx.locale, 'indexFailed'))
  // Another workspace is indexed (the uploading one): only what needs no other file answers.
  else if (answer.index === 'none') ctx.tellOnce('none', engineWord(ctx.locale, 'indexNone'))
}

/** A hint at the caret, gone at the next key or after a few seconds. */
export function hint(ctx: FeatureContext, key: EditorWord, at: Pos = ctx.model.selection.head): void {
  ctx.ui.hint({ anchor: at, text: word(ctx.locale, key) })
}
