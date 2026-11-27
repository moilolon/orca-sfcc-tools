// The workspace list, the workspace that uploads with its code version, and the workspace the
// plugin works on. The uploading workspace is picked by hand in the sandbox piece and stored; it
// never follows the focused workspace. Other pieces read it with `uploading()` or `upload()`.
//
// The workspace worked on (`active()`, whose folder `configRoot()` names) is the uploading one;
// else the focused one when it has a configuration file; else the last local workspace that had
// one, kept by id in core's storage (a worker restart keeps it), let go once it is removed or no
// longer on this machine, and replaced as soon as another one with a file is focused or the
// uploading one is released; else the focused one. Moving to a project that is not an SFCC one
// keeps the environments, the errors and the engine's index on the last SFCC one.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ActiveReason, ActiveWorkspace, Workspace, Workspaces } from './piece'
import type { Store } from './store'

export type { ActiveReason, ActiveWorkspace, Workspace, Workspaces }

const UPLOADING_KEY = 'uploading'
/** The code version the uploading workspace uploads to, set with it by the sandbox piece. */
const UPLOADING_VERSION_KEY = 'uploadingVersion'
/** The id of the last local workspace focused (or released) with a configuration file. */
export const KEPT_KEY = 'keptWorkspace'

/** Whether the workspace's folder is on this machine, so its `path` can be read here. */
export function isLocal(workspace: Pick<Workspace, 'hostId'>): boolean {
  return workspace.hostId === null || workspace.hostId === 'local'
}

/** A workspace as `listWorkspaces` gives it: with the id of its project, when Orca names one. */
export type ListedWorkspace = Workspace & { projectId: string | null }

/**
 * Every workspace Orca lists, and whether the list is whole. A list Orca cut short
 * (`truncated`) says nothing about a workspace missing from it: never read that as removed.
 * `signal` cancels the call (a caller passes `AbortSignal.timeout(…)` so a host that does not
 * answer never holds it).
 */
export async function listWorkspaces(host: OrcaWorkerApi['host'], options: { signal?: AbortSignal } = {}): Promise<{ workspaces: ListedWorkspace[]; complete: boolean }> {
  const answer = await host.call('workspace.list', undefined, options)
  return {
    workspaces: answer.workspaces.map(({ id, name, path, branch, kind, hostId, projectId }) => ({ id, name, path, branch, kind, hostId: hostId ?? null, projectId: projectId ?? null })),
    complete: answer.truncated !== true
  }
}

/**
 * The ids of the projects hidden from Orca's sidebar, whose workspaces `workspace.list` may leave
 * out even when it is not truncated. Null when this Orca cannot say (no `project.list`, a list
 * cut short, or a failure): then no project can be taken as fully listed.
 */
export async function hiddenProjects(host: OrcaWorkerApi['host'], options: { signal?: AbortSignal } = {}): Promise<string[] | null> {
  if (!host.has('project.list')) return null
  try {
    const answer = await host.call('project.list', undefined, options)
    if (answer.truncated) return null
    return answer.projects.filter((project) => project.hidden === true).map((project) => project.id)
  } catch {
    return null
  }
}

/**
 * The workspace the plugin works on, by `active()` when the workspaces have it, else by the rule
 * it replaced (the uploading one, else the focused one): the one place a piece asks.
 */
export async function activeWorkspace(workspaces: Workspaces): Promise<ActiveWorkspace | null> {
  if (workspaces.active) return workspaces.active()
  const uploading = await workspaces.uploading()
  if (uploading) return { workspace: uploading, reason: 'uploading' }
  const focused = await workspaces.focused()
  return focused ? { workspace: focused, reason: 'focused' } : null
}

/** How long whether a folder has a configuration file is waited for: a folder that does not answer has none. */
export const HAS_CONFIG_BOUND_MS = 3_000

export type WorkspacesOptions = {
  /**
   * Whether a local folder has a configuration file, without reading it (`b2c.hasConfig`). Left
   * out, every local folder counts as having one, so the focused workspace always wins.
   */
  hasConfig?: (root: string) => Promise<boolean>
}

export function createWorkspaces(host: OrcaWorkerApi['host'], store: Store, options: WorkspacesOptions = {}): Workspaces {
  const strip = ({ projectId: _project, ...workspace }: ListedWorkspace): Workspace => workspace
  async function list(): Promise<Workspace[]> {
    return (await listWorkspaces(host)).workspaces.map(strip)
  }
  async function byId(id: string | null | undefined): Promise<Workspace | null> {
    if (!id) return null
    return (await list()).find((workspace) => workspace.id === id) ?? null
  }
  async function focusedId(): Promise<string | null> {
    const context = await host.call('workspace.readContext')
    return typeof context?.workspaceId === 'string' ? context.workspaceId : null
  }
  async function focused(): Promise<Workspace | null> {
    return byId(await focusedId())
  }
  async function uploading(): Promise<Workspace | null> {
    return byId(await store.get<string | null>(UPLOADING_KEY, null))
  }
  /** Whether a workspace is on this machine and has a configuration file; a folder that does not answer has none. */
  async function hasConfig(workspace: Workspace): Promise<boolean> {
    if (!isLocal(workspace)) return false
    if (!options.hasConfig) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        options.hasConfig(workspace.path).catch(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), HAS_CONFIG_BOUND_MS)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function keep(workspaceId: string): Promise<void> {
    if ((await store.get<string | null>(KEPT_KEY, null)) !== workspaceId) await store.set(KEPT_KEY, workspaceId)
  }
  async function active(): Promise<ActiveWorkspace | null> {
    const uploadId = await store.get<string | null>(UPLOADING_KEY, null)
    const focusId = uploadId ? null : await focusedId()
    const keptId = await store.get<string | null>(KEPT_KEY, null)
    // Nothing uploads, is focused or is kept: no workspace, and nothing to ask Orca.
    if (!uploadId && !focusId && !keptId) return null
    const { workspaces: listed, complete } = await listWorkspaces(host)
    const find = (id: string | null | undefined) => {
      const found = id ? listed.find((workspace) => workspace.id === id) : undefined
      return found ? strip(found) : null
    }
    const upload = find(uploadId)
    if (upload) return { workspace: upload, reason: 'uploading' }
    const focus = find(uploadId ? await focusedId() : focusId)
    if (focus && (await hasConfig(focus))) {
      await keep(focus.id)
      return { workspace: focus, reason: 'focused' }
    }
    if (keptId) {
      const kept = find(keptId)
      if (kept && isLocal(kept)) return { workspace: kept, reason: kept.id === focus?.id ? 'focused' : 'kept' }
      // Removed (only a whole list can say so) or no longer on this machine: let go.
      if (kept || complete) await store.delete(KEPT_KEY)
    }
    return focus ? { workspace: focus, reason: 'focused' } : null
  }
  return {
    list,
    focused,
    uploading,
    active,
    async upload() {
      const workspace = await uploading()
      const codeVersion = await store.get<string | null>(UPLOADING_VERSION_KEY, null)
      return workspace && typeof codeVersion === 'string' && codeVersion ? { workspace, codeVersion } : null
    },
    async setUploading(workspaceId, codeVersion = null) {
      // The workspace released stays the one worked on while the focus is on one with no file: it
      // uploaded, so it had one. Read from storage alone, so a release never waits on the host;
      // `active()` checks it is still listed and local before it is used.
      const released = workspaceId === null ? await store.get<string | null>(UPLOADING_KEY, null) : null
      if (typeof released === 'string' && released) await keep(released)
      if (workspaceId === null) await store.delete(UPLOADING_KEY)
      else await store.set(UPLOADING_KEY, workspaceId)
      if (workspaceId === null || !codeVersion) await store.delete(UPLOADING_VERSION_KEY)
      else await store.set(UPLOADING_VERSION_KEY, codeVersion)
    },
    async configRoot() {
      const workspace = (await active())?.workspace
      return workspace && isLocal(workspace) ? workspace.path : null
    }
  }
}
