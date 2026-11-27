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
   * `terminated`, `start_failed`, `disconnect_unconfirmed` (the session ended but a disconnect got no
   * answer, so the next start cleans up first). Null otherwise.
   */
  reason: string | null
  /** The adapter's own words for it, masked, cut to a reasonable length. */
  message: string | null
  /** The sandbox role as dw.json has it: only `ready` can start. */
  sandbox: RoleState
  workspace: DebugWorkspaceState
  /** The id of the workspace debugged, when it is one of this machine; Orca's id, never a path. */
  workspaceId: string | null
  breakpoints: BreakpointView[]
  threads: Thread[]
  threadId: number | null
  frames: Frame[]
}

/**
 * A cartridge of the debugged workspace: its folder's name, its folder relative to the workspace
 * (`''` for the workspace itself) and its script files, relative to the workspace.
 */
export type ScriptCartridge = { name: string; path: string; files: string[] }

/** Every script of the debugged workspace's cartridges, by cartridge; `truncated` when some were left out. */
export type DebuggerScripts = { cartridges: ScriptCartridge[]; truncated: boolean }

/**
 * One script's lines, read when its source is opened in the view and never stored, cut to what a
 * view can draw (`truncated` then), and masked like anything else the panel shows.
 */
export type DebuggerSource = { path: string; lines: string[]; truncated: boolean }

/** One file of a workspace, as the plugin's editor names it (phase 7.3). */
export type DebuggerFileInput = { workspaceId: string; path: string }

/**
 * Where a thread is halted in one file: the topmost frame of the halted thread shown that is in
 * this file, its line in the file as saved, its function's name (masked), and whether it is the
 * frame the thread stopped in (`top`) or one that called it.
 */
export type StoppedLine = { line: number; name: string; frameId: number; top: boolean }

/**
 * What the editor shows of the debugger for one file: whether a breakpoint can go in it (a script
 * of a cartridge of its workspace, as files.ts decides), whether a session runs on its workspace,
 * its breakpoints from the store (lines of the file as saved; `verified` null while no session
 * has sent them), and where a thread is halted in it.
 */
export type DebuggerFileState = {
  scriptable: boolean
  /** `none` when no session runs on this file's workspace. */
  session: 'none' | 'connecting' | 'attached' | 'halted'
  lines: { line: number; verified: boolean | null }[]
  stopped: StoppedLine | null
}

/** A plain read evaluated for the editor's hover: the expression sent, its value, and whether it has members. */
export type DebuggerHoverValue = { expression: string; value: string; expandable: boolean }

declare module 'orca' {
  interface PluginRequests {
    /** The state as it is now. */
    'debugger.state': { input: Record<string, never>; output: DebuggerState }
    /** Starts a session on the sandbox; answers at once with `connecting`, then `debugger.state` events follow. */
    'debugger.start': { input: Record<string, never>; output: DebuggerState }
    /** Disconnects and ends the session; answers once it ended. */
    'debugger.stop': { input: Record<string, never>; output: DebuggerState }
    /** Every line of one file (relative to the workspace); an empty list removes the file. */
    'debugger.setBreakpoints': { input: { path: string; lines: number[]; workspaceId?: string }; output: DebuggerState }
    /**
     * Sets (`on`) or removes one line of one file, keeping the file's other lines: what pressing a
     * line of a script, a frame of the call stack or a frame of an error does. This and
     * `setBreakpoints` act on the debugged workspace, or on `workspaceId` when the editor names its
     * own: then only a script of its cartridges is taken (`not_script` otherwise). With `text`
     * (what the editor believes the line holds on disk), a line set is refused with `line_changed`
     * when the file on disk holds something else there (an editor that took another tab's unsaved
     * edits for the file).
     */
    'debugger.breakpoint': { input: { path: string; line: number; on: boolean; workspaceId?: string; text?: string }; output: DebuggerState }
    /** Removes every breakpoint of the workspace. */
    'debugger.clearBreakpoints': { input: Record<string, never>; output: DebuggerState }
    /** Every script of the workspace's cartridges, by cartridge, for the view's list of scripts. */
    'debugger.scripts': { input: Record<string, never>; output: DebuggerScripts }
    /** The lines of one script of the workspace's cartridges; only that file, only now. */
    'debugger.source': { input: { path: string }; output: DebuggerSource }
    'debugger.threads': { input: Record<string, never>; output: Thread[] }
    /** The call stack of a thread, which becomes the one shown. */
    'debugger.stack': { input: { threadId: number }; output: Frame[] }
    /** A frame's scopes, or the children of a scope or variable; never stored. */
    'debugger.variables': { input: { frameId?: number; reference?: number }; output: Variable[] }
    /** An expression evaluated in a frame of the halted thread; never stored. */
    'debugger.evaluate': { input: { expression: string; frameId?: number }; output: { result: string; reference: number } }
    /** Continue, step over, in or out; the thread shown when `threadId` is left out. */
    'debugger.step': { input: { kind: StepKind; threadId?: number }; output: DebuggerState }
    /**
     * The editor's view of one file: whether it takes breakpoints, its breakpoints and its halted
     * line. The editor asks again on every `debugger.state` post. A workspace that is not local is
     * answered as not scriptable, with no lines.
     */
    'debugger.file': { input: DebuggerFileInput; output: DebuggerFileState }
    /**
     * The value of a plain read (inspect.ts) in a frame of the halted thread that is in this file;
     * null for any other expression, or when that frame is no longer one of the halt. Masked, cut,
     * never stored.
     */
    'debugger.hover': { input: DebuggerFileInput & { expression: string; frameId: number }; output: DebuggerHoverValue | null }
    /** Opens a frame's file, or a file of the workspace, in Orca's editor. */
    'debugger.open': { input: { frameId?: number; path?: string; line?: number }; output: { opened: boolean } }
  }
  interface PluginPanelEvents {
    /** The state changed; changes are coalesced, so a burst arrives as one. */
    'debugger.state': DebuggerState
  }
}
