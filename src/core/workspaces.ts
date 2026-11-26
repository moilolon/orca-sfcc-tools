// The workspace list, and the workspace that uploads with its code version. The uploading
// workspace is picked by hand in the sandbox piece and stored; it never follows the focused
// workspace. Other pieces read it with `uploading()` or `upload()`. While nothing uploads,
// dw.json is read from the focused workspace, unless a hold keeps the folder an operation began
// with (`holdConfigRoot`).
import type { OrcaWorkerApi } from 'orca/worker'
import type { Workspace, Workspaces } from './piece'
import type { Store } from './store'

export type { Workspace, Workspaces }

const UPLOADING_KEY = 'uploading'
/** The code version the uploading workspace uploads to, set with it by the sandbox piece. */
const UPLOADING_VERSION_KEY = 'uploadingVersion'

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

/** The folder held for `configRoot()` while a hold is taken, and how many holds are. */
type ConfigHold = { count: number; root: string | null }

/** The hold of each object `createWorkspaces` made; another `Workspaces` (a test's) has none. */
const holds = new WeakMap<Workspaces, ConfigHold>()

/**
 * Keeps `configRoot()` on the folder it answers now while no workspace uploads, whatever the focus
 * does, until the returned function is called: an operation the sandbox piece follows (a start or
 * stop) keeps reading the dw.json it began with. A workspace picked to upload meanwhile still
 * wins, as it always does. Holds nest: the first one fixes the folder, the last release frees it.
 */
export async function holdConfigRoot(workspaces: Workspaces): Promise<() => void> {
  const hold = holds.get(workspaces)
  if (!hold) return () => {}
  const root = await workspaces.configRoot()
  if (hold.count === 0) hold.root = root
  hold.count++
  let released = false
  return () => {
    if (released) return
    released = true
    hold.count--
    if (hold.count === 0) hold.root = null
  }
}

export function createWorkspaces(host: OrcaWorkerApi['host'], store: Store): Workspaces {
  const hold: ConfigHold = { count: 0, root: null }
  async function list(): Promise<Workspace[]> {
    return (await listWorkspaces(host)).workspaces.map(({ projectId: _project, ...workspace }) => workspace)
  }
  async function byId(id: string | null | undefined): Promise<Workspace | null> {
    if (!id) return null
    return (await list()).find((workspace) => workspace.id === id) ?? null
  }
  async function focused(): Promise<Workspace | null> {
    const context = await host.call('workspace.readContext')
    return byId(context?.workspaceId)
  }
  async function uploading(): Promise<Workspace | null> {
    return byId(await store.get<string | null>(UPLOADING_KEY, null))
  }
  const workspaces: Workspaces = {
    list,
    focused,
    uploading,
    async upload() {
      const workspace = await uploading()
      const codeVersion = await store.get<string | null>(UPLOADING_VERSION_KEY, null)
      return workspace && typeof codeVersion === 'string' && codeVersion ? { workspace, codeVersion } : null
    },
    async setUploading(workspaceId, codeVersion = null) {
      if (workspaceId === null) await store.delete(UPLOADING_KEY)
      else await store.set(UPLOADING_KEY, workspaceId)
      if (workspaceId === null || !codeVersion) await store.delete(UPLOADING_VERSION_KEY)
      else await store.set(UPLOADING_VERSION_KEY, codeVersion)
    },
    async configRoot() {
      const owner = await uploading()
      if (!owner && hold.count > 0) return hold.root
      const workspace = owner ?? (await focused())
      return workspace && isLocal(workspace) ? workspace.path : null
    }
  }
  holds.set(workspaces, hold)
  return workspaces
}
