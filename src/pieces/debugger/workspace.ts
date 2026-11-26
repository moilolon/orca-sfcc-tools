// Which workspace the debugger works on, and how it opens one of its files: each decided in one
// function, so a follow-up can change it in one place.
import type { OrcaWorkerApi } from 'orca/worker'
import type { Workspace, Workspaces } from '../../core/piece'
import { isLocal } from '../../core/workspaces'

/**
 * The workspace whose cartridges are debugged: the one that uploads to the sandbox, else the
 * focused one. The same rule tells b2c which dw.json to read (`configRoot`), so the credentials and
 * the cartridges always come from one workspace. The uploading workspace is picked by hand in the
 * sandbox piece; until it is, this follows the focus.
 */
export async function debugWorkspace(workspaces: Workspaces): Promise<Workspace | null> {
  return (await workspaces.uploading()) ?? (await workspaces.focused())
}

export { isLocal }

/**
 * Opens a file of a workspace in Orca's editor, by its path relative to the workspace with `/`
 * (Orca refuses an absolute one). `editor.open` takes no line, so the file opens at
 * the top: the line is kept here for when src/core/open-file.ts lands on main (it opens a file
 * at a line through `orca file open`), and this is the one place to switch.
 */
export async function openFile(host: OrcaWorkerApi['host'], workspace: Workspace, path: string, line: number | null): Promise<boolean> {
  void line
  try {
    await host.call('editor.open', { workspaceId: workspace.id, path })
    return true
  } catch {
    return false
  }
}
