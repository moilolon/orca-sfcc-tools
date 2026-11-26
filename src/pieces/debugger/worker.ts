// The debugger piece's worker half, listed in src/worker/pieces.ts: the `debugger.*` requests, the
// debugging commands, and the `debugger.state` event, coalesced so a burst of adapter events
// reaches the panel as one post. A session runs on the sandbox only, in the debugged workspace's
// folder (src/pieces/debugger/workspace.ts), and is always disconnected on stop and when the
// worker goes away.
import type { RoleState } from '../../core/instances'
import type { Disposable, PieceContext, Workspace, WorkerPiece } from '../../core/piece'
import { createBreakpoints, BreakpointsError, normalizePath, type BreakpointFile } from './breakpoints'
import { matchFiles, scriptFiles, type ReadDir } from './files'
import { messages } from './i18n'
import type { DebuggerState, DebugWorkspaceState, StepKind } from './protocol'
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
}

const STEP_KINDS: readonly StepKind[] = ['continue', 'over', 'in', 'out']

function codeOf(error: unknown): string {
  if (error instanceof DebuggerError || error instanceof SessionError || error instanceof BreakpointsError || error instanceof DapError) return error.code
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
  let filesCache: { root: string; at: number; files: Promise<{ files: string[]; truncated: boolean }> } | null = null

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
        const workspace = await localWorkspace()
        const lines = Array.isArray(input?.lines) ? input.lines : []
        const files = await breakpoints.set(workspace.id, String(input?.path ?? ''), lines)
        const path = String(input?.path ?? '').replace(/\\/g, '/')
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
    ctx.orca.panels.handle('debugger.files', (input) =>
      guarded(async () => {
        const workspace = await localWorkspace()
        if (!filesCache || filesCache.root !== workspace.path || Date.now() - filesCache.at > FILES_TTL_MS) {
          filesCache = { root: workspace.path, at: Date.now(), files: scriptFiles(workspace.path, options.readDir) }
        }
        const all = await filesCache.files
        const found = matchFiles(all.files, typeof input?.query === 'string' ? input.query.slice(0, 200) : '')
        return { files: found.files, truncated: found.truncated || (all.truncated && found.files.length > 0) }
      })
    ),
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
