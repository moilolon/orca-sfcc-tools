// The debugger piece's worker half, listed in src/worker/pieces.ts: the `debugger.*` requests, the
// debugging commands, and the `debugger.state` event, coalesced so a burst of adapter events
// reaches the panel as one post. A session runs on the sandbox only, in the debugged workspace's
// folder (src/pieces/debugger/workspace.ts), and is always disconnected on stop and when the
// worker goes away.
import type { RoleState } from '../../core/instances'
import type { Disposable, PieceContext, Workspace, WorkerPiece } from '../../core/piece'
import { createBreakpoints, BreakpointsError, normalizePath, type BreakpointFile } from './breakpoints'
import { byCartridge, isScriptPath, scriptFiles, type ReadDir } from './files'
import { plainRead } from './inspect'
import { readSource, SourceError, type SourceFileSystem } from './source'
import { messages } from './i18n'
import type { DebuggerFileState, DebuggerHoverValue, DebuggerState, DebugWorkspaceState, StepKind } from './protocol'
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
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  /** The last state posted, so the view can be told once that the session ended with the worker. */
  let lastPosted: DebuggerState | null = null
  /** The workspace the running session debugs; the breakpoints shown are its own while it runs. */
  let sessionWorkspace: Workspace | null = null
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

  async function sandboxState(): Promise<RoleState> {
    try {
      return (await ctx.b2c.instances()).instances.sandbox
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
   * A plain read (inspect.ts) in a frame of the halt that is in this file; null for anything else.
   * Only the expression inspect.ts rebuilt is sent, so nothing with a side effect reaches the adapter.
   */
  async function hover(input: { workspaceId?: unknown; path?: unknown; expression?: unknown; frameId?: unknown } | undefined): Promise<DebuggerHoverValue | null> {
    const expression = plainRead(input?.expression)
    if (expression === null) return null
    const workspace = await workspaceById(input?.workspaceId)
    const path = normalizePath(input?.path)
    const frameId = input?.frameId
    if (!workspace || !path || typeof frameId !== 'number' || !sessionOn(workspace)) return null
    const snapshot = session.snapshot()
    if (snapshot.status !== 'halted' || !snapshot.frames.some((frame) => frame.id === frameId) || session.frameLocation(frameId)?.path !== path) return null
    // Masked and cut by the session; cut again to what a pop-up shows.
    const answer = await session.evaluate(expression, frameId)
    const value = answer.result.length > HOVER_MAX_TEXT ? `${answer.result.slice(0, HOVER_MAX_TEXT)}…` : answer.result
    return { expression, value, expandable: answer.reference > 0 }
  }

  /**
   * Starts a session unless one runs, without waiting for it to attach: `debugger.state` events
   * follow. Refuses when the sandbox is not ready or there is no local workspace.
   */
  async function start(): Promise<'started' | 'already'> {
    const status = session.snapshot().status
    if (status === 'connecting' || status === 'attached' || status === 'halted') return 'already'
    if ((await sandboxState()) !== 'ready') throw new DebuggerError('sandbox_not_ready')
    const workspace = await localWorkspace()
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
