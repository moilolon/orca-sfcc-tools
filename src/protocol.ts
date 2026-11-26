// The panel <-> worker contract, declared once: src/panel/panel.tsx and src/worker/worker.ts both
// read it. Core declares its own requests here; each piece declares its own in
// src/pieces/<piece>/protocol.ts, prefixed with the piece id (`sandbox.status`, `errors.list`).
import type { Role } from './core/instances'
import type { PieceId } from './core/piece'
import './pieces/sandbox/protocol'
import './pieces/errors/protocol'
import './pieces/debugger/protocol'
import './pieces/engine/protocol'
import './pieces/editor/protocol'

/** What the panel shows of the setup. Never a host, a path or a credential. */
export type CoreStatus = {
  /**
   * `found` once `b2c --version` printed a version. Otherwise `reason` says why, as a code the
   * panel words: `b2c_not_found`, `b2c_failed`, `b2c_timeout` or `no_version`.
   */
  b2c: { found: boolean; version: string | null; reason?: string }
  instances: Record<Role, boolean>
  pieces: PieceId[]
}

declare module 'orca' {
  interface PluginRequests {
    /**
     * The setup: whether b2c starts and its version, which roles dw.json configures, the pieces.
     * `locale` is the panel's language, kept so the worker words notifications the same way.
     */
    'core.status': { input: { locale?: string }; output: CoreStatus }
  }
  interface PluginPanelEvents {
    /** A setting changed: the panel asks for `core.status` again. */
    'core.changed': { key: string }
  }
}
