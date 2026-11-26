// What a piece is, on each side. A piece is one folder of src/pieces/; its worker half is listed
// in src/worker/pieces.ts and its panel half in src/panel/sections.ts. Types only: the panel and
// the worker both load this file.
//
// `plugin validate` follows type imports too, so this file imports no module that calls a
// worker-only host method: the workspace types live here and src/core/workspaces.ts uses them.
import type { IconName, OrcaNode, PanelContext } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import type { B2c } from './b2c'
import type { Settings } from './settings'
import type { Store } from './store'
import type { Translator } from './i18n'

/**
 * A workspace as Orca lists it. `hostId` says where its folder is: `local` (or null) on this
 * machine, `ssh:…` or `runtime:…` elsewhere, where `path` is a path on that host and must
 * never be read as a local one.
 */
export type Workspace = { id: string; name: string; path: string; branch: string | null; kind: 'worktree' | 'folder'; hostId: string | null }

export type Workspaces = {
  list(): Promise<Workspace[]>
  /** The focused workspace, or null. Only for showing state, never for deciding what uploads. */
  focused(): Promise<Workspace | null>
  /** The workspace picked by hand to upload to the sandbox (phase 2), or null. */
  uploading(): Promise<Workspace | null>
  /** The uploading workspace and the code version it uploads to; null while nothing uploads. */
  upload(): Promise<{ workspace: Workspace; codeVersion: string } | null>
  /**
   * Only the sandbox piece calls it, when a workspace is picked or released. `codeVersion` is the
   * version that workspace uploads to; null or left out, `upload()` answers null.
   */
  setUploading(workspaceId: string | null, codeVersion?: string | null): Promise<void>
  /**
   * Where to look for dw.json: the uploading workspace, else the focused one (so the panel can
   * show which environments are configured before anything uploads), else null. Null too when
   * that workspace is on another host: its path is not a folder of this machine.
   */
  configRoot(): Promise<string | null>
}

/** Every piece, in the order the panel shows them. Each one has a folder in src/pieces/. */
export const PIECE_IDS = ['isml', 'sandbox', 'errors', 'debugger', 'engine', 'editor'] as const
export type PieceId = (typeof PIECE_IDS)[number]

/**
 * Something to stop. `dispose` may return a promise: the worker's deactivation waits for it, within
 * a bound, so a piece can finish what must not be cut off (the debugger's disconnect).
 */
export type Disposable = { dispose(): void | Promise<void> }

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

/**
 * A piece's half of the panel. Everything the panel shows of a piece comes from here, so a phase
 * that delivers one edits only its own folder.
 */
export type PanelSection = {
  readonly id: PieceId
  /** Words the piece's name in a locale. */
  title(locale: string): string
  readonly icon: IconName
  /**
   * Whether the piece does its job yet. A piece not delivered is not shown in the panel at all;
   * a delivered one is listed in the setup view and, with `hasView`, gets a view of its own.
   */
  readonly delivered: boolean
  /**
   * Whether the piece has something to show in the panel: a view of its own in the panel's bar,
   * drawn by `render`. False for a piece that works elsewhere only (ISML colours the editor).
   */
  readonly hasView: boolean
  /**
   * Runs once when the panel opens, before the first draw: the place to listen to the piece's
   * own events (`plugin.on('sandbox.changed', …)`) and ask for its first state. What it pushes to
   * `ctx.subscriptions`, and the function it may return, are disposed with the panel.
   */
  setup?(ctx: PanelContext): void | (() => void)
  /**
   * The body of the piece's view, built from the blocks of src/panel/ui.tsx. Null until the piece
   * has its first answer: the panel draws a loading placeholder. With nothing to show, the piece
   * draws `Empty` with its own words. If it throws, the panel draws an error state with a retry in
   * its place. Never called when `hasView` is false or the piece is not delivered.
   */
  render(locale: string): OrcaNode
}
