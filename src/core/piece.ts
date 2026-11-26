// What a piece is, on each side. A piece is one folder of src/pieces/; its worker half is listed
// in src/worker/pieces.ts and its panel half in src/panel/sections.ts. Types only: the panel and
// the worker both load this file.
//
// `plugin validate` follows type imports too, so this file imports no module that calls a
// worker-only host method: the workspace types live here and src/core/workspaces.ts uses them.
import type { IconName, OrcaNode } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import type { B2c } from './b2c'
import type { Settings } from './settings'
import type { Store } from './store'
import type { Translator } from './i18n'

export type Workspace = { id: string; name: string; path: string; branch: string | null; kind: 'worktree' | 'folder' }

export type Workspaces = {
  list(): Promise<Workspace[]>
  /** The focused workspace, or null. Only for showing state, never for deciding what uploads. */
  focused(): Promise<Workspace | null>
  uploading(): Promise<Workspace | null>
  setUploading(workspaceId: string | null): Promise<void>
  /**
   * Where to look for dw.json: the uploading workspace, else the focused one (so the panel can
   * show which environments are configured before anything uploads), else null.
   */
  configRoot(): Promise<string | null>
}

/** Every piece, in the order the panel shows them. Each one has a folder in src/pieces/. */
export const PIECE_IDS = ['isml', 'sandbox', 'errors', 'debugger', 'engine', 'editor'] as const
export type PieceId = (typeof PIECE_IDS)[number]

export type Disposable = { dispose(): void }

export type Logger = (message: string) => void

/**
 * What a piece's worker half receives. `store` is the piece's own namespace of the plugin's
 * storage; `t` words notifications in the language the panel last reported.
 */
export type PieceContext = {
  readonly orca: OrcaWorkerApi
  readonly b2c: B2c
  readonly settings: Settings
  readonly store: Store
  readonly workspaces: Workspaces
  readonly t: Translator
  readonly log: Logger
}

export type WorkerPiece = {
  readonly id: PieceId
  activate(ctx: PieceContext): Disposable | void | Promise<Disposable | void>
}

/** A section of the panel. `render` returns null while the piece has nothing to show. */
export type PanelSection = {
  readonly id: PieceId
  /** Words the section's title in a locale. */
  title(locale: string): string
  readonly icon: IconName
  render(locale: string): OrcaNode
}
