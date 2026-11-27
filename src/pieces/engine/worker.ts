// The engine piece's worker half, listed in src/worker/pieces.ts. It keeps the checkout index
// (phase 6.3) of one workspace: the uploading one, else the focused one, on this machine; and it
// answers the queries (phase 6.4) on a file's text with it.
//
// The index is built off the request path: `engine.index.status` answers at once with what is
// there and, when the workspace to index changed, starts a build without waiting for it. A
// watcher of the workspace's folder hands the changed paths to the index once no change came for
// `DEBOUNCE_MS`, and at the latest `MAX_WAIT_MS` after the first one. A change under `.git/` that
// may move a ref asks whether the `metadataRef` ref moved; so does a timer every `REF_CHECK_MS`,
// for a worktree (whose refs live in the main checkout, outside the folder watched) or a
// workspace below its repository's root. A few indexes are kept per workspace, so going back to
// one reads only the files whose time changed. The two settings, `cartridgePath` and
// `metadataRef`, rebuild the paths when changed. When the workspace's folder is gone (a worktree
// removed), the index says so (`failed`, `folder_missing`) and the folder is looked for again on
// every status request and every `FOLDER_RETRY_MS`, at most `FOLDER_RETRIES` times; once it is
// back, it is watched again and the index rebuilt.
//
// The queries (`engine.complete`, `engine.hover`, `engine.definition`, `engine.references`,
// `engine.signature`) read the editor's text with the index of the workspace named when it is
// the one indexed; for another, only what needs no checkout answers. The last few texts read are
// kept, so the queries on one text parse it once. A hover of a
// `dw.*` class or member waits up to `DESCRIBE_WAIT_MS` for its description, read through
// `b2c docs read` (masked, kept in memory only); a page that comes late is there for the next.
import { readFile, stat } from 'node:fs/promises'
import type { B2c } from '../../core/b2c'
import type { Disposable, PieceContext, WorkerPiece, Workspace } from '../../core/piece'
import { isLocal } from '../../core/workspaces'
import { CheckoutIndex, type CheckoutSettings, type RefReader } from './checkout/checkout'
import { diskFiles, watchCheckout, type Watcher } from './checkout/disk'
import { normalizePath, skippedPath, type CheckoutFiles } from './checkout/files'
import { createGitReader } from './checkout/git'
import { MemoryFiles } from './checkout/memory'
import { MAX_PARSED_CHARACTERS } from './checkout/scan'
import { createDescriber, type Describer } from './dw/describe'
import { loadDwIndex, type DwIndex } from './dw/index'
import type { EngineAnswerState, EngineCompletion, EngineDefinition, EngineHover, EngineIndexState, EngineIndexStatus, EngineQuery, EngineQueryError, EngineReferences, EngineSignature } from './protocol'
import { analyse, type Analysis } from './query/analysis'
import { complete } from './query/complete'
import { definition } from './query/definition'
import { hover, hoverItem } from './query/hover'
import type { QueryContext } from './query/modules'
import { references } from './query/references'
import { signatureHelp } from './query/signature'

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
/** How long a hover waits for the description of a `dw.*` class or member before answering without it. */
export const DESCRIBE_WAIT_MS = 2_500
/** The texts whose analysis is kept, the most recent first: the queries on one text parse it once. */
export const KEPT_ANALYSES = 4
/** How often a workspace folder that is gone is looked for again, and how many times on its own. */
export const FOLDER_RETRY_MS = 10_000
export const FOLDER_RETRIES = 30

export type EngineDeps = {
  files?: (root: string) => CheckoutFiles
  watch?: (root: string, onChange: (path: string) => void, onError: () => void) => Watcher | null
  git?: (root: string) => RefReader
  /** The `dw.*` lookup for `require('dw/…')`; null when the index cannot be loaded. Derived from `api` when left out. */
  dw?: () => Promise<((module: string) => string | null) | null>
  /** The committed `dw.*` index the queries read; null when it cannot be loaded. */
  api?: () => Promise<DwIndex | null>
  /** Reads a description through `b2c docs read`. */
  describer?: (b2c: B2c) => Describer
  /** Whether a workspace's folder is there; the real disk when left out. */
  exists?: (root: string) => Promise<boolean>
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

/** Whether `root` is a folder on this machine. */
async function folderExists(root: string): Promise<boolean> {
  try {
    return (await stat(root)).isDirectory()
  } catch {
    return false
  }
}

/** The committed `dw.*` index (data/dw-api.json); null when it cannot be read or checked. */
export async function loadDwApi(): Promise<DwIndex | null> {
  try {
    return loadDwIndex(JSON.parse(await readFile(new URL('../../../data/dw-api.json', import.meta.url), 'utf8')) as unknown)
  } catch {
    return null
  }
}

/** A `dw/…` module path to the id of its class or package (`require('dw/system')`), over an index. */
export function dwLookup(index: DwIndex): (module: string) => string | null {
  return (module) => index.findClass(module)?.id ?? (index.packageClasses(module).length > 0 ? module.replace(/\//g, '.') : null)
}

/** The committed `dw.*` index as a lookup of module paths. */
export async function loadDw(): Promise<((module: string) => string | null) | null> {
  const index = await loadDwApi()
  return index ? dwLookup(index) : null
}

/** A query as given, checked: its path made plain, or why it cannot be read. */
export function checkQuery(input: unknown): { query: EngineQuery } | { error: EngineQueryError } {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<EngineQuery>
  const path = typeof raw.path === 'string' ? normalizePath(raw.path) : null
  if (typeof raw.workspaceId !== 'string' || path === null || path === '') return { error: 'file_invalid' }
  if (typeof raw.text !== 'string') return { error: 'offset_invalid' }
  if (raw.text.length > MAX_PARSED_CHARACTERS) return { error: 'text_too_large' }
  if (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0 || raw.offset > raw.text.length) return { error: 'offset_invalid' }
  return { query: { workspaceId: raw.workspaceId, path, text: raw.text, offset: raw.offset } }
}

/** A failure's code (`b2c_not_found`, `wrong_page`, …), never its message. */
function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && /^[a-z0-9_]+$/.test(code) ? code : 'describe_failed'
}

type Entry = {
  workspace: Workspace
  index: CheckoutIndex
  state: 'building' | 'ready' | 'failed'
  error: string | null
  /** Whether a build has ended well at least once. */
  built: boolean
  /** Its folder is gone: it is looked for again, and the index rebuilt once it is back. */
  missing: boolean
}

function settingsOf(raw: Record<string, unknown>): Required<CheckoutSettings> {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  return { cartridgePath: text(raw[SETTING_CARTRIDGE_PATH]), metadataRef: text(raw[SETTING_METADATA_REF]) }
}

export function createEnginePiece(deps: EngineDeps = {}): WorkerPiece {
  const files = deps.files ?? diskFiles
  const watch = deps.watch ?? watchCheckout
  const git = deps.git ?? ((root: string) => createGitReader(root))
  const apiLoader = deps.api ?? loadDwApi
  const describerOf = deps.describer ?? ((b2c: B2c) => createDescriber(b2c))
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const now = deps.now ?? (() => Date.now())
  const exists = deps.exists ?? folderExists

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
      /** The timer that looks again for a folder that is gone, and how many times it has. */
      let folderTimer: unknown = null
      let folderTries = 0
      /** A look for an entry's folder in progress: one at a time per entry. */
      let looking: { entry: Entry; done: Promise<void> } | null = null
      let dw: Promise<((module: string) => string | null) | null> | null = null
      let api: Promise<DwIndex | null> | null = null
      const apiOnce = () => (api ??= apiLoader())
      const dwLoader =
        deps.dw ??
        (async () => {
          const index = await apiOnce()
          return index ? dwLookup(index) : null
        })
      let retargeting: Promise<void> | null = null
      /** The texts last read, the most recent first. */
      const analyses: { key: string; text: string; analysis: Analysis }[] = []
      /** What a query reads when its workspace is not the one indexed: an index of nothing. */
      const emptyIndex = new CheckoutIndex(new MemoryFiles())
      let describer: Describer | null = null

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
            entry.built = true
            // A build that ended after the folder went says nothing of the folder: it is still gone.
            if (entry.missing) return
            entry.state = 'ready'
            entry.error = null
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
          if (current !== entry || disposed) return
          // Changes may have been missed: the folder is looked for, watched again and rebuilt.
          ctx.log('the checkout watcher stopped: the folder is watched again and the index rebuilt')
          void lookAgain(entry)
        })
      }

      function stopLooking(): void {
        if (folderTimer !== null) clearTimer(folderTimer)
        folderTimer = null
        folderTries = 0
      }

      /** Looks for the folder again in `FOLDER_RETRY_MS`, at most `FOLDER_RETRIES` times; then only a status request does. */
      function scheduleLook(entry: Entry): void {
        if (folderTimer !== null || folderTries >= FOLDER_RETRIES || disposed) return
        folderTimer = setTimer(() => {
          folderTimer = null
          folderTries++
          if (current === entry && entry.missing) void lookAgain(entry)
        }, FOLDER_RETRY_MS)
      }

      /**
       * Watches the entry's folder and builds its index, when the folder is there; when it is gone,
       * says so (`folder_missing`) and looks again later.
       */
      async function watchAndBuild(entry: Entry): Promise<void> {
        const there = await exists(entry.workspace.path)
        if (disposed || current !== entry) return
        if (!there) {
          stopWatching()
          if (!entry.missing) ctx.log('the workspace folder is gone: it is looked for again')
          entry.missing = true
          entry.state = 'failed'
          entry.error = 'folder_missing'
          scheduleLook(entry)
          return
        }
        if (entry.missing) {
          ctx.log('the workspace folder is back: it is watched and indexed again')
          // What the index holds is from before the folder went: it is built again before it answers as ready.
          entry.missing = false
          entry.state = 'building'
          entry.error = null
        }
        stopLooking()
        startWatching(entry)
        // A kept index is walked again: only files whose time changed are read.
        run(entry, () => entry.index.build(), true)
      }

      /** One look at a time for an entry; one for another entry starts on its own. */
      function lookAgain(entry: Entry): Promise<void> {
        if (looking?.entry === entry) return looking.done
        const look = {
          entry,
          done: watchAndBuild(entry).finally(() => {
            if (looking === look) looking = null
          })
        }
        looking = look
        return look.done
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
          stopLooking()
          current = null
          return
        }
        if (current && current.workspace.id === workspace.id && current.workspace.path === workspace.path) {
          // A folder that is gone (whether or not the watcher said so) is looked for on each request.
          const entry = current
          if (entry.missing || !(await exists(entry.workspace.path))) await lookAgain(entry)
          return
        }
        stopWatching()
        stopLooking()
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
            built: false,
            missing: false
          }
        }
        entries.unshift(entry)
        entries.length = Math.min(entries.length, KEPT_INDEXES + 1)
        current = entry
        await lookAgain(entry)
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

      /** The index a query on a workspace reads, and its state. */
      async function queryContext(workspaceId: string): Promise<{ query: QueryContext; state: EngineIndexState }> {
        const dwIndex = await apiOnce()
        const entry = current && current.workspace.id === workspaceId ? current : null
        if (!entry) return { query: { index: emptyIndex, dw: dwIndex }, state: 'none' }
        // Once built, the index answers from its last complete state, even while it changes.
        const state: EngineIndexState = entry.state === 'failed' ? 'failed' : entry.built ? 'ready' : 'building'
        return { query: { index: entry.index, dw: dwIndex }, state }
      }

      function analysisOf(query: EngineQuery): Analysis {
        const key = `${query.workspaceId}\u0000${query.path}`
        const at = analyses.findIndex((each) => each.key === key && each.text === query.text)
        if (at !== -1) {
          const [kept] = analyses.splice(at, 1)
          analyses.unshift(kept)
          return kept.analysis
        }
        const analysis = analyse(query.path, query.text)
        analyses.unshift({ key, text: query.text, analysis })
        analyses.length = Math.min(analyses.length, KEPT_ANALYSES)
        return analysis
      }

      /** The description a hover wants, waited for at most `DESCRIBE_WAIT_MS`; the describer keeps a page once read. */
      async function describe(classId: string, memberKey: string | undefined): Promise<{ description: string | null; descriptionError: string | null }> {
        describer ??= describerOf(ctx.b2c)
        let timer: unknown = null
        const late = new Promise<'late'>((resolve) => {
          timer = setTimer(() => resolve('late'), DESCRIBE_WAIT_MS)
        })
        try {
          const read = describer.describe(classId, memberKey)
          read.catch(() => undefined)
          const found = await Promise.race([read, late])
          if (found === 'late') return { description: null, descriptionError: 'timeout' }
          return { description: found, descriptionError: null }
        } catch (error) {
          return { description: null, descriptionError: errorCode(error) }
        } finally {
          clearTimer(timer)
        }
      }

      async function onComplete(input: unknown): Promise<EngineCompletion> {
        const checked = checkQuery(input)
        if ('error' in checked) return { index: 'none', error: checked.error, completion: { context: 'none', range: { start: 0, end: 0 }, items: [], truncated: false, guessed: false } }
        const { query, state } = await queryContext(checked.query.workspaceId)
        return { index: state, error: null, completion: complete(query, analysisOf(checked.query), checked.query.offset) }
      }

      async function onHover(input: unknown): Promise<EngineHover> {
        const checked = checkQuery(input)
        if ('error' in checked) return { index: 'none', error: checked.error, hover: null }
        const { query, state } = await queryContext(checked.query.workspaceId)
        const answer: EngineAnswerState = { index: state, error: null }
        const analysis = analysisOf(checked.query)
        const id = (input as { id?: unknown }).id
        const found = typeof id === 'string' ? hoverItem(query, analysis, id) : hover(query, analysis, checked.query.offset)
        if (!found) return { ...answer, hover: null }
        if (found.kind !== 'dw-member' && found.kind !== 'dw-class') return { ...answer, hover: { ...found, description: null, descriptionError: null } }
        return { ...answer, hover: { ...found, ...(await describe(found.describe.classId, found.describe.memberKey)) } }
      }

      /** A query answered from the index and the text alone: definition, references, signature help. */
      async function onQuery<T>(input: unknown, run: (query: QueryContext, analysis: Analysis, offset: number) => T | null): Promise<EngineAnswerState & { result: T | null }> {
        const checked = checkQuery(input)
        if ('error' in checked) return { index: 'none', error: checked.error, result: null }
        const { query, state } = await queryContext(checked.query.workspaceId)
        return { index: state, error: null, result: run(query, analysisOf(checked.query), checked.query.offset) }
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
        ctx.orca.panels.handle('engine.complete', (input) => onComplete(input)),
        ctx.orca.panels.handle('engine.hover', (input) => onHover(input)),
        ctx.orca.panels.handle('engine.definition', async (input): Promise<EngineDefinition> => {
          const { result, ...answer } = await onQuery(input, definition)
          return { ...answer, definition: result }
        }),
        ctx.orca.panels.handle('engine.references', async (input): Promise<EngineReferences> => {
          const { result, ...answer } = await onQuery(input, references)
          return { ...answer, references: result }
        }),
        ctx.orca.panels.handle('engine.signature', async (input): Promise<EngineSignature> => {
          const { result, ...answer } = await onQuery(input, signatureHelp)
          return { ...answer, signature: result }
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
          stopLooking()
          current = null
          entries.length = 0
          analyses.length = 0
          for (const disposable of disposables) disposable.dispose()
        }
      }
    }
  }
}

export const piece: WorkerPiece = createEnginePiece()
