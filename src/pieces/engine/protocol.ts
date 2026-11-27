// The engine piece's requests (named `engine.*`) and panel events; src/protocol.ts imports this
// file. So far one request: the state of the checkout index (phase 6.3). Nothing here carries a
// host or a value of dw.json; paths are relative to the workspace.
import type { IndexStatus } from './checkout/checkout'

export type { IndexStatus }

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

declare module 'orca' {
  interface PluginRequests {
    /**
     * The checkout index of the uploading workspace (else the focused one): its cartridges, each
     * storefront's cartridge path with its source, its counts, when it was built and updated.
     * Answers at once with what is there: a build runs on its own, never inside the request.
     */
    'engine.index.status': { input: Record<string, never>; output: EngineIndexStatus }
  }
  interface PluginPanelEvents {}
}
