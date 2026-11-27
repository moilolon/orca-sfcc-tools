// The engine piece's requests (named `engine.*`) and panel events; src/protocol.ts imports this
// file. The state of the checkout index (phase 6.3), and the queries (phase 6.4) the editor of
// phase 7 asks: completion, hover, definition, references and signature help, each on a file's
// text and an offset; and the problems (phase 6.5): of a file's text for the editor, and of the
// whole checkout for the Problems view, with the event a pass posts. Nothing here carries a host
// or a value of dw.json; paths are relative to the workspace, positions are offsets of the text
// given, and the names in a problem are masked.
import type { IndexStatus } from './checkout/checkout'
import type { Completion } from './query/complete'
import type { Definition } from './query/definition'
import type { Hover } from './query/hover'
import type { Problem, ProblemCounts } from './problems/problem'
import type { SeverityFilter } from './problems/list'
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
 * `building`: the first build is running, or the one after the workspace's folder came back;
 * `ready`: built, kept current as files change; `failed`: the build stopped, or the folder is gone
 * (`error` says why, as a code: `index_failed`, `folder_missing`).
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

// ---------------------------------------------------------------------------------------------
// Problems (phase 6.5)

export type { Problem, ProblemArgs, ProblemCode, ProblemCounts, Severity } from './problems/problem'
export type { SeverityFilter } from './problems/list'

/**
 * `none`: no workspace analysed (as the index); `indexing`: the index is being built, nothing is
 * analysed yet; `analysing`: the first pass over the checkout runs; `ready`: analysed, kept
 * current as files change; `failed`: the index or the pass failed (`error` says why).
 */
export type ProblemsState = 'none' | 'indexing' | 'analysing' | 'ready' | 'failed'

/** What the view lists of a file: its path in the workspace (masked), its counts, and its first problems. */
export type ProblemFile = {
  path: string
  counts: ProblemCounts
  /** The problems drawn, in the order of the file, at most `FILE_PROBLEMS_SHOWN` in the list. */
  problems: Problem[]
  /** How many of its problems that match are not in `problems`. */
  more: number
}

/** The checkout's problems as the view lists them: counts of all, and a page of the files that match. */
export type ProblemsList = {
  workspaceId: string | null
  state: ProblemsState
  error: string | null
  /** A later pass is running: what is listed may change. */
  busy: boolean
  /** Every problem, whatever the filter. */
  counts: ProblemCounts
  files: number
  /**
   * What matches the filter and the search, and how many of those the list can draw (at most
   * `FILE_PROBLEMS_SHOWN` per file: the rest are in each file's detail).
   */
  matching: { problems: number; files: number; listable: number }
  /** The files that match, in path order, until `limit` problems are listed. */
  page: ProblemFile[]
  /** When the last pass ended, and how long it took; null before the first. */
  analysedAt: number | null
  analysisMs: number | null
  /** Raised by each pass, so the view keeps only the newest of two answers that cross. */
  version: number
}

export type ProblemsQuery = { severity?: SeverityFilter; search?: string; limit?: number }

/** One file's problems that match, for its detail. */
export type ProblemsOfFile = { path: string; problems: Problem[]; total: number; version: number }

/** The editor's query (phase 7): one file's text, analysed now with the index of its workspace. */
export type EngineProblems = EngineAnswerState & { problems: Problem[] }

export type OpenProblemResult = { opened: boolean; reason?: string }

/** What the worker posts after a pass that changed the counts. */
export type ProblemsChanged = { workspaceId: string | null; counts: ProblemCounts; files: number; version: number }

declare module 'orca' {
  interface PluginRequests {
    /** The problems of a file's text, now (the editor's warnings): every problem, worded by the caller. */
    'engine.problems': { input: Omit<EngineQuery, 'offset'> & { offset?: number }; output: EngineProblems }
    /**
     * The checkout's problems for the view: counts, and the files that match a severity and a
     * search (in a file's path or a problem's names), until `limit` problems (at most 100) are listed.
     * Answers at once with what the last pass found.
     */
    'engine.problems.list': { input: ProblemsQuery; output: ProblemsList }
    /** One file's problems that match, at most `limit` (at most 100). */
    'engine.problems.file': { input: ProblemsQuery & { path: string }; output: ProblemsOfFile }
    /** Opens a file of the analysed workspace at a line, bringing the person to it. */
    'engine.problems.open': { input: { path: string; line: number; column?: number }; output: OpenProblemResult }
    /** Analyses the whole checkout again (the view's retry after a failure). */
    'engine.problems.refresh': { input: Record<string, never>; output: ProblemsList }
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
  interface PluginPanelEvents {
    /** A pass over the checkout ended and its counts changed: the view asks for its list again. */
    'engine.problems.changed': ProblemsChanged
  }
}
