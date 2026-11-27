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
// With `describe: 'cached'` (the editor's) a hover answers at once: the description when it was
// read already, else none (`pending`) and the read started, for the same hover asked with `wait`.
//
// The problems (phase 6.5): after each build, update or change of settings of the index, a pass
// over the checkout (`problems/checkout.ts`) reads the files that changed and checks them all, one
// pass at a time, pausing now and then so requests are answered meanwhile; when its results
// changed, `engine.problems.changed` is posted. `engine.problems` analyses an editor's text at once.
// The `editor.save.before` hook only schedules an analysis of the text being saved and returns at
// once, changing and refusing nothing. A save, or a watcher's batch (an agent's edit), that brings a
// file new problems is told in one notification that says how many, never what or where; a file
// is told at most once per `NOTICE_INTERVAL_MS`, and nothing is told before the first pass ended.
// Whatever names a problem holds goes through `b2c.mask` before it leaves the worker.
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
import { createOpenFile, type OpenFile, type OpenFileFailure } from '../../core/open-file'
import type {
  EngineAnswerState,
  EngineCompletion,
  EngineDefinition,
  EngineHover,
  EngineIndexState,
  EngineIndexStatus,
  EngineProblems,
  EngineQuery,
  EngineQueryError,
  EngineReferences,
  EngineSignature,
  OpenProblemResult,
  ProblemsList,
  ProblemsOfFile,
  ProblemsState
} from './protocol'
import { messages } from './i18n'
import { CheckoutProblems, emptyCounts } from './problems/checkout'
import { listPage, listQuery, matchProblems } from './problems/list'
import { newProblems, type Problem, type ProblemArgs } from './problems/problem'
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
/** The descriptions remembered for `cached` hovers (masked, in memory only), the oldest dropped first. */
export const MAX_DESCRIBED = 2_000
/** How long a description a `cached` hover failed to read is answered as failed, with no new read. */
export const DESCRIBE_FAILURE_MS = 30_000
/** The texts whose analysis is kept, the most recent first: the queries on one text parse it once. */
export const KEPT_ANALYSES = 4
/** How often a workspace folder that is gone is looked for again, and how many times on its own. */
export const FOLDER_RETRY_MS = 10_000
export const FOLDER_RETRIES = 30
/** A file's new problems are notified at most once in this long. */
export const NOTICE_INTERVAL_MS = 60_000
/** The most problems answered to the editor for one text. */
export const MAX_TEXT_PROBLEMS = 500

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
  /** Hands the worker back for a moment during a long pass over the checkout. */
  pause?: () => Promise<void>
  /** Opens a file at a line (src/core/open-file.ts). */
  openFile?: OpenFile
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
  /** A setting changed while the folder was gone: applied when it is back. */
  reconfigure: boolean
  /** The problems of the checkout, kept per file; a pass runs after each build and update. */
  problems: CheckoutProblems
  /** The pass asked for and not started yet, and whether one runs. */
  pending: PassRequest | null
  passing: boolean
  /** Why the last pass failed, as a code; null when it ended. */
  problemsError: string | null
  analysedAt: number | null
  analysisMs: number | null
  /** Raised by every pass and every save taken in. */
  version: number
}

/**
 * A pass over the checkout: `full` reads every file whose time changed (after a build or a change
 * of settings), else only `paths` (a watcher's batch). `notify`: the files read again are told
 * when they have new problems (a watcher's batch: an agent's edit, a save).
 */
type PassRequest = { full: boolean; paths: Set<string>; notify: boolean }

function mergePass(a: PassRequest | null, b: PassRequest): PassRequest {
  if (!a) return { full: b.full, paths: new Set(b.paths), notify: b.notify }
  return { full: a.full || b.full, paths: new Set([...a.paths, ...b.paths]), notify: a.notify || b.notify }
}

/** What Orca's command line answers when it could not run at all: only then `editor.open`. */
const CANNOT_RUN: ReadonlySet<OpenFileFailure> = new Set(['orca_not_found', 'orca_shim_refused', 'orca_failed'])

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
  const pause = deps.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))

  return {
    id: 'engine',
    activate(ctx: PieceContext): Disposable {
      let disposed = false
      const openFile = deps.openFile ?? createOpenFile({ log: ctx.log })
      /** The `dw.*` index once loaded, for the passes (which read it synchronously). */
      let dwApi: DwIndex | null = null
      /** When each file was last told of new problems. */
      const noticed = new Map<string, number>()
      /** The last counts posted, so a pass that changes nothing posts nothing. */
      let posted = ''
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
      /** The descriptions read so far (masked), by class and member: what a `cached` hover answers at once. */
      const described = new Map<string, string | null>()
      /**
       * A read a `cached` hover started that failed: its code and when, kept `DESCRIBE_FAILURE_MS`,
       * so the editor's `wait` that follows and its next hovers start no new `b2c` read. Only a
       * `cached` read records one: the panel's hovers alone read as they always did.
       */
      const failed = new Map<string, { code: string; at: number }>()

      async function settings(): Promise<Required<CheckoutSettings>> {
        try {
          return settingsOf(await ctx.orca.settings.get())
        } catch {
          return settingsOf({})
        }
      }

      /**
       * Runs a change of the index, off the request path; a failure is kept as a code. Once it
       * ended, a pass over the checkout's problems is asked for: `pass` says which.
       */
      function run(entry: Entry, task: () => Promise<void>, building: boolean, pass: PassRequest): void {
        if (building && !entry.built) entry.state = 'building'
        const generation = entry.index.generation
        void task().then(
          () => {
            entry.built = true
            // A build that ended after the folder went says nothing of the folder: it is still gone.
            if (entry.missing) return
            entry.state = 'ready'
            entry.error = null
            // The counts are computed now, so a status request never waits for them.
            entry.index.status()
            // A ref that did not move changed nothing: no pass.
            if (pass.full || pass.paths.size > 0 || entry.index.generation !== generation || entry.analysedAt === null) requestPass(entry, pass)
          },
          (error: unknown) => {
            entry.state = 'failed'
            entry.error = 'index_failed'
            ctx.log(`the checkout index failed: ${error instanceof Error ? error.name : 'error'}`)
            postChanged(entry)
          }
        )
      }

      const FULL: PassRequest = { full: true, paths: new Set(), notify: false }

      // ---- problems

      /** Asks for a pass over the entry's checkout; passes run one at a time, asks made meanwhile merge. */
      function requestPass(entry: Entry, pass: PassRequest): void {
        entry.pending = mergePass(entry.pending, pass)
        if (!entry.passing) void drain(entry)
      }

      async function drain(entry: Entry): Promise<void> {
        entry.passing = true
        try {
          dwApi ??= await apiOnce()
          while (entry.pending && !disposed) {
            const pass = entry.pending
            entry.pending = null
            // Only a file whose problems were known before can have new ones.
            const told = pass.notify && entry.analysedAt !== null
            const started = now()
            try {
              const before = await entry.problems.run(pass.full ? null : [...pass.paths])
              entry.problemsError = null
              entry.analysedAt = now()
              entry.analysisMs = entry.analysedAt - started
              entry.version++
              if (told && entry === current) {
                const changedFiles = [...before.keys()].filter((path) => [...pass.paths].some((each) => path === each || path.startsWith(`${each}/`)))
                notify(changedFiles.map((path) => ({ path, before: before.get(path) ?? [], after: entry.problems.problemsOf(path) })), 'edit')
              }
            } catch (error) {
              if (disposed) return
              entry.problemsError = 'analysis_failed'
              entry.version++
              ctx.log(`the problems pass failed: ${error instanceof Error ? error.name : 'error'}`)
            }
            postChanged(entry)
          }
        } finally {
          entry.passing = false
        }
      }

      /**
       * Tells the person, once, how many new problems the files just changed have: never what or
       * where. A file told less than `NOTICE_INTERVAL_MS` ago is left out.
       */
      function notify(changes: { path: string; before: readonly Problem[]; after: readonly Problem[] }[], via: 'save' | 'edit'): void {
        const at = now()
        let count = 0
        const files: string[] = []
        for (const change of changes) {
          const added = newProblems(change.before, change.after)
          if (added === 0) continue
          const last = noticed.get(change.path)
          if (last !== undefined && at - last < NOTICE_INTERVAL_MS) continue
          count += added
          files.push(change.path)
        }
        if (count === 0 || disposed) return
        for (const path of files) noticed.set(path, at)
        for (const [path, last] of noticed) if (at - last >= NOTICE_INTERVAL_MS) noticed.delete(path)
        const body =
          files.length > 1
            ? ctx.t(messages, 'noticeFiles', { count, files: files.length })
            : ctx.t(messages, count === 1 ? (via === 'save' ? 'noticeSavedOne' : 'noticeChangedOne') : via === 'save' ? 'noticeSaved' : 'noticeChanged', { count })
        void ctx.orca.host.call('notifications.show', { title: ctx.t(messages, 'noticeTitle'), body }).catch(() => undefined)
      }

      /** Posts the counts when they, or the files with problems, changed since the last post. */
      function postChanged(entry: Entry): void {
        if (entry !== current || disposed) return
        const answer = { workspaceId: entry.workspace.id, counts: entry.problems.counts(), files: entry.problems.fileCount(), version: entry.version }
        const state = problemsState(entry)
        const key = JSON.stringify([answer.workspaceId, answer.counts, answer.files, state, entry.problems.signature()])
        if (key === posted) return
        posted = key
        void Promise.resolve(ctx.orca.panels.post('engine.problems.changed', answer)).catch(() => undefined)
      }

      function problemsState(entry: Entry | null): ProblemsState {
        if (!entry) return 'none'
        if (entry.state === 'failed' || entry.problemsError) return 'failed'
        if (!entry.built) return 'indexing'
        return entry.analysedAt === null ? 'analysing' : 'ready'
      }

      function newEntry(workspace: Workspace, index: CheckoutIndex, checkout: CheckoutFiles): Entry {
        return {
          workspace,
          index,
          state: 'building',
          error: null,
          built: false,
          missing: false,
          reconfigure: false,
          problems: new CheckoutProblems(index, checkout, () => dwApi, {
            now,
            pause: () => (disposed ? Promise.reject(new Error('disposed')) : pause())
          }),
          pending: null,
          passing: false,
          problemsError: null,
          analysedAt: null,
          analysisMs: null,
          version: 0
        }
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
        if (paths.length > 0) run(entry, () => entry.index.update(paths), false, { full: false, paths: new Set(paths), notify: true })
        if (ref) run(entry, () => entry.index.refreshRef(), false, { full: false, paths: new Set(), notify: false })
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
          // Git is never asked about a folder that is gone.
          if (entry && entry.built && !entry.missing) run(entry, () => entry.index.refreshRef(), false, { full: false, paths: new Set(), notify: false })
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
          postChanged(entry)
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
        const reconfigure = entry.reconfigure
        entry.reconfigure = false
        // A kept index is walked again: only files whose time changed are read, by the pass too.
        run(
          entry,
          async () => {
            if (reconfigure) await entry.index.configure(await settings())
            await entry.index.build()
          },
          true,
          FULL
        )
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
          const checkout = files(workspace.path)
          entry = newEntry(workspace, new CheckoutIndex(checkout, { ...(await settings()), git: git(workspace.path), dw: lookup }), checkout)
        }
        entries.unshift(entry)
        entries.length = Math.min(entries.length, KEPT_INDEXES + 1)
        current = entry
        posted = ''
        // Watched and built when its folder is there; said to be missing otherwise.
        await lookAgain(entry)
        postChanged(entry)
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

      const describedKey = (classId: string, memberKey: string | undefined) => `${classId}#${memberKey ?? ''}`

      /** Reads a description through the describer; one read well is remembered for `cached` hovers. */
      function readDescription(classId: string, memberKey: string | undefined): Promise<string | null> {
        describer ??= describerOf(ctx.b2c)
        const read = describer.describe(classId, memberKey)
        read.then(
          (description) => {
            const key = describedKey(classId, memberKey)
            described.delete(key)
            described.set(key, description)
            if (described.size > MAX_DESCRIBED) described.delete(described.keys().next().value as string)
          },
          () => undefined
        )
        return read
      }

      /**
       * The description a `cached` hover answers at once: one already read, else none yet
       * (`pending`) with the read started, so a hover asked again with `wait` finds it.
       */
      function describeCached(classId: string, memberKey: string | undefined): { description: string | null; descriptionError: string | null } {
        const key = describedKey(classId, memberKey)
        if (described.has(key)) return { description: described.get(key) ?? null, descriptionError: null }
        const code = recentFailure(key)
        if (code !== null) return { description: null, descriptionError: code }
        readDescription(classId, memberKey).then(
          () => failed.delete(key),
          (error: unknown) => {
            failed.set(key, { code: errorCode(error), at: now() })
            if (failed.size > MAX_DESCRIBED) failed.delete(failed.keys().next().value as string)
          }
        )
        return { description: null, descriptionError: 'pending' }
      }

      /** The code of a `cached` read of this description that failed within `DESCRIBE_FAILURE_MS`; null when none. */
      function recentFailure(key: string): string | null {
        const failure = failed.get(key)
        if (!failure) return null
        if (now() - failure.at > DESCRIBE_FAILURE_MS) {
          failed.delete(key)
          return null
        }
        return failure.code
      }

      /** The description a hover wants, waited for at most `DESCRIBE_WAIT_MS`; the describer keeps a page once read. */
      async function describe(classId: string, memberKey: string | undefined): Promise<{ description: string | null; descriptionError: string | null }> {
        // The editor's `cached` hover just failed to read it: the same failure, no second read.
        const code = recentFailure(describedKey(classId, memberKey))
        if (code !== null) return { description: null, descriptionError: code }
        let timer: unknown = null
        const late = new Promise<'late'>((resolve) => {
          timer = setTimer(() => resolve('late'), DESCRIBE_WAIT_MS)
        })
        try {
          const read = readDescription(classId, memberKey)
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
        // `cached` (the editor): answered at once, the description when read already; `wait` (the default) waits for it.
        if ((input as { describe?: unknown }).describe === 'cached') return { ...answer, hover: { ...found, ...describeCached(found.describe.classId, found.describe.memberKey) } }
        return { ...answer, hover: { ...found, ...(await describe(found.describe.classId, found.describe.memberKey)) } }
      }

      // ---- problems: requests and the save hook

      /**
       * Masks texts for a panel or the editor, in one call: joined by line breaks (a name holds
       * none once its own are made spaces), masked once, split again.
       */
      async function maskAll(texts: readonly string[]): Promise<string[]> {
        if (texts.length === 0) return []
        const plain = texts.map((text) => text.replace(/[\r\n]+/g, ' '))
        const masked = (await ctx.b2c.mask(plain.join('\n'))).split('\n')
        return masked.length === plain.length ? masked : Promise.all(plain.map((text) => ctx.b2c.mask(text)))
      }

      /** Problems as a panel or the editor may see them: their names masked. */
      async function shownAll(problems: readonly Problem[]): Promise<Problem[]> {
        const texts: string[] = []
        for (const each of problems) for (const value of Object.values(each.args)) if (typeof value === 'string') texts.push(value)
        const masked = await maskAll(texts)
        let at = 0
        return problems.map((each) => {
          const args: ProblemArgs = {}
          for (const [key, value] of Object.entries(each.args)) if (typeof value === 'string') args[key as keyof ProblemArgs] = masked[at++]
          return { ...each, args }
        })
      }

      async function problemsList(input: unknown): Promise<ProblemsList> {
        try {
          await retargetOnce()
        } catch {
          // The host could not say which workspace: answer with what is there.
        }
        const entry = current
        const query = listQuery(input)
        const base = { workspaceId: entry?.workspace.id ?? null, state: problemsState(entry), error: entry ? (entry.error ?? entry.problemsError) : null, busy: entry?.passing ?? false }
        if (!entry) return { ...base, counts: emptyCounts(), files: 0, matching: { problems: 0, files: 0, listable: 0 }, page: [], analysedAt: null, analysisMs: null, version: 0 }
        const version = entry.version
        const { matching, page } = listPage(entry.problems.entries(), query)
        const paths = await maskAll(page.map((file) => file.path))
        const problems = await shownAll(page.flatMap((file) => file.problems))
        let at = 0
        const masked = page.map((file, index) => ({ ...file, path: paths[index], problems: file.problems.map(() => problems[at++]) }))
        return { ...base, counts: entry.problems.counts(), files: entry.problems.fileCount(), matching, page: masked, analysedAt: entry.analysedAt, analysisMs: entry.analysisMs, version }
      }

      /** The real path of a file with problems from the path a view was given (masked). */
      async function realPath(entry: Entry, given: unknown): Promise<string | null> {
        if (typeof given !== 'string' || given === '') return null
        const plain = normalizePath(given)
        if (plain !== null && entry.problems.problemsOf(plain).length > 0) return plain
        const paths = entry.problems.entries().map(([path]) => path)
        const masked = await maskAll(paths)
        const at = masked.indexOf(given)
        return at === -1 ? null : paths[at]
      }

      async function problemsOfFile(input: unknown): Promise<ProblemsOfFile> {
        const entry = current
        const given = (input as { path?: unknown } | null)?.path
        const path = entry ? await realPath(entry, given) : null
        if (!entry || path === null) return { path: typeof given === 'string' ? given : '', problems: [], total: 0, version: entry?.version ?? 0 }
        const version = entry.version
        const { severity, search, limit } = listQuery(input)
        const found = matchProblems(path, entry.problems.problemsOf(path), severity, search)
        const [masked] = await maskAll([path])
        return { path: masked, problems: await shownAll(found.slice(0, limit)), total: found.length, version }
      }

      async function openProblem(input: unknown): Promise<OpenProblemResult> {
        const entry = current
        const raw = (typeof input === 'object' && input !== null ? input : {}) as { path?: unknown; line?: unknown; column?: unknown }
        if (!entry) return { opened: false, reason: 'no_workspace' }
        const path = await realPath(entry, raw.path)
        if (path === null) return { opened: false, reason: 'not_found' }
        const line = typeof raw.line === 'number' && Number.isInteger(raw.line) && raw.line > 0 ? raw.line : undefined
        const column = line && typeof raw.column === 'number' && Number.isInteger(raw.column) && raw.column > 0 ? raw.column : undefined
        // The person pressed the button to see the file: it is brought forward.
        const result = await openFile({ root: entry.workspace.path, path, line, column, focus: true })
        if (result.opened) return { opened: true }
        if (!CANNOT_RUN.has(result.reason)) return { opened: false, reason: result.reason }
        try {
          // Orca's command line cannot run here: the file opens at its top.
          await ctx.orca.host.call('editor.open', { workspaceId: entry.workspace.id, path })
          return { opened: true }
        } catch {
          return { opened: false, reason: result.reason }
        }
      }

      async function onProblems(input: unknown): Promise<EngineProblems> {
        const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
        const checked = checkQuery({ ...raw, offset: typeof raw.offset === 'number' ? raw.offset : 0 })
        if ('error' in checked) return { index: 'none', error: checked.error, problems: [] }
        const { state } = await queryContext(checked.query.workspaceId)
        const entry = current && current.workspace.id === checked.query.workspaceId && current.built ? current : null
        if (!entry) return { index: state, error: null, problems: [] }
        dwApi ??= await apiOnce()
        const problems = entry.problems.analyseText(checked.query.path, checked.query.text)
        return { index: state, error: null, problems: await shownAll(problems.slice(0, MAX_TEXT_PROBLEMS)) }
      }

      /** The path of a saved file relative to the entry's workspace; null when it is not one of its files. */
      function savedPath(entry: Entry, event: { workspaceId: string | null; path: string }): string | null {
        if (event.workspaceId !== null && event.workspaceId !== entry.workspace.id) return null
        const path = event.path.replace(/\\/g, '/')
        const root = entry.workspace.path.replace(/\\/g, '/').replace(/\/+$/, '')
        const absolute = path.startsWith('/') || /^[a-zA-Z]:\//.test(path)
        if (!absolute) return event.workspaceId === entry.workspace.id ? normalizePath(path) : null
        const windows = /^[a-zA-Z]:\//.test(root)
        const same = windows ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`) : path.startsWith(`${root}/`)
        return same ? normalizePath(path.slice(root.length + 1)) : null
      }

      /**
       * A save about to be written: an analysis of its text is scheduled, and the hook returns at
       * once, changing and refusing nothing. When it ends, new problems in that file are told.
       */
      function onSave(event: { workspaceId: string | null; path: string; text: string }): void {
        const entry = current
        if (!entry || disposed || typeof event.path !== 'string' || typeof event.text !== 'string') return
        const path = savedPath(entry, event)
        if (path === null || path === '' || event.text.length > MAX_PARSED_CHARACTERS) return
        const text = event.text
        void pause()
          .then(() => {
            if (disposed || current !== entry || !entry.built) return
            const { before, after } = entry.problems.takeText(path, text)
            entry.version++
            if (entry.analysedAt !== null) notify([{ path, before, after }], 'save')
            postChanged(entry)
          })
          .catch(() => undefined)
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
        ctx.orca.panels.handle('engine.problems', (input) => onProblems(input)),
        ctx.orca.panels.handle('engine.problems.list', (input) => problemsList(input)),
        ctx.orca.panels.handle('engine.problems.file', (input) => problemsOfFile(input)),
        ctx.orca.panels.handle('engine.problems.open', (input) => openProblem(input)),
        ctx.orca.panels.handle('engine.problems.refresh', (input) => {
          const entry = current
          if (entry && entry.missing) {
            // Never read or built over a folder that is gone: it is looked for instead.
            void lookAgain(entry)
          } else if (entry && entry.built) {
            entry.problemsError = null
            requestPass(entry, FULL)
          } else if (entry && entry.state === 'failed') {
            run(entry, () => entry.index.build(), true, FULL)
          }
          return problemsList(input)
        }),
        // Only schedules: never awaits, never changes or refuses the save.
        ctx.orca.hooks.on('editor.save.before', (event) => {
          try {
            onSave(event)
          } catch {
            // Whatever happens here, the save goes on.
          }
        }),
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
          // A folder that is gone is not read: the settings are applied once it is back.
          if (entry?.missing) entry.reconfigure = true
          else if (entry) void settings().then((values) => run(entry, () => entry.index.configure(values), false, FULL))
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
          described.clear()
          failed.clear()
          for (const disposable of disposables) disposable.dispose()
        }
      }
    }
  }
}

export const piece: WorkerPiece = createEnginePiece()
