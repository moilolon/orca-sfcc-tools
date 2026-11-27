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
  /** Its Git branch, when Orca knows one. */
  branch: string | null
  /** False for a workspace on another host: it is listed, never uploaded. */
  local: boolean
  /**
   * Whether it belongs to the project whose dw.json is in use: the uploading workspace's project,
   * else the focused one's. True for every workspace when neither names a project.
   */
  inProject: boolean
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
    /** When the last full deploy of this workspace ended well. */
    lastDeployAt: number | null
    /** Whether its last full deploy ended well: only then is its version reloaded or watched. */
    deployed: boolean
    /** The watcher was started again after a restart, with no deploy since. */
    restored: boolean
    /** When `code watch` last sent files, and how many since it started. */
    lastUploadAt: number | null
    files: number
    reloading: boolean
  }
  workspaces: SandboxWorkspace[]
  /** Code versions of removed workspaces still to be deleted, once none of them is active. */
  pendingDeletes: number
  /**
   * Queued versions that cannot be deleted: the dw.json of their workspace is gone (or no longer
   * has a ready sandbox role), and no other file is used. A person may forget one
   * (`sandbox.dropDelete`); it may stay on its sandbox.
   */
  stuckDeletes: string[]
  /**
   * Stored versions of workspaces a complete list no longer holds (removed while the plugin was
   * not listening): a person may delete them. Empty when the list is not whole. `checkable` is
   * false for one whose project is hidden from the sidebar (or may be): the list may leave its
   * workspace out, so it is shown but cannot be deleted from here.
   */
  leftovers: { workspaceId: string; codeVersion: string; checkable: boolean }[]
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
    /** Deletes, by hand, the version of a workspace that is no longer listed (`leftovers`). */
    'sandbox.forget': { input: { workspaceId: string }; output: SandboxStatus }
    /** Forgets a queued version that cannot be deleted (`stuckDeletes`), without deleting it. */
    'sandbox.dropDelete': { input: { codeVersion: string }; output: SandboxStatus }
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
