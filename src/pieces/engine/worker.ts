// The engine piece's worker half, listed in src/worker/pieces.ts. So far it keeps the checkout
// index (phase 6.3) of one workspace: the uploading one, else the focused one, on this machine.
//
// The index is built off the request path: `engine.index.status` answers at once with what is
// there and, when the workspace to index changed, starts a build without waiting for it. A
// watcher of the workspace's folder hands the changed paths to the index once no change came for
// `DEBOUNCE_MS`, and at the latest `MAX_WAIT_MS` after the first one. A change under `.git/` that
// may move a ref asks whether the `metadataRef` ref moved; so does a timer every `REF_CHECK_MS`,
// for a worktree (whose refs live in the main checkout, outside the folder watched) or a
// workspace below its repository's root. A few indexes are kept per workspace, so going back to
// one reads only the files whose time changed. The two settings, `cartridgePath` and
// `metadataRef`, rebuild the paths when changed.
import { readFile } from 'node:fs/promises'
import type { Disposable, PieceContext, WorkerPiece, Workspace } from '../../core/piece'
import { isLocal } from '../../core/workspaces'
import { CheckoutIndex, type CheckoutSettings, type RefReader } from './checkout/checkout'
import { diskFiles, watchCheckout, type Watcher } from './checkout/disk'
import { skippedPath, type CheckoutFiles } from './checkout/files'
import { createGitReader } from './checkout/git'
import { loadDwIndex } from './dw/index'
import type { EngineIndexStatus } from './protocol'

/** The piece's settings, declared in its manifest. */
export const SETTING_CARTRIDGE_PATH = 'cartridgePath'
export const SETTING_METADATA_REF = 'metadataRef'

/** How long the watcher must be quiet before the changed paths are taken in; each change restarts it. */
export const DEBOUNCE_MS = 300
/** The longest changed paths wait while changes keep coming (a long branch switch). */
export const MAX_WAIT_MS = 3_000
/** How often the `metadataRef` ref is asked whether it moved (one `rev-parse`; read again only if it did). */
export const REF_CHECK_MS = 60_000
/** How long after the worker starts the first build begins, so it never slows the start. */
export const START_DELAY_MS = 2_000
/** Indexes kept for workspaces no longer indexed, the most recent first. */
export const KEPT_INDEXES = 2

export type EngineDeps = {
  files?: (root: string) => CheckoutFiles
  watch?: (root: string, onChange: (path: string) => void, onError: () => void) => Watcher | null
  git?: (root: string) => RefReader
  /** The `dw.*` lookup for `require('dw/…')`; null when the index cannot be loaded. */
  dw?: () => Promise<((module: string) => string | null) | null>
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

/** The committed `dw.*` index, loaded once: a `dw/…` module path to the id of its class or package (`require('dw/system')`). */
export async function loadDw(): Promise<((module: string) => string | null) | null> {
  try {
    const data = JSON.parse(await readFile(new URL('../../../data/dw-api.json', import.meta.url), 'utf8')) as unknown
    const index = loadDwIndex(data)
    return (module) => index.findClass(module)?.id ?? (index.packageClasses(module).length > 0 ? module.replace(/\//g, '.') : null)
  } catch {
    return null
  }
}

type Entry = {
  workspace: Workspace
  index: CheckoutIndex
  state: 'building' | 'ready' | 'failed'
  error: string | null
  /** Whether a build has ended well at least once. */
  built: boolean
}

function settingsOf(raw: Record<string, unknown>): Required<CheckoutSettings> {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  return { cartridgePath: text(raw[SETTING_CARTRIDGE_PATH]), metadataRef: text(raw[SETTING_METADATA_REF]) }
}

export function createEnginePiece(deps: EngineDeps = {}): WorkerPiece {
  const files = deps.files ?? diskFiles
  const watch = deps.watch ?? watchCheckout
  const git = deps.git ?? ((root: string) => createGitReader(root))
  const dwLoader = deps.dw ?? loadDw
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const now = deps.now ?? (() => Date.now())

  return {
    id: 'engine',
    activate(ctx: PieceContext): Disposable {
      let disposed = false
      /** The indexes kept, the current one first. */
      const entries: Entry[] = []
      let current: Entry | null = null
      let watcher: Watcher | null = null
      let pending = new Set<string>()
      let refChanged = false
      let flushTimer: unknown = null
      /** When the first change of the batch being gathered came. */
      let firstChangeAt: number | null = null
      let refTimer: unknown = null
      let dw: Promise<((module: string) => string | null) | null> | null = null
      let retargeting: Promise<void> | null = null

      async function settings(): Promise<Required<CheckoutSettings>> {
        try {
          return settingsOf(await ctx.orca.settings.get())
        } catch {
          return settingsOf({})
        }
      }

      /** Runs a change of the index, off the request path; a failure is kept as a code. */
      function run(entry: Entry, task: () => Promise<void>, building: boolean): void {
        if (building && !entry.built) entry.state = 'building'
        void task().then(
          () => {
            entry.state = 'ready'
            entry.error = null
            entry.built = true
            // The counts are computed now, so a status request never waits for them.
            entry.index.status()
          },
          (error: unknown) => {
            entry.state = 'failed'
            entry.error = 'index_failed'
            ctx.log(`the checkout index failed: ${error instanceof Error ? error.name : 'error'}`)
          }
        )
      }

      function stopWatching(): void {
        watcher?.dispose()
        watcher = null
        if (flushTimer !== null) clearTimer(flushTimer)
        flushTimer = null
        firstChangeAt = null
        pending = new Set()
        refChanged = false
      }

      function flush(): void {
        flushTimer = null
        firstChangeAt = null
        const entry = current
        if (!entry || disposed) return
        const paths = [...pending]
        const ref = refChanged
        pending = new Set()
        refChanged = false
        if (paths.length > 0) run(entry, () => entry.index.update(paths), false)
        if (ref) run(entry, () => entry.index.refreshRef(), false)
      }

      function changed(path: string): void {
        if (/^\.git\/(HEAD|packed-refs|refs\/)/.test(path)) refChanged = true
        else if (skippedPath(path)) return
        else pending.add(path)
        // A debounce: each change restarts the wait, bounded by `MAX_WAIT_MS` from the first one.
        const at = now()
        firstChangeAt ??= at
        if (flushTimer !== null) clearTimer(flushTimer)
        flushTimer = setTimer(flush, Math.max(0, Math.min(DEBOUNCE_MS, firstChangeAt + MAX_WAIT_MS - at)))
      }

      /** Asks, every `REF_CHECK_MS`, whether the ref moved: a worktree's refs are not in the folder watched. */
      function scheduleRefCheck(): void {
        refTimer = setTimer(() => {
          refTimer = null
          if (disposed) return
          const entry = current
          if (entry && entry.built) run(entry, () => entry.index.refreshRef(), false)
          scheduleRefCheck()
        }, REF_CHECK_MS)
      }

      function startWatching(entry: Entry): void {
        stopWatching()
        watcher = watch(entry.workspace.path, changed, () => {
          watcher = null
          ctx.log('the checkout watcher stopped: the index is rebuilt on the next status request')
          // Without a watcher the index may fall behind: the next request rebuilds it.
          if (current === entry) current = null
        })
      }

      /** The workspace to index: the uploading one, else the focused one, when its folder is here. */
      async function target(): Promise<Workspace | null> {
        const workspace = (await ctx.workspaces.uploading()) ?? (await ctx.workspaces.focused())
        return workspace && isLocal(workspace) ? workspace : null
      }

      async function retarget(): Promise<void> {
        const workspace = await target()
        if (disposed) return
        if (!workspace) {
          stopWatching()
          current = null
          return
        }
        if (current && current.workspace.id === workspace.id && current.workspace.path === workspace.path) return
        stopWatching()
        const at = entries.findIndex((entry) => entry.workspace.id === workspace.id && entry.workspace.path === workspace.path)
        let entry: Entry
        if (at !== -1) {
          entry = entries.splice(at, 1)[0]
        } else {
          dw ??= dwLoader()
          const lookup = await dw
          entry = {
            workspace,
            index: new CheckoutIndex(files(workspace.path), { ...(await settings()), git: git(workspace.path), dw: lookup }),
            state: 'building',
            error: null,
            built: false
          }
        }
        entries.unshift(entry)
        entries.length = Math.min(entries.length, KEPT_INDEXES + 1)
        current = entry
        startWatching(entry)
        // A kept index is walked again: only files whose time changed are read.
        run(entry, () => entry.index.build(), true)
      }

      /** One retarget at a time: a request arriving during one waits for it, never for a build. */
      function retargetOnce(): Promise<void> {
        retargeting ??= retarget().finally(() => {
          retargeting = null
        })
        return retargeting
      }

      function status(): EngineIndexStatus {
        if (!current) return { workspaceId: null, state: 'none', error: null, watching: false, index: null }
        return {
          workspaceId: current.workspace.id,
          state: current.state,
          error: current.error,
          watching: watcher !== null,
          index: current.built ? current.index.status() : null
        }
      }

      const startTimer = setTimer(() => void retargetOnce().catch(() => undefined), START_DELAY_MS)
      scheduleRefCheck()
      const disposables: Disposable[] = [
        ctx.orca.panels.handle('engine.index.status', async () => {
          try {
            await retargetOnce()
          } catch {
            // The host could not say which workspace: answer with what is there.
          }
          return status()
        }),
        ctx.settings.onDidChange((key) => {
          if (key !== SETTING_CARTRIDGE_PATH && key !== SETTING_METADATA_REF) return
          // Kept indexes would start with the old settings: drop them.
          entries.splice(current ? 1 : 0)
          const entry = current
          if (entry) void settings().then((values) => run(entry, () => entry.index.configure(values), false))
        })
      ]

      return {
        dispose() {
          disposed = true
          clearTimer(startTimer)
          if (refTimer !== null) clearTimer(refTimer)
          stopWatching()
          current = null
          entries.length = 0
          for (const disposable of disposables) disposable.dispose()
        }
      }
    }
  }
}

export const piece: WorkerPiece = createEnginePiece()
