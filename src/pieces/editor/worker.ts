// The editor piece's worker half, listed in src/worker/pieces.ts. It names the file an editor
// frame shows (`editor.locate`, locate.ts), keeps the person's choice among identical files
// (`editor.choose`), hears every explicit save from an editor tab (`editor.save.before`, observed
// only: it never changes or refuses a save) and runs the command that opens a file in the
// plugin's editor.
//
// No host call gives the focused editor tab's path, so the command opens the file last saved in
// the focused workspace (of a type the editor takes) in the plugin's editor, with the line kept
// nowhere: save first, then run it.
import type { OrcaWorkerApi } from 'orca/worker'
import { createOpenFile, editorTakes, isInside, type OpenFile } from '../../core/open-file'
import type { Disposable, PieceContext, WorkerPiece, Workspace } from '../../core/piece'
import { isLocal } from '../../core/workspaces'
import { messages } from './i18n'
import { hashText, Locator } from './locate'
import type { EditorLocated, EditorText } from './protocol'

/** The command that opens the last saved file in the plugin's editor. */
export const OPEN_COMMAND = 'editor.openInEditor'
/** How long after the worker starts the focused workspace is indexed, so the start stays quick. */
export const WARM_DELAY_MS = 3_000

export type EditorDeps = {
  locator?: Locator
  openFile?: OpenFile
  platform?: string
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const invalid = () => Object.assign(new Error('Invalid input'), { code: 'invalid_params' })

/** The hash of what the frame sent: its hash as given (64 hex digits), else the hash of its text. */
export function hashOf(input: EditorText | null | undefined): string {
  if (typeof input?.hash === 'string' && /^[0-9a-f]{64}$/.test(input.hash)) return input.hash
  if (typeof input?.text === 'string') return hashText(input.text)
  throw invalid()
}

/** The workspace a save names: `<project>::<folder>` as an editor tab holds it, or a workspace's own id. */
export function workspaceOfSave(workspaces: readonly Workspace[], workspaceId: string | null, path: string, platform: string): Workspace | null {
  const local = workspaces.filter(isLocal)
  const fold = (value: string) => {
    const slashes = value.replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' ? slashes.toLowerCase() : slashes
  }
  if (workspaceId) {
    const byId = local.find((workspace) => workspace.id === workspaceId)
    if (byId) return byId
    const separator = workspaceId.indexOf('::')
    if (separator !== -1) {
      const folder = fold(workspaceId.slice(separator + 2))
      const byFolder = local.find((workspace) => fold(workspace.path) === folder)
      if (byFolder) return byFolder
    }
  }
  // No workspace named: the one whose folder holds the file, the deepest first.
  const absolute = /^([A-Za-z]:[\\/]|\/)/.test(path)
  if (!absolute) return null
  const holding = local.filter((workspace) => isInside(workspace.path, path, platform))
  return holding.sort((a, b) => b.path.length - a.path.length)[0] ?? null
}

export function createEditorPiece(deps: EditorDeps = {}): WorkerPiece {
  return {
    id: 'editor',
    activate(ctx: PieceContext): Disposable {
      const platform = deps.platform ?? process.platform
      const locator = deps.locator ?? new Locator({ store: ctx.store, platform })
      const open = deps.openFile ?? createOpenFile({ log: ctx.log })
      const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
      const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
      let stopped = false

      async function workspaceById(workspaceId: unknown): Promise<Workspace | null> {
        if (typeof workspaceId !== 'string' || !workspaceId) return null
        const workspace = (await ctx.workspaces.list()).find((candidate) => candidate.id === workspaceId) ?? null
        return workspace && isLocal(workspace) ? workspace : null
      }

      async function locate(input: { workspaceId?: unknown } & EditorText): Promise<EditorLocated> {
        const hash = hashOf(input)
        const workspace = await workspaceById(input.workspaceId)
        if (!workspace) return null
        return locator.locate(workspace.path, workspace.id, hash)
      }

      async function saved(event: { workspaceId: string | null; path: string; text: string }): Promise<void> {
        if (typeof event?.path !== 'string' || typeof event.text !== 'string') return
        const workspace = workspaceOfSave(await ctx.workspaces.list(), event.workspaceId, event.path, platform)
        if (!workspace) return
        const path = locator.recordSave(workspace.path, event.path)
        if (path === null || stopped) return
        // Every editor hears it; only the one that was flushed for this save, with this text, takes the path.
        ctx.orca.panels.post('editor.saved', { workspaceId: workspace.id, path, hash: hashText(event.text) })
      }

      const word = (key: keyof (typeof messages)['en'], vars?: Record<string, string>) => ctx.t(messages, key, vars)

      async function openLastSaved(): Promise<string> {
        const workspace = await ctx.workspaces.focused()
        if (!workspace || !isLocal(workspace)) return word('cmdNoWorkspace')
        const path = locator.lastSaved(workspace.path, editorTakes)
        if (path === null) return word('cmdNothingSaved')
        const result = await open({ root: workspace.path, path, inEditor: true, focus: true })
        const name = path.slice(path.lastIndexOf('/') + 1)
        return result.opened ? word('cmdOpened', { name }) : word('cmdNotOpened', { name })
      }

      const warm = setTimer(() => {
        if (stopped) return
        void ctx.workspaces
          .focused()
          .then((workspace) => {
            if (!stopped && workspace && isLocal(workspace)) locator.warm(workspace.path)
          })
          .catch(() => {})
      }, WARM_DELAY_MS)

      const orca: OrcaWorkerApi = ctx.orca
      const handles = [
        orca.panels.handle('editor.locate', (input) => locate(input ?? { workspaceId: null })),
        orca.panels.handle('editor.choose', async (input) => {
          const hash = hashOf(input)
          if (typeof input?.path !== 'string' || !input.path) throw invalid()
          const workspace = await workspaceById(input.workspaceId)
          if (!workspace) return { ok: false }
          return { ok: await locator.choose(workspace.path, workspace.id, hash, input.path) }
        }),
        // Observed only: the save goes on at once, and what it saved is recorded after.
        orca.hooks.on('editor.save.before', (event) => {
          void saved(event).catch(() => {})
        }),
        orca.commands.register(OPEN_COMMAND, () => openLastSaved())
      ]
      return {
        dispose() {
          stopped = true
          clearTimer(warm)
          for (const handle of handles) handle.dispose()
        }
      }
    }
  }
}

export const piece: WorkerPiece = createEditorPiece()
