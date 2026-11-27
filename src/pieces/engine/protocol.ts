// The engine piece's requests (named `engine.*`) and panel events; src/protocol.ts imports this
// file. The state of the checkout index (phase 6.3), and the queries (phase 6.4) the editor of
// phase 7 asks: completion, hover, definition, references and signature help, each on a file's
// text and an offset. Nothing here carries a host or a value of dw.json; paths are relative to
// the workspace, positions are offsets of the text given.
import type { IndexStatus } from './checkout/checkout'
import type { Completion } from './query/complete'
import type { Definition } from './query/definition'
import type { Hover } from './query/hover'
import type { References } from './query/references'
import type { SignatureHelp } from './query/signature'

export type { IndexStatus }
export type { Completion, CompletionContext, CompletionItem, CompletionKind } from './query/complete'
export type { Definition, DefinitionKind, Target } from './query/definition'
export type { ReferenceEntry, References } from './query/references'
export type { Signature, SignatureHelp, SignatureParameter } from './query/signature'
export type { CartridgeRouteEntry, Describe, DwMemberEntry, Hover, HoverContent, MemberDefinitionEntry, ResourceEntry, RouteEntry, RouteStepEntry } from './query/hover'

/**
 * `none`: no workspace to index (none uploads, none is focused, or it is on another host);
 * `building`: the first build is running; `ready`: built, kept current as files change;
 * `failed`: the build stopped (`error` says why, as a code).
 */
export type EngineIndexState = 'none' | 'building' | 'ready' | 'failed'

export type EngineIndexStatus = {
  /** The workspace indexed: the uploading one, else the focused one. Null with `none`. */
  workspaceId: string | null
  state: EngineIndexState
  error: string | null
  /** Whether a watcher keeps the index current; false when the folder cannot be watched. */
  watching: boolean
  /** The index as last built or updated; null until the first build ends. */
  index: IndexStatus | null
}

/**
 * A query on a file: the workspace it belongs to, its path relative to the workspace (`/`
 * between parts), the editor's text (which may be newer than the file on disk), and an offset of
 * that text (UTF-16).
 */
export type EngineQuery = { workspaceId: string; path: string; text: string; offset: number }

/** Why a query answered nothing: what it was given is not one it reads. */
export type EngineQueryError = 'file_invalid' | 'offset_invalid' | 'text_too_large'

/**
 * What every query answer says besides its result: the state of the index it was answered from
 * (`none` when the workspace is not the one indexed: then only what needs no checkout answers,
 * ISML tags and `dw.*` members), and why it answered nothing, when it could not read the query.
 */
export type EngineAnswerState = { index: EngineIndexState; error: EngineQueryError | null }

export type EngineCompletion = EngineAnswerState & { completion: Completion }

/** A hover, with the description of a `dw.*` class or member read at run time (masked; null when none was read). */
export type EngineHoverResult = Hover & {
  description: string | null
  /** Why the description could not be read (`b2c_not_found`, `wrong_page`, `timeout`, …); null when read or not wanted. */
  descriptionError: string | null
}

export type EngineHover = EngineAnswerState & { hover: EngineHoverResult | null }

export type EngineDefinition = EngineAnswerState & { definition: Definition | null }
export type EngineReferences = EngineAnswerState & { references: References | null }
export type EngineSignature = EngineAnswerState & { signature: SignatureHelp | null }

declare module 'orca' {
  interface PluginRequests {
    /**
     * The checkout index of the uploading workspace (else the focused one): its cartridges, each
     * storefront's cartridge path with its source, its counts, when it was built and updated.
     * Answers at once with what is there: a build runs on its own, never inside the request.
     */
    'engine.index.status': { input: Record<string, never>; output: EngineIndexStatus }
    /** What to offer at the offset: at most 200 items, with the range they replace. */
    'engine.complete': { input: EngineQuery; output: EngineCompletion }
    /**
     * What is at the offset; with `id`, the completion item of that id instead (its range is
     * null). The description of a `dw.*` class or member is read through `b2c docs read`, waited
     * for a short while, and kept in memory only.
     */
    'engine.hover': { input: EngineQuery & { id?: string }; output: EngineHover }
    /** Where the thing at the offset is defined: one place per copy, each with the storefronts it serves. */
    'engine.definition': { input: EngineQuery; output: EngineDefinition }
    /** The references of the exported function at the offset, across every storefront's path (at most 500). */
    'engine.references': { input: EngineQuery; output: EngineReferences }
    /** The signatures of the call around the offset, and the parameter the offset is at. */
    'engine.signature': { input: EngineQuery; output: EngineSignature }
  }
  interface PluginPanelEvents {}
}
