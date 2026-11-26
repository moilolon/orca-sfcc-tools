// The sandbox piece's check scenarios: each state of its view worth a look, drawn by
// `orca plugin check` and captured with `orca plugin shot . --scenario <name>`. src/panel/checks.ts
// merges them; every name starts with `sandbox`. Each stubs `sandbox.status` with an invented
// state: workspace names and code versions only, never a host.
import type { PieceScenarios } from '../../panel/scenarios'
import type { SandboxStatus } from './protocol'

const MINUTE = 60_000
/** Fixed when the module loads: the view shows times relative to now. */
const NOW = Date.now()

const WORKSPACES: SandboxStatus['workspaces'] = [
  { id: 'w-main', name: 'storefront', local: true, codeVersion: null, owner: false },
  { id: 'w-checkout', name: 'checkout-fix', local: true, codeVersion: null, owner: false },
  { id: 'w-search', name: 'search-filters', local: true, codeVersion: 'ws-search-filters', owner: false },
  { id: 'w-remote', name: 'storefront on build-01', local: false, codeVersion: null, owner: false }
]

/** Nobody uploads; the sandbox is started. */
export const IDLE: SandboxStatus = {
  role: 'ready',
  config: 'ok',
  sandbox: { state: 'started', following: null, reason: null, checkedAt: NOW - 2 * MINUTE },
  upload: {
    state: 'none',
    workspaceId: null,
    workspaceName: null,
    codeVersion: null,
    reason: null,
    lastDeployAt: null,
    deployed: false,
    restored: false,
    lastUploadAt: null,
    files: 0,
    reloading: false
  },
  workspaces: WORKSPACES,
  pendingDeletes: 0,
  leftovers: [],
  problem: null
}

/** `checkout-fix` owns the upload, in `state`. */
function owned(state: SandboxStatus['upload']['state'], extra: Partial<SandboxStatus['upload']> = {}): SandboxStatus {
  return {
    ...IDLE,
    upload: {
      ...IDLE.upload,
      state,
      workspaceId: 'w-checkout',
      workspaceName: 'checkout-fix',
      codeVersion: 'ws-checkout-fix',
      lastDeployAt: state === 'deploying' ? null : NOW - 25 * MINUTE,
      deployed: state === 'watching' || state === 'uploading',
      ...extra
    },
    workspaces: WORKSPACES.map((workspace) => (workspace.id === 'w-checkout' ? { ...workspace, owner: true, codeVersion: 'ws-checkout-fix' } : workspace))
  }
}

export const DEPLOYING = owned('deploying')
export const WATCHING = owned('watching', { lastUploadAt: NOW - 3 * MINUTE, files: 7 })
export const UPLOADING = owned('uploading', { lastUploadAt: NOW - 1 * MINUTE, files: 7 })
export const FAILED = owned('failed', { reason: 'b2c_failed' })

const status = (value: SandboxStatus) => ({ requests: { 'sandbox.status': () => value } })

export const scenarios: PieceScenarios = {
  /** Nobody uploads: the empty upload group and the list of workspaces to pick from. */
  sandbox: status(IDLE),
  /** A workspace was picked: its whole deploy is running. */
  sandboxDeploying: status(DEPLOYING),
  /** Deployed and watching for changes, seven files sent so far. */
  sandboxWatching: status(WATCHING),
  /** A saved change is on its way. */
  sandboxUploading: status(UPLOADING),
  /** The deploy failed: why, and the way to try again. */
  sandboxFailed: status(FAILED),
  /** The sandbox is stopped: the start button. */
  sandboxStopped: status({ ...WATCHING, sandbox: { ...WATCHING.sandbox, state: 'stopped' } }),
  /** A start was fired and is followed on the list. */
  sandboxStarting: status({ ...WATCHING, sandbox: { ...WATCHING.sandbox, state: 'busy', following: 'start' } }),
  /** The sandbox list was refused: the state is unknown and the rest still works. */
  sandboxUnknown: status({
    ...WATCHING,
    sandbox: { state: 'unknown', following: null, reason: 'b2c_failed', checkedAt: null },
    problem: { action: 'status', code: 'b2c_failed' }
  }),
  /** The sandbox role is incomplete in dw.json: nothing runs, and the view says why. */
  sandboxNotReady: status({ ...IDLE, role: 'incomplete', sandbox: { state: 'unknown', following: null, reason: 'sandbox_not_ready', checkedAt: null } }),
  /** A removed workspace's version waits until another one is active; its last delete failed. */
  sandboxPendingDelete: status({ ...WATCHING, pendingDeletes: 1, problem: { action: 'delete', code: 'b2c_failed' } }),
  /** No workspace is listed. */
  sandboxNoWorkspaces: status({ ...IDLE, workspaces: [] }),
  /** Watching again after a restart, with no deploy since: the hint that changes meanwhile wait. */
  sandboxRestored: status({ ...WATCHING, upload: { ...WATCHING.upload, restored: true, files: 0, lastUploadAt: null } }),
  /** A restart cut the last deploy short: the version is not watched or reloaded until deployed. */
  sandboxDeployNeeded: status(owned('failed', { reason: 'deploy_needed', deployed: false })),
  /** The uploading workspace is not in Orca's list any more: kept until released or removed. */
  sandboxNotFound: status({
    ...owned('failed', { reason: 'workspace_not_found', deployed: true }),
    workspaces: WORKSPACES.filter((workspace) => workspace.id !== 'w-checkout')
  }),
  /** A version of a workspace removed while the plugin was not running, to delete by hand. */
  sandboxLeftovers: status({ ...WATCHING, leftovers: [{ workspaceId: 'w-old', codeVersion: 'ws-old-promo' }] })
}
