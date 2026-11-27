// Which workspace the debugger works on, and how it opens one of its files: each decided in one
// function, so a follow-up can change it in one place.
import type { OrcaWorkerApi } from 'orca/worker'
import type { OpenFile, OpenFileFailure } from '../../core/open-file'
import type { Workspace, Workspaces } from '../../core/piece'
import { activeWorkspace, isLocal } from '../../core/workspaces'

/**
 * The workspace whose cartridges are debugged: the one the plugin works on (`activeWorkspace`: the
 * one that uploads to the sandbox; else the focused one with a configuration file; else the last
 * one that had one). The same rule tells b2c which dw.json to read (`configRoot`), so the
 * credentials and the cartridges always come from one workspace, even while the focus is on a
 * workspace with no dw.json.
 */
export async function debugWorkspace(workspaces: Workspaces): Promise<Workspace | null> {
  return (await activeWorkspace(workspaces))?.workspace ?? null
}

export { isLocal }

/** What `openFile` answers when Orca's command line could not run at all: only then `editor.open`. */
const CANNOT_RUN: ReadonlySet<OpenFileFailure> = new Set(['orca_not_found', 'orca_shim_refused', 'orca_failed'])

export type OpenLocation = { path: string; line: number | null; column?: number }

/**
 * Opens a file of a workspace in Orca's editor at its line (and column, when known), through
 * src/core/open-file.ts with the workspace's folder as its root, bringing the person to it. When
 * Orca's command line cannot run there (not found, a refused shim, or it failed), it falls back to
 * `editor.open`, which takes no line and only a path relative to the workspace, so the file opens
 * at the top. A file outside the workspace, or one that is not there, is not opened either way,
 * and neither is anything after a timeout (the first call may still land). A script or template
 * opens in the plugin's own editor (`inEditor`), which the debugger's breakpoints live in. The one
 * place a file of the debugger is opened.
 */
export async function openFile(open: OpenFile, host: OrcaWorkerApi['host'], workspace: Workspace, location: OpenLocation): Promise<boolean> {
  const line = typeof location.line === 'number' && location.line > 0 ? location.line : undefined
  const result = await open({ root: workspace.path, path: location.path, line, column: line ? location.column : undefined, focus: true, inEditor: true })
  if (result.opened) return true
  if (!CANNOT_RUN.has(result.reason)) return false
  try {
    await host.call('editor.open', { workspaceId: workspace.id, path: location.path })
    return true
  } catch {
    return false
  }
}
