// What the editor's language features ask of the plugin's worker: the engine's queries (phase 6.4)
// and problems (6.5), and the editor's own request that opens another file at a line in this
// editor. The frame reaches them through `orca.plugin.request`; the tests hand in a fake engine
// or the real one. The text crosses in memory only: nothing here stores or logs it.
import type { PluginBridgeApi } from 'orca'
import type { EngineCompletion, EngineDefinition, EngineHover, EngineProblems, EngineQuery, EngineReferences, EngineSignature } from '../../engine/protocol'
import type { EditorOpenInput, EditorOpenResult } from '../protocol'

/** A query without the offset: what `engine.problems` reads. */
export type EngineText = Omit<EngineQuery, 'offset'>

export type EngineRequests = {
  complete(query: EngineQuery): Promise<EngineCompletion>
  /** With `id`, a completion item's description instead of what is at the offset. */
  hover(query: EngineQuery & { id?: string }): Promise<EngineHover>
  definition(query: EngineQuery): Promise<EngineDefinition>
  references(query: EngineQuery): Promise<EngineReferences>
  signature(query: EngineQuery): Promise<EngineSignature>
  problems(query: EngineText): Promise<EngineProblems>
  /** Opens a file of the workspace at a line, in this editor. */
  open(input: EditorOpenInput): Promise<EditorOpenResult>
}

/**
 * How long each request may take before the frame gives up on it. A hover waits for a `dw.*`
 * description (the worker waits up to 2.5 s for it); references read the whole checkout's index.
 */
export const REQUEST_TIMEOUT_MS = { complete: 5_000, hover: 8_000, definition: 5_000, references: 15_000, signature: 5_000, problems: 10_000, open: 30_000 } as const

/** The requests through the frame's bridge to the plugin's worker. */
export function frameRequests(plugin: PluginBridgeApi): EngineRequests {
  return {
    complete: (query) => plugin.request('engine.complete', query, { timeoutMs: REQUEST_TIMEOUT_MS.complete }),
    hover: (query) => plugin.request('engine.hover', query, { timeoutMs: REQUEST_TIMEOUT_MS.hover }),
    definition: (query) => plugin.request('engine.definition', query, { timeoutMs: REQUEST_TIMEOUT_MS.definition }),
    references: (query) => plugin.request('engine.references', query, { timeoutMs: REQUEST_TIMEOUT_MS.references }),
    signature: (query) => plugin.request('engine.signature', query, { timeoutMs: REQUEST_TIMEOUT_MS.signature }),
    problems: (query) => plugin.request('engine.problems', query, { timeoutMs: REQUEST_TIMEOUT_MS.problems }),
    open: (input) => plugin.request('editor.open', input, { timeoutMs: REQUEST_TIMEOUT_MS.open })
  }
}
