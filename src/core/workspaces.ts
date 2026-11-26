// The workspace list, and the workspace that uploads. The uploading workspace is picked by hand
// (phase 2) and stored; it never follows the focused workspace.
import type { OrcaWorkerApi } from 'orca/worker'
import type { Workspace, Workspaces } from './piece'
import type { Store } from './store'

export type { Workspace, Workspaces }

const UPLOADING_KEY = 'uploading'

export function createWorkspaces(host: OrcaWorkerApi['host'], store: Store): Workspaces {
  async function list(): Promise<Workspace[]> {
    const answer = await host.call('workspace.list')
    return answer.workspaces.map(({ id, name, path, branch, kind }) => ({ id, name, path, branch, kind }))
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
  return {
    list,
    focused,
    uploading,
    async setUploading(workspaceId) {
      if (workspaceId === null) await store.delete(UPLOADING_KEY)
      else await store.set(UPLOADING_KEY, workspaceId)
    },
    async configRoot() {
      return ((await uploading()) ?? (await focused()))?.path ?? null
    }
  }
}
