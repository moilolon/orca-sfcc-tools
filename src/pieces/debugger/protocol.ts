// The debugger piece's requests (named `debugger.*`) and panel events; src/protocol.ts imports this
// file. Types only, so the panel loads it too. Nothing here ever holds a host, a credential or an
// absolute path: every text that came from b2c is masked before the worker sends it, and paths are
// relative to the workspace.
import type { RoleState } from '../../core/instances'

export type SessionStatus = 'idle' | 'connecting' | 'attached' | 'halted' | 'ended' | 'failed'

/** A frame of a call stack: its function, its file's name and line, its path in the workspace (null outside it). */
export type Frame = { id: number; name: string; file: string; line: number; path: string | null }
/** A script thread of the instance; `halted` when it waits on the debugger. */
export type Thread = { id: number; name: string; halted: boolean }
/** A scope (no value) or a variable; a `reference` above 0 has children, fetched on demand. */
export type Variable = { name: string; value: string; reference: number; expensive: boolean }
export type VerifiedLine = { line: number; verified: boolean }
export type StepKind = 'continue' | 'over' | 'in' | 'out'

/** One file's breakpoints; `verified` is null while no session has sent them. */
export type BreakpointView = { path: string; lines: { line: number; verified: boolean | null }[] }

/**
 * Which workspace is debugged: `ok`, `none` (no workspace to debug) or `remote` (on another host,
 * whose folder is not one of this machine).
 */
export type DebugWorkspaceState = 'ok' | 'none' | 'remote'

export type DebuggerState = {
  status: SessionStatus
  /**
   * Why the session failed or ended, as a code the panel words: one of the runner's codes
   * (`credentials_missing`, `b2c_not_found`, …), `launch_failed`, `adapter_exited`, `timeout`,
   * `terminated`, `start_failed`. Null otherwise.
   */
  reason: string | null
  /** The adapter's own words for it, masked, cut to a reasonable length. */
  message: string | null
  /** The sandbox role as dw.json has it: only `ready` can start. */
  sandbox: RoleState
  workspace: DebugWorkspaceState
  breakpoints: BreakpointView[]
  threads: Thread[]
  threadId: number | null
  frames: Frame[]
}

/** Matching files of the debugged workspace's cartridges, relative to it, for a new breakpoint. */
export type DebuggerFiles = { files: string[]; truncated: boolean }

declare module 'orca' {
  interface PluginRequests {
    /** The state as it is now. */
    'debugger.state': { input: Record<string, never>; output: DebuggerState }
    /** Starts a session on the sandbox; answers at once with `connecting`, then `debugger.state` events follow. */
    'debugger.start': { input: Record<string, never>; output: DebuggerState }
    /** Disconnects and ends the session; answers once it ended. */
    'debugger.stop': { input: Record<string, never>; output: DebuggerState }
    /** Every line of one file (relative to the workspace); an empty list removes the file. */
    'debugger.setBreakpoints': { input: { path: string; lines: number[] }; output: DebuggerState }
    /** Removes every breakpoint of the workspace. */
    'debugger.clearBreakpoints': { input: Record<string, never>; output: DebuggerState }
    /** Script files of the workspace's cartridges whose path holds every word of `query`. */
    'debugger.files': { input: { query: string }; output: DebuggerFiles }
    'debugger.threads': { input: Record<string, never>; output: Thread[] }
    /** The call stack of a thread, which becomes the one shown. */
    'debugger.stack': { input: { threadId: number }; output: Frame[] }
    /** A frame's scopes, or the children of a scope or variable; never stored. */
    'debugger.variables': { input: { frameId?: number; reference?: number }; output: Variable[] }
    /** An expression evaluated in a frame of the halted thread; never stored. */
    'debugger.evaluate': { input: { expression: string; frameId?: number }; output: { result: string; reference: number } }
    /** Continue, step over, in or out; the thread shown when `threadId` is left out. */
    'debugger.step': { input: { kind: StepKind; threadId?: number }; output: DebuggerState }
    /** Opens a frame's file, or a file of the workspace, in Orca's editor. */
    'debugger.open': { input: { frameId?: number; path?: string; line?: number }; output: { opened: boolean } }
  }
  interface PluginPanelEvents {
    /** The state changed; changes are coalesced, so a burst arrives as one. */
    'debugger.state': DebuggerState
  }
}
