// The debugger piece's worker half, listed in src/worker/pieces.ts: the `debugger.*` requests, the
// debugging commands, and the `debugger.state` event, coalesced so a burst of adapter events
// reaches the panel as one post. A session runs on the sandbox only, in the debugged workspace's
// folder (src/pieces/debugger/workspace.ts), and is always disconnected on stop and when the
// worker goes away.
import { readFile, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { RoleState } from '../../core/instances'
import type { Disposable, PieceContext, Workspace, WorkerPiece } from '../../core/piece'
import { createBreakpoints, BreakpointsError, normalizePath, type BreakpointFile } from './breakpoints'
import { byCartridge, isScriptPath, scriptFiles, type ReadDir } from './files'
import { plainRead } from './inspect'
import { remapLines, textLines } from './line-diff'
import { readSource, SourceError, type SourceFileSystem } from './source'
import { messages } from './i18n'
import type { DebuggerFileState, DebuggerHoverValue, DebuggerState, DebugWorkspaceState, StepKind, Variable } from './protocol'
import { createSession, SessionError, type SessionSnapshot } from './session'
import { DapError } from './dap-client'
import { createOpenFile, type OpenFile } from '../../core/open-file'
import { debugWorkspace, isLocal, openFile } from './workspace'

/** The flag of a session that may have left a debugger client on the instance. */
const UNCLEAN_KEY = 'unclean'
/** Panel posts are at most this often: state changes in between are folded into one. */
const COALESCE_MS = 200
/** How long the list of a workspace's scripts is reused before it is read again. */
const FILES_TTL_MS = 30_000
/** Workspaces whose lists of scripts are kept at once (the debugged one and the editors' ones). */
const FILES_KEPT = 4
/** What the editor's hover is sent of a value at most, once masked. */
export const HOVER_MAX_TEXT = 1_000
/** Listings the hover keeps for one halt. */
const HOVER_LISTINGS = 200
/** How long a save waits, at most, for the file's text before it is written (to move its breakpoints). */
export const REMAP_READ_MS = 500
/** How long the save hook waits at all; Orca allows a hook 2 s. */
const REMAP_HOOK_MS = 1_000
/** How long after a save its text is looked for on disk, and how often, before its breakpoints move. */
const SAVE_WAIT_MS = 10_000
const SAVE_POLL_MS = 100

/** One save of a file waiting to move its breakpoints: the text it saved, as lines and joined. */
type SaveRemap = { lines: string[]; joined: string }
/** A file larger than this is not read to move its breakpoints: they stay where they are. */
const REMAP_MAX_BYTES = 4 * 1024 * 1024

/** A text cut to `max` characters with an ellipsis, never between the halves of a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)}…`
}

/** A file's text from the disk, or null past REMAP_MAX_BYTES. */
async function readTextFile(file: string): Promise<string | null> {
  if ((await stat(file)).size > REMAP_MAX_BYTES) return null
  return readFile(file, 'utf8')
}

/** An error the panel words by its code (the piece's `reason.*` texts, else core's). */
export class DebuggerError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export type DebuggerOptions = {
  coalesceMs?: number
  timeouts?: Parameters<typeof createSession>[0]['timeouts']
  platform?: string
  readDir?: ReadDir
  /** How a file is opened at a line; default src/core/open-file.ts. */
  openFile?: OpenFile
  /** How a script's lines are read for its source view; default the local disk. */
  sourceFs?: SourceFileSystem
  /** How a saved file's text before the save is read, to move its breakpoints; default the local disk. */
  readText?: (file: string) => Promise<string | null>
  /** How long, and how often, the file is looked at for a save's text before its breakpoints move. */
  saveWaitMs?: number
  savePollMs?: number
}

const STEP_KINDS: readonly StepKind[] = ['continue', 'over', 'in', 'out']

function codeOf(error: unknown): string {
  if (error instanceof DebuggerError || error instanceof SessionError || error instanceof BreakpointsError || error instanceof DapError || error instanceof SourceError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') return (error as { code: string }).code
  return 'action_failed'
}

/** Rethrows as an error whose only message is its code: never an adapter text or a path. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new DebuggerError(codeOf(error))
  }
}

export function activateDebugger(ctx: PieceContext, options: DebuggerOptions = {}): Disposable {
  const breakpoints = createBreakpoints(ctx.store)
  const open = options.openFile ?? createOpenFile({ log: ctx.log })
  const coalesceMs = options.coalesceMs ?? COALESCE_MS
  const platform = options.platform ?? process.platform
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  /** The last state posted, so the view can be told once that the session ended with the worker. */
  let lastPosted: DebuggerState | null = null
  /** The workspace the running session debugs; the breakpoints shown are its own while it runs. */
  let sessionWorkspace: Workspace | null = null
  /** The remaps of each saved file waiting their turn, by workspace and path, oldest first. */
  const remaps = new Map<string, { entries: SaveRemap[]; tail: Promise<void> }>()
  /** The hover's listings, kept for the halted stack they were read in. */
  let hoverCache: { frames: unknown; lists: Map<string, Promise<Variable[]>> } = { frames: null, lists: new Map() }
  /** The scripts of each workspace's cartridges, by folder, the newest last. */
  const filesCache = new Map<string, { at: number; files: Promise<{ files: string[]; truncated: boolean; cartridges: string[] }> }>()

  const session = createSession({
    b2c: ctx.b2c,
    log: ctx.log,
    platform: options.platform,
    timeouts: options.timeouts,
    unclean: {
      get: async () => (await ctx.store.get<boolean>(UNCLEAN_KEY, false)) === true,
      set: async (unclean) => (unclean ? ctx.store.set(UNCLEAN_KEY, true) : ctx.store.delete(UNCLEAN_KEY))
    },
    onChange: schedule
  })

  /** One post per window, carrying the state as it is when it is sent. */
  function schedule(): void {
    if (timer || disposed) return
    timer = setTimeout(() => {
      timer = null
      void current().then(
        (state) => {
          if (disposed) return
          lastPosted = state
          ctx.orca.panels.post('debugger.state', state)
        },
        () => {}
      )
    }, coalesceMs)
  }

  /** The sandbox's state in the dw.json of `configRoot` when named, else of the folder `configRoot()` names now. */
  async function sandboxState(configRoot?: string): Promise<RoleState> {
    try {
      return (await ctx.b2c.instances(configRoot === undefined ? {} : { configRoot })).instances.sandbox
    } catch {
      return 'absent'
    }
  }

  /** The workspace to debug now: the running session's, else the one the rule picks. */
  async function target(): Promise<{ workspace: Workspace | null; state: DebugWorkspaceState }> {
    const workspace = session.root && sessionWorkspace ? sessionWorkspace : await debugWorkspace(ctx.workspaces).catch(() => null)
    if (!workspace) return { workspace: null, state: 'none' }
    return isLocal(workspace) ? { workspace, state: 'ok' } : { workspace, state: 'remote' }
  }

  async function current(): Promise<DebuggerState> {
    const [{ workspace, state }, sandbox] = await Promise.all([target(), sandboxState()])
    const snapshot: SessionSnapshot = session.snapshot()
    const files: BreakpointFile[] = workspace && state === 'ok' ? await breakpoints.list(workspace.id) : []
    return {
      status: snapshot.status,
      reason: snapshot.reason,
      message: snapshot.message,
      sandbox,
      workspace: state,
      workspaceId: workspace && state === 'ok' ? workspace.id : null,
      breakpoints: files.map((file) => ({
        path: file.path,
        lines: file.lines.map((line) => ({ line, verified: snapshot.verified[file.path]?.find((each) => each.line === line)?.verified ?? null }))
      })),
      threads: snapshot.threads,
      threadId: snapshot.threadId,
      frames: snapshot.frames
    }
  }

  /** A local workspace to work on, or a DebuggerError. */
  async function localWorkspace(): Promise<Workspace> {
    const { workspace, state } = await target()
    if (!workspace || state !== 'ok') throw new DebuggerError('no_workspace')
    return workspace
  }

  /** The local workspace Orca lists under this id (the editor's own), or null. */
  async function workspaceById(workspaceId: unknown): Promise<Workspace | null> {
    if (typeof workspaceId !== 'string' || !workspaceId) return null
    const workspace = (await ctx.workspaces.list().catch((): Workspace[] => [])).find((each) => each.id === workspaceId) ?? null
    return workspace && isLocal(workspace) ? workspace : null
  }

  /**
   * Where a breakpoint request acts: the workspace the editor named, and then only on a script of
   * its cartridges; else the debugged one.
   */
  async function breakpointTarget(input: { workspaceId?: unknown } | undefined, path: string | null): Promise<Workspace> {
    if (input?.workspaceId === undefined) return localWorkspace()
    const workspace = await workspaceById(input.workspaceId)
    if (!workspace) throw new DebuggerError('no_workspace')
    if (path && !(await scriptable(workspace, path))) throw new DebuggerError('not_script')
    return workspace
  }

  /** Whether a session runs, or is starting, on this workspace. */
  function sessionOn(workspace: Workspace): boolean {
    const status = session.snapshot().status
    return (status === 'connecting' || status === 'attached' || status === 'halted') && sessionWorkspace?.id === workspace.id
  }

  async function scriptable(workspace: Workspace, path: string): Promise<boolean> {
    return isScriptPath(path, (await scriptsOf(workspace)).cartridges)
  }

  /** The editor's view of one file of a workspace (`debugger.file`). */
  async function fileState(input: { workspaceId?: unknown; path?: unknown } | undefined): Promise<DebuggerFileState> {
    const workspace = await workspaceById(input?.workspaceId)
    const path = normalizePath(input?.path)
    if (!workspace || !path) return { scriptable: false, session: 'none', lines: [], stopped: null }
    const snapshot = session.snapshot()
    const running = sessionOn(workspace)
    const lines = (await breakpoints.list(workspace.id)).find((file) => file.path === path)?.lines ?? []
    const verified = running ? snapshot.verified[path] : undefined
    let stopped: DebuggerFileState['stopped'] = null
    if (running && snapshot.status === 'halted') {
      // The topmost frame of the halt that is in this file: where it stopped, or a caller.
      const at = snapshot.frames.findIndex((frame) => session.frameLocation(frame.id)?.path === path)
      const frame = snapshot.frames[at]
      if (frame && frame.line > 0) stopped = { line: frame.line, name: frame.name, frameId: frame.id, top: at === 0 }
    }
    return {
      scriptable: await scriptable(workspace, path),
      session: running ? (snapshot.status as DebuggerFileState['session']) : 'none',
      lines: lines.map((line) => ({ line, verified: verified?.find((each) => each.line === line)?.verified ?? null })),
      stopped
    }
  }

  /**
   * The value of a plain read (inspect.ts) in a frame of the halt that is in this file; null for
   * anything else. Nothing is evaluated: its names are looked up one by one in the frame's scopes
   * (Local, Closure, Global, in the adapter's order) and then among each value's members, with the
   * `scopes` and `variables` requests the debugger's view makes when those names are expanded in
   * its tree, so a hover runs nothing that expanding them would not. A name the listing lacks
   * gives no value.
   */
  async function hover(input: { workspaceId?: unknown; path?: unknown; expression?: unknown; frameId?: unknown } | undefined): Promise<DebuggerHoverValue | null> {
    const read = plainRead(input?.expression)
    if (read === null) return null
    const workspace = await workspaceById(input?.workspaceId)
    const path = normalizePath(input?.path)
    const frameId = input?.frameId
    if (!workspace || !path || typeof frameId !== 'number' || !sessionOn(workspace)) return null
    const snapshot = session.snapshot()
    if (snapshot.status !== 'halted' || !snapshot.frames.some((frame) => frame.id === frameId) || session.frameLocation(frameId)?.path !== path) return null
    let found: Variable | null = null
    for (const scope of await listing({ frameId })) {
      if (scope.reference <= 0) continue
      found = (await listing({ reference: scope.reference })).find((each) => each.name === read.path[0]) ?? null
      if (found) break
    }
    for (const name of read.path.slice(1)) {
      if (!found || found.reference <= 0) return null
      found = (await listing({ reference: found.reference })).find((each) => each.name === name || each.name === `[${name}]`) ?? null
    }
    if (!found) return null
    // Masked and cut by the session; cut again to what a pop-up shows, never inside a surrogate pair.
    return { expression: read.expression, value: cutText(found.value, HOVER_MAX_TEXT), expandable: found.reference > 0 }
  }

  /**
   * A frame's scopes or a value's members for the hover, each asked of the adapter once per halt:
   * the listings are kept until the halted stack changes (a step, a continue, another halt), so
   * resting on names again asks nothing more of the instance. At most HOVER_LISTINGS are kept.
   */
  async function listing(input: { frameId: number } | { reference: number }): Promise<Variable[]> {
    const frames = session.snapshot().frames
    if (hoverCache.frames !== frames) hoverCache = { frames, lists: new Map() }
    const key = 'frameId' in input ? `f${input.frameId}` : `r${input.reference}`
    const kept = hoverCache.lists.get(key)
    if (kept) return kept
    const asked = session.variables(input)
    const cache = hoverCache
    cache.lists.set(key, asked)
    asked.catch(() => cache.lists.delete(key))
    if (cache.lists.size > HOVER_LISTINGS) cache.lists.delete(cache.lists.keys().next().value as string)
    return asked
  }

  /**
   * After a save from any editor tab: the file's breakpoints move with its text (line-diff.ts, the
   * file on disk before against the text saved), so the store, the session and every view agree
   * with what now runs. Read before Orca writes (the hook waits for it, `REMAP_READ_MS` at most);
   * nothing is changed or refused of the save itself. The store moves only once the file on disk
   * holds the text saved (looked at every `savePollMs`, for `saveWaitMs` at most): a save that
   * failed, or that another hook refused, moves nothing.
   *
   * The saves of one file are moved one after another (`remaps`): a save made while the one before
   * it waits takes that one's text as the file it starts from, and waits its turn; a save counts as
   * written once the disk holds its text or the text of a save after it (saves land in order).
   */
  async function remapOnSave(event: { workspaceId?: unknown; path?: unknown; text?: unknown } | undefined): Promise<void> {
    if (typeof event?.path !== 'string' || typeof event.text !== 'string') return
    const workspace = await savedWorkspace(event.workspaceId, event.path)
    if (!workspace) return
    const rel = relativeTo(workspace.path, event.path)
    if (!rel) return
    const key = `${workspace.id}\n${rel}`
    const file = (platform === 'win32' ? win32 : posix).join(workspace.path, ...rel.split('/'))
    let chain = remaps.get(key)
    let beforeLines: string[]
    const last = chain?.entries.at(-1)
    if (last) beforeLines = last.lines
    else {
      if (((await breakpoints.list(workspace.id)).find((each) => each.path === rel)?.lines ?? []).length === 0) return
      const before = await readOld(file)
      if (before === null) return
      beforeLines = textLines(before)
      chain = remaps.get(key)
      const raced = chain?.entries.at(-1)
      if (raced) beforeLines = raced.lines
    }
    const afterLines = textLines(event.text)
    const entry: SaveRemap = { lines: afterLines, joined: afterLines.join('\n') }
    if (!chain) {
      chain = { entries: [], tail: Promise.resolve() }
      remaps.set(key, chain)
    }
    const queue = chain
    queue.entries.push(entry)
    // The save need not wait for the store or the session: only the read had to come first.
    queue.tail = queue.tail
      .then(async () => {
        const lines = (await breakpoints.list(workspace.id)).find((each) => each.path === rel)?.lines ?? []
        const moved = remapLines(lines, beforeLines, afterLines)
        if (moved.length === lines.length && moved.every((line, i) => line === lines[i])) return
        if (!(await written(file, queue, entry))) return
        // A line removed meanwhile stays removed; one set meanwhile was set on the saved text and stays.
        const now = (await breakpoints.list(workspace.id)).find((each) => each.path === rel)?.lines ?? []
        const kept = remapLines(
          lines.filter((line) => now.includes(line)),
          beforeLines,
          afterLines
        )
        const files = await breakpoints.set(workspace.id, rel, [...kept, ...now.filter((line) => !lines.includes(line))])
        await synced(workspace.id, files.find((each) => each.path === rel) ?? { path: rel, lines: [] })
      })
      .catch((error: unknown) => ctx.log(`moving breakpoints after a save failed (${codeOf(error)})`))
      .finally(() => {
        queue.entries.splice(queue.entries.indexOf(entry), 1)
        if (queue.entries.length === 0 && remaps.get(key) === queue) remaps.delete(key)
      })
  }

  /** Whether line `line` (1-based) of a file on disk is `text`; true when the file cannot be read, so a slow disk never blocks a click. */
  async function lineHolds(workspace: Workspace, path: string, line: number, text: string): Promise<boolean> {
    const now = await readOld((platform === 'win32' ? win32 : posix).join(workspace.path, ...path.split('/')))
    return now === null || textLines(now)[line - 1] === text
  }

  /**
   * Whether the file on disk comes to hold the text of this save, or of a save of the file after
   * it (its lines, whatever their breaks), within the wait.
   */
  async function written(file: string, queue: { entries: SaveRemap[] }, entry: SaveRemap): Promise<boolean> {
    const until = Date.now() + (options.saveWaitMs ?? SAVE_WAIT_MS)
    for (;;) {
      if (disposed) return false
      const now = await readOld(file)
      const joined = now === null ? null : textLines(now).join('\n')
      if (joined !== null && queue.entries.slice(queue.entries.indexOf(entry)).some((each) => each.joined === joined)) return true
      if (Date.now() >= until) return false
      await new Promise((resolve) => setTimeout(resolve, options.savePollMs ?? SAVE_POLL_MS))
    }
  }

  /** The file as it is on disk now, or null when it cannot be read whole and in time. */
  async function readOld(file: string): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const read = (options.readText ?? readTextFile)(file)
      const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), REMAP_READ_MS)))
      return await Promise.race([read, late])
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** The local workspace a save names, by its id or by the folder that holds the file. */
  async function savedWorkspace(workspaceId: unknown, path: string): Promise<Workspace | null> {
    const workspaces = (await ctx.workspaces.list().catch((): Workspace[] => [])).filter(isLocal)
    const byId = typeof workspaceId === 'string' ? workspaces.find((each) => each.id === workspaceId) : undefined
    if (byId) return byId
    // `<project>::<folder>` as an editor tab names it, else the deepest folder that holds the file.
    const folder = typeof workspaceId === 'string' && workspaceId.includes('::') ? workspaceId.slice(workspaceId.indexOf('::') + 2) : null
    const fold = (value: string) => {
      const slashes = value.replace(/\\/g, '/').replace(/\/+$/, '')
      return platform === 'win32' ? slashes.toLowerCase() : slashes
    }
    if (folder) {
      const byFolder = workspaces.find((each) => fold(each.path) === fold(folder))
      if (byFolder) return byFolder
    }
    return workspaces.filter((each) => relativeTo(each.path, path) !== null).sort((a, b) => b.path.length - a.path.length)[0] ?? null
  }

  /** A saved file's path relative to a workspace's folder, `/` between parts; null outside it. */
  function relativeTo(root: string, file: string): string | null {
    const paths = platform === 'win32' ? win32 : posix
    if (!paths.isAbsolute(file)) return normalizePath(file)
    const rel = paths.relative(root, file)
    if (!rel || rel.startsWith('..') || paths.isAbsolute(rel)) return null
    return normalizePath(rel.split(paths.sep).join('/'))
  }

  /**
   * Starts a session unless one runs, without waiting for it to attach: `debugger.state` events
   * follow. Refuses when the sandbox is not ready or there is no local workspace.
   */
  async function start(): Promise<'started' | 'already'> {
    const status = session.snapshot().status
    if (status === 'connecting' || status === 'attached' || status === 'halted') return 'already'
    // The workspace is chosen once: its folder gives the cartridges and, named as `configRoot`,
    // the dw.json of every b2c call of the session, so a focus change meanwhile mixes nothing.
    const workspace = await localWorkspace()
    if ((await sandboxState(workspace.path)) !== 'ready') throw new DebuggerError('sandbox_not_ready')
    sessionWorkspace = workspace
    const files = await breakpoints.list(workspace.id)
    void session.start(workspace.path, files)
    return 'started'
  }

  async function stop(): Promise<void> {
    await session.stop()
    sessionWorkspace = null
  }

  function step(kind: StepKind, threadId?: number): void {
    if (!STEP_KINDS.includes(kind)) throw new DebuggerError('invalid_input')
    session.step(kind, typeof threadId === 'number' ? threadId : undefined)
  }

  /** Sends a changed file to a running session of that workspace. */
  async function synced(workspaceId: string, file: BreakpointFile): Promise<void> {
    if (session.root && sessionWorkspace?.id === workspaceId) await session.syncFile(file)
  }

  /** The scripts of a workspace's cartridges, read again once they are older than FILES_TTL_MS. */
  function scriptsOf(workspace: Workspace): Promise<{ files: string[]; truncated: boolean; cartridges: string[] }> {
    const kept = filesCache.get(workspace.path)
    if (kept && Date.now() - kept.at <= FILES_TTL_MS) return kept.files
    const fresh = { at: Date.now(), files: scriptFiles(workspace.path, options.readDir) }
    filesCache.delete(workspace.path)
    filesCache.set(workspace.path, fresh)
    while (filesCache.size > FILES_KEPT) filesCache.delete(filesCache.keys().next().value as string)
    return fresh.files
  }

  const word = (key: keyof (typeof messages)['en']) => ctx.t(messages, key)

  const disposables: Disposable[] = [
    breakpoints.onChange(() => schedule()),
    ctx.orca.panels.handle('debugger.state', () => guarded(current)),
    ctx.orca.panels.handle('debugger.start', () =>
      guarded(async () => {
        await start()
        return current()
      })
    ),
    ctx.orca.panels.handle('debugger.stop', () =>
      guarded(async () => {
        await stop()
        return current()
      })
    ),
    ctx.orca.panels.handle('debugger.setBreakpoints', (input) =>
      guarded(async () => {
        const workspace = await breakpointTarget(input, normalizePath(input?.path))
        const lines = Array.isArray(input?.lines) ? input.lines : []
        const files = await breakpoints.set(workspace.id, String(input?.path ?? ''), lines)
        const path = String(input?.path ?? '').replace(/\\/g, '/')
        await synced(workspace.id, files.find((file) => file.path === path) ?? { path, lines: [] })
        return current()
      })
    ),
    ctx.orca.panels.handle('debugger.breakpoint', (input) =>
      guarded(async () => {
        const path = normalizePath(input?.path)
        const line = input?.line
        if (!path) throw new DebuggerError('invalid_path')
        const workspace = await breakpointTarget(input, path)
        if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) throw new DebuggerError('invalid_input')
        // The editor says what it believes the line holds on disk: a line it has not seen saved is refused.
        if (input?.on === true && typeof input.text === 'string' && !(await lineHolds(workspace, path, line, input.text))) throw new DebuggerError('line_changed')
        const existing = (await breakpoints.list(workspace.id)).find((file) => file.path === path)?.lines ?? []
        const lines = input?.on === true ? [...existing, line] : existing.filter((each) => each !== line)
        const files = await breakpoints.set(workspace.id, path, lines)
        await synced(workspace.id, files.find((file) => file.path === path) ?? { path, lines: [] })
        return current()
      })
    ),
    ctx.orca.panels.handle('debugger.clearBreakpoints', () =>
      guarded(async () => {
        const workspace = await localWorkspace()
        const before = await breakpoints.list(workspace.id)
        await breakpoints.clear(workspace.id)
        for (const file of before) await synced(workspace.id, { path: file.path, lines: [] })
        return current()
      })
    ),
    ctx.orca.panels.handle('debugger.scripts', () =>
      guarded(async () => {
        const workspace = await localWorkspace()
        const all = await scriptsOf(workspace)
        return {
          cartridges: byCartridge(all.files, all.cartridges).map(({ path, files }) => ({ name: path.slice(path.lastIndexOf('/') + 1) || workspace.name, path, files })),
          truncated: all.truncated
        }
      })
    ),
    ctx.orca.panels.handle('debugger.source', (input) =>
      guarded(async () => {
        const workspace = await localWorkspace()
        const path = normalizePath(input?.path)
        // Only a script the walk of the cartridges found: never any other file of the workspace.
        if (!path || !(await scriptsOf(workspace)).files.includes(path)) throw new DebuggerError('invalid_path')
        const { lines, truncated } = await readSource(workspace.path, path, options.sourceFs)
        // Masked like anything else the panel shows, joined so it is masked once.
        let masked = lines.length === 0 ? [] : (await ctx.b2c.mask(lines.join('\n'))).split('\n')
        // Lines must keep their numbers: should masking ever join two, each is masked alone.
        if (masked.length !== lines.length) masked = await Promise.all(lines.map((line) => ctx.b2c.mask(line)))
        return { path, lines: masked, truncated }
      })
    ),
    // Observed only: never changes or refuses the save; waits at most REMAP_HOOK_MS for the read.
    ctx.orca.hooks.on('editor.save.before', async (event) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([remapOnSave(event), new Promise((resolve) => (timer = setTimeout(resolve, REMAP_HOOK_MS)))])
      } catch {
        // Whatever happens here, the save goes on.
      } finally {
        clearTimeout(timer)
      }
    }),
    ctx.orca.panels.handle('debugger.file', (input) => guarded(() => fileState(input))),
    ctx.orca.panels.handle('debugger.hover', (input) => guarded(() => hover(input))),
    ctx.orca.panels.handle('debugger.threads', () => guarded(() => session.threads())),
    ctx.orca.panels.handle('debugger.stack', (input) =>
      guarded(async () => {
        if (typeof input?.threadId !== 'number') throw new DebuggerError('invalid_input')
        return session.stack(input.threadId)
      })
    ),
    ctx.orca.panels.handle('debugger.variables', (input) => guarded(() => session.variables({ frameId: input?.frameId, reference: input?.reference }))),
    ctx.orca.panels.handle('debugger.evaluate', (input) =>
      guarded(() => session.evaluate(typeof input?.expression === 'string' ? input.expression : '', typeof input?.frameId === 'number' ? input.frameId : undefined))
    ),
    ctx.orca.panels.handle('debugger.step', (input) =>
      guarded(async () => {
        step(input?.kind, input?.threadId)
        return current()
      })
    ),
    ctx.orca.panels.handle('debugger.open', (input) =>
      guarded(async () => {
        const { workspace } = await target()
        if (!workspace || !isLocal(workspace)) throw new DebuggerError('no_workspace')
        if (typeof input?.frameId === 'number') {
          const location = session.frameLocation(input.frameId)
          if (!location) return { opened: false }
          return { opened: await openFile(open, ctx.orca.host, workspace, location) }
        }
        const path = normalizePath(input?.path)
        if (!path) throw new DebuggerError('invalid_path')
        return { opened: await openFile(open, ctx.orca.host, workspace, { path, line: typeof input?.line === 'number' ? input.line : null }) }
      })
    ),
    ctx.orca.commands.register('debugger.start', async () => {
      try {
        return word((await start()) === 'already' ? 'cmdAlready' : 'cmdConnecting')
      } catch (error) {
        return word(codeOf(error) === 'sandbox_not_ready' ? 'cmdSandboxNotReady' : 'cmdNoWorkspace')
      }
    }),
    ctx.orca.commands.register('debugger.stop', async () => {
      if (!session.root) return word('cmdNotRunning')
      await stop()
      return word('cmdStopped')
    }),
    ...(
      [
        ['debugger.continue', 'continue'],
        ['debugger.stepOver', 'over'],
        ['debugger.stepIn', 'in'],
        ['debugger.stepOut', 'out']
      ] as const
    ).map(([command, kind]) =>
      ctx.orca.commands.register(command, () => {
        try {
          step(kind)
          return word('cmdStepped')
        } catch {
          return word('cmdNotHalted')
        }
      })
    )
  ]

  return {
    /**
     * Writes the disconnect at once, so a halted request is released even if the worker goes
     * first, stops listening, and resolves once the adapter answered and closed. The worker's
     * deactivation waits for it, within its bound.
     */
    async dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      const disconnected = session.dispose()
      // One last post, so an open view never keeps showing a session that is gone; nothing after it.
      if (lastPosted && lastPosted.status !== 'idle') {
        const ended = session.snapshot()
        try {
          void Promise.resolve(
            ctx.orca.panels.post('debugger.state', {
              ...lastPosted,
              status: ended.status,
              reason: ended.reason,
              message: ended.message,
              threads: [],
              threadId: null,
              frames: [],
              breakpoints: lastPosted.breakpoints.map((file) => ({ ...file, lines: file.lines.map((each) => ({ ...each, verified: null })) }))
            })
          ).catch(() => {})
        } catch {
          // The panel may be gone already.
        }
        lastPosted = null
      }
      for (const disposable of disposables.reverse()) {
        try {
          await disposable.dispose()
        } catch {
          // Keep disposing the rest.
        }
      }
      await disconnected
    }
  }
}

export const piece: WorkerPiece = {
  id: 'debugger',
  activate: (ctx) => activateDebugger(ctx)
}
