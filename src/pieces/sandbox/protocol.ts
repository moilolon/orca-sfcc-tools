// The sandbox piece's requests (named `sandbox.*`) and panel events. src/protocol.ts imports this
// file. Types only: the panel and the worker both load it. Nothing here ever holds a host, a path
// or a value of dw.json: workspaces travel by id and name, the sandbox by its state.
import type { ConfigState, RoleState } from '../../core/instances'

/** The sandbox as `sandbox list` shows it, in four words. */
export type SandboxState = 'started' | 'stopped' | 'busy' | 'unknown'

/**
 * The upload: nobody uploads (`none`); the whole workspace is being deployed (`deploying`);
 * `code watch` is waiting for changes (`watching`) or sending one (`uploading`); or the deploy or
 * the watcher failed (`failed`).
 */
export type UploadState = 'none' | 'deploying' | 'watching' | 'uploading' | 'failed'

/** The side actions whose last failure the section shows. */
export type SandboxAction = 'status' | 'start' | 'stop' | 'reload' | 'delete' | 'upload'

export type SandboxWorkspace = {
  id: string
  name: string
  /** False for a workspace on another host: it is listed, never uploaded. */
  local: boolean
  /** The code version stored for it, once it has uploaded. */
  codeVersion: string | null
  owner: boolean
}

export type SandboxStatus = {
  /** What dw.json holds for the sandbox role; only `ready` runs anything. */
  role: RoleState
  config: ConfigState
  sandbox: {
    state: SandboxState
    /** A start or stop fired and followed on the list until it settles. */
    following: 'start' | 'stop' | null
    /** Why the state is unknown: an error code, or `sandbox_not_listed`. */
    reason: string | null
    /** When the list was last read, in ms since the epoch. */
    checkedAt: number | null
  }
  upload: {
    state: UploadState
    workspaceId: string | null
    workspaceName: string | null
    codeVersion: string | null
    /** Why the upload failed: an error code. */
    reason: string | null
    /** When the last full deploy ended well. */
    lastDeployAt: number | null
    /** When `code watch` last sent files, and how many since it started. */
    lastUploadAt: number | null
    files: number
    reloading: boolean
  }
  workspaces: SandboxWorkspace[]
  /** Code versions of removed workspaces still to be deleted, once none of them is active. */
  pendingDeletes: number
  /** The last side action that failed, with its error code; cleared when it next works. */
  problem: { action: SandboxAction; code: string } | null
}

declare module 'orca' {
  interface PluginRequests {
    /** The state as the worker holds it: no b2c call. */
    'sandbox.status': { input: Record<string, never> | undefined; output: SandboxStatus }
    /** Reads the sandbox list again. */
    'sandbox.refresh': { input: Record<string, never> | undefined; output: SandboxStatus }
    /** Makes the workspace the one that uploads: deploy, activate, then watch. */
    'sandbox.pick': { input: { workspaceId: string }; output: SandboxStatus }
    /** Stops uploading; the code version stays active. */
    'sandbox.release': { input: Record<string, never> | undefined; output: SandboxStatus }
    /** Deploys the uploading workspace again, whole, and activates it. */
    'sandbox.deploy': { input: Record<string, never> | undefined; output: SandboxStatus }
    /** Reloads the active code version (`code activate --reload`). */
    'sandbox.reload': { input: Record<string, never> | undefined; output: SandboxStatus }
    'sandbox.start': { input: Record<string, never> | undefined; output: SandboxStatus }
    'sandbox.stop': { input: Record<string, never> | undefined; output: SandboxStatus }
  }
  interface PluginPanelEvents {
    /** The state changed: the whole of it. */
    'sandbox.changed': SandboxStatus
  }
}
