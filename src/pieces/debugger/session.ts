// One debugging session over `b2c debug`, a debug adapter on stdin and stdout, on the sandbox only.
// What the spike S1 found shapes it:
//
// - The order is `initialize`, `launch {}` (its response and the `initialized` event, both), every
//   file's `setBreakpoints`, `configurationDone`; then the session reacts to events.
// - `stopped.reason` is always `breakpoint`, also after a step, and a step's response can arrive
//   seconds after its `stopped` event: the state follows events, never responses.
// - A breakpoint takes the absolute local path of its file, so the adapter runs in the workspace's
//   folder and every path is joined to it here; the store keeps them relative.
// - Killed without `disconnect`, a halted request is not released and the debugger client stays
//   on the instance. So every way out disconnects first, and a flag in storage remembers a session
//   that did not end cleanly: the next start runs a cleanup session (`launch`, `disconnect`).
// - The adapter names the host (`Connected to …`) and variable values can hold customer data:
//   every text it sends goes through `b2c.mask` before it is kept, and values are fetched on
//   demand, answered and never kept.
import { posix, win32 } from 'node:path'
import type { B2c, Running } from '../../core/b2c'
import { B2cError } from '../../core/b2c'
import { DEBUGGER_CLIENT_ID } from '../../core/instances'
import type { Logger } from '../../core/piece'
import type { BreakpointFile } from './breakpoints'
import { createDapClient, DapError, type DapClient, type DapEvent } from './dap-client'
import type { Frame, SessionStatus, StepKind, Thread, Variable, VerifiedLine } from './protocol'

export type { Frame, SessionStatus, StepKind, Thread, Variable, VerifiedLine }

export type SessionSnapshot = {
  status: SessionStatus
  /**
   * Why the session failed or ended, as a code the panel words: a runner code
   * (`credentials_missing`, `b2c_not_found`, …), `launch_failed`, `adapter_exited`, `timeout`,
   * `terminated`. Null otherwise.
   */
  reason: string | null
  /** The adapter's own words for it, masked. */
  message: string | null
  threads: Thread[]
  /** The thread whose stack is shown: the one that stopped last, or the one picked. */
  threadId: number | null
  frames: Frame[]
  /** Whether the adapter accepted each line, by path, for the files sent this session. */
  verified: Record<string, VerifiedLine[]>
}

export type CleanFlag = { get(): Promise<boolean>; set(unclean: boolean): Promise<void> }

export type SessionDeps = {
  b2c: Pick<B2c, 'start' | 'mask'>
  log: Logger
  /** Set while a debugger client may exist on the instance; cleared after a confirmed disconnect. */
  unclean: CleanFlag
  onChange(): void
  platform?: string
  timeouts?: Partial<Timeouts>
}

type Timeouts = { requestMs: number; launchMs: number; disconnectMs: number; exitMs: number }
const DEFAULT_TIMEOUTS: Timeouts = { requestMs: 30_000, launchMs: 60_000, disconnectMs: 10_000, exitMs: 3_000 }

/** What the panel may be sent of one text: masked, and cut to this length. */
const MAX_TEXT = 2_000
const MAX_FRAMES = 64
const MAX_THREADS = 50
const MAX_VARIABLES = 200
const MAX_EXPRESSION = 2_000

/** A request refused because the session is not in a state that allows it. */
export class SessionError extends Error {
  constructor(readonly code: 'not_running' | 'not_halted' | 'invalid_input' | 'request_failed') {
    super(code)
  }
}

/** A start that `stop()` or `dispose()` overtook: it writes nothing more and reports nothing. */
class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

type Connection = {
  running: Running
  client: DapClient
  /** Whether `launch` was ever written: from then on a debugger client may exist on the instance. */
  launched: boolean
  /** The `launch` still waiting for its answer: a disconnect waits for it, or it could land first. */
  launching: Promise<unknown> | null
  /** Set once `close` began, so every caller shares the one close. */
  closing: Promise<boolean> | null
  /** The last line b2c wrote on stderr, masked by the runner: why it ended before speaking. */
  lastStderr: string | null
  /** The last `important` or `stderr` output event of the adapter, masked. */
  lastOutput: string | null
  alive: boolean
  waitEvent(name: string, timeoutMs: number): Promise<void>
}

/** Whether `promise` settled within `ms`; the timer never outlives it. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

function cut(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

export function createSession(deps: SessionDeps) {
  const timeouts: Timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts }
  const paths = (deps.platform ?? process.platform) === 'win32' ? win32 : posix
  // The whole text is masked before it is cut: a value cut in two would no longer match the masker.
  const mask = async (text: string) => cut(await deps.b2c.mask(text))

  let root: string | null = null
  let conn: Connection | null = null
  let stopping: Promise<void> | null = null
  /** Every adapter started and not yet closed, the cleanup session's included. */
  const opened = new Set<Connection>()
  /** Raised by every start, stop and dispose: a start whose number is no longer this one stops. */
  let attempt = 0
  /** The start under way, so a stop or a dispose can wait for it to wind down. */
  let starting: Promise<SessionSnapshot> | null = null
  let disposed = false
  let state: SessionSnapshot = empty('idle')
  const halted = new Set<number>()
  /** Each frame's path in the workspace, as the adapter gave it, to open it; kept only while the session runs. */
  let framePaths = new Map<number, string>()
  /** Raised on every stop and step, so an answer that arrives late never shows an old stack. */
  let generation = 0

  function empty(status: SessionStatus): SessionSnapshot {
    return { status, reason: null, message: null, threads: [], threadId: null, frames: [], verified: {} }
  }

  function update(patch: Partial<SessionSnapshot>): void {
    state = { ...state, ...patch }
    deps.onChange()
  }

  const running = () => state.status === 'attached' || state.status === 'halted'
  /** The status now: events change it while a start awaits, which narrowing cannot see. */
  const statusNow = (): SessionStatus => state.status

  // -------------------------------------------------------------------------------------------
  // Paths

  /** The absolute path the adapter needs for a path of the store. */
  function absolute(relative: string): string {
    return paths.join(root ?? '', ...relative.split('/'))
  }

  /** A path the adapter sent, as the store keeps it: relative to the workspace, or null outside it. */
  function relative(path: string): string | null {
    if (!root || !path) return null
    const rel = paths.relative(root, path)
    // On Windows `relative` already ignores letter case, as the file system does.
    if (!rel || rel === '..' || rel.startsWith(`..${paths.sep}`) || paths.isAbsolute(rel)) return null
    return rel.split(paths.sep).join('/')
  }

  // -------------------------------------------------------------------------------------------
  // The process

  async function open(cwd: string, onEvent: (event: DapEvent, connection: Connection) => void): Promise<Connection> {
    const eventWaiters = new Map<string, Array<() => void>>()
    let connection: Connection | null = null
    let client: DapClient | null = null
    const early: Uint8Array[] = []
    const running = await deps.b2c.start(['debug', '--client-id', DEBUGGER_CLIENT_ID], {
      role: 'sandbox',
      cwd,
      // stdout is the protocol and nothing else; stderr is b2c's log, masked by the runner.
      onStdout: (chunk) => (client ? client.receive(chunk) : early.push(chunk)),
      onEvent: (event) => {
        const text = 'text' in event ? event.text : asText(asRecord(event.json).message ?? asRecord(event.json).msg)
        if (text.trim() && connection) connection.lastStderr = cut(text.trim())
      }
    })
    client = createDapClient({
      write: (bytes) => running.write(bytes),
      defaultTimeoutMs: timeouts.requestMs,
      // Only how many: what was dropped could hold anything.
      onDropped: (count) => {
        if (count === 1 || count % 100 === 0) deps.log(`dropped ${count} malformed frame(s) from the adapter`)
      },
      onEvent: (event) => {
        for (const resolve of eventWaiters.get(event.event) ?? []) resolve()
        eventWaiters.delete(event.event)
        if (connection) onEvent(event, connection)
      }
    })
    connection = {
      running,
      client,
      launched: false,
      launching: null,
      closing: null,
      lastStderr: null,
      lastOutput: null,
      alive: true,
      waitEvent(name, timeoutMs) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new DapError('timeout', name)), timeoutMs)
          const list = eventWaiters.get(name) ?? []
          list.push(() => {
            clearTimeout(timer)
            resolve()
          })
          eventWaiters.set(name, list)
          void running.exited.then(() => {
            clearTimeout(timer)
            reject(new DapError('closed', name))
          })
        })
      }
    }
    for (const chunk of early.splice(0)) client.receive(chunk)
    opened.add(connection)
    const self = connection
    void running.exited.then(() => {
      self.alive = false
      self.client.close()
    })
    return connection
  }

  /** Writes `launch` and remembers it is in flight, so a disconnect never overtakes it. */
  function launch(connection: Connection): Promise<unknown> {
    connection.launched = true
    const answer = connection.client.request('launch', {}, { timeoutMs: timeouts.launchMs })
    connection.launching = answer
    const settled = () => {
      if (connection.launching === answer) connection.launching = null
    }
    answer.then(settled, settled)
    return answer
  }

  /**
   * Closes an adapter, once whoever asks: a disconnect if it ever launched (after that launch is
   * answered, so the disconnect cannot land first), then stdin, then a moment for it to exit before
   * it is stopped. The disconnect is written before the first await when no launch is in flight.
   * When it launched, the disconnect was answered and no other launched adapter is still open,
   * the unclean-end flag is cleared. Answers whether it left nothing on the instance.
   */
  function close(connection: Connection): Promise<boolean> {
    if (connection.closing) return connection.closing
    connection.closing = (async () => {
      let clean = !connection.launched
      if (connection.launched && connection.alive) {
        if (connection.launching) await connection.launching.catch(() => {})
        try {
          await connection.client.request('disconnect', { terminateDebuggee: false }, { timeoutMs: timeouts.disconnectMs })
          clean = true
        } catch (error) {
          deps.log(`disconnect failed (${error instanceof DapError ? error.code : 'error'})`)
        }
      }
      connection.running.end()
      if (!(await within(connection.running.exited, timeouts.exitMs))) connection.running.stop()
      connection.client.close()
      opened.delete(connection)
      if (clean && connection.launched && ![...opened].some((other) => other.launched)) await deps.unclean.set(false)
      return clean
    })()
    return connection.closing
  }

  /** Closes every adapter open now; each disconnect is written before this awaits anything. */
  function closeAll(): Promise<boolean[]> {
    return Promise.all([...opened].map((connection) => close(connection)))
  }

  /**
   * A session of its own that only replaces the debugger client a session left on the instance:
   * `launch` deletes any client with the same id before it creates its own, and `disconnect`
   * deletes that one, which clears the flag. Whatever goes wrong here, the real start goes on and
   * says it; a stop or a dispose ends it where it stands (`live` throws).
   */
  async function cleanup(cwd: string, live: () => void): Promise<void> {
    deps.log('cleaning up after a session that did not end cleanly')
    let connection: Connection | null = null
    try {
      connection = await open(cwd, () => {})
      live()
      await connection.client.request('initialize', initializeArguments())
      live()
      await launch(connection)
    } catch (error) {
      if (!(error instanceof Cancelled)) deps.log(`cleanup failed (${codeOf(error)})`)
    } finally {
      if (connection) await close(connection)
    }
  }

  function initializeArguments() {
    return { clientID: 'orca-sfcc-tools', clientName: 'SFCC Tools for Orca', adapterID: 'b2c', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' }
  }

  function codeOf(error: unknown): string {
    if (error instanceof B2cError) return error.code
    if (error instanceof DapError) return error.code
    if (error instanceof SessionError) return error.code
    return 'error'
  }

  // -------------------------------------------------------------------------------------------
  // Events: what drives the state

  function onEvent(event: DapEvent, connection: Connection): void {
    if (connection !== conn) return
    const body = asRecord(event.body)
    switch (event.event) {
      case 'stopped': {
        const threadId = asNumber(body.threadId)
        if (threadId === null) return
        halted.add(threadId)
        generation += 1
        update({ status: 'halted', threadId, frames: [] })
        void refreshHalted(threadId, generation)
        return
      }
      case 'continued': {
        const threadId = asNumber(body.threadId)
        if (body.allThreadsContinued === true) halted.clear()
        else if (threadId !== null) halted.delete(threadId)
        released()
        return
      }
      case 'thread': {
        const threadId = asNumber(body.threadId)
        if (body.reason === 'exited' && threadId !== null && halted.delete(threadId)) released()
        return
      }
      case 'output': {
        const category = asText(body.category)
        const output = asText(body.output).trim()
        if (!output || !['important', 'stderr'].includes(category)) return
        void mask(output).then((masked) => {
          connection.lastOutput = masked
        })
        return
      }
      case 'terminated': {
        if (stopping || !running()) return
        // The instance ended it: the script debugger was turned off, or the client expired.
        void endedByAdapter(connection, 'terminated')
        return
      }
      default:
        return
    }
  }

  /** A thread went on: back to attached when none is halted, else to the next halted one. */
  function released(): void {
    if (state.status !== 'halted') return
    generation += 1
    const next = [...halted].at(-1)
    if (next === undefined) {
      framePaths = new Map()
      update({ status: 'attached', threadId: null, frames: [], threads: state.threads.map((thread) => ({ ...thread, halted: false })) })
    } else {
      update({ threadId: next, frames: [] })
      void refreshHalted(next, generation)
    }
  }

  async function refreshHalted(threadId: number, at: number): Promise<void> {
    try {
      const [threads, frames] = await Promise.all([fetchThreads(), fetchStack(threadId)])
      if (at !== generation || state.status !== 'halted') return
      update({ threads, frames, threadId })
    } catch (error) {
      deps.log(`reading the halted thread failed (${codeOf(error)})`)
    }
  }

  async function endedByAdapter(connection: Connection, reason: string): Promise<void> {
    if (conn !== connection) return
    conn = null
    halted.clear()
    framePaths = new Map()
    const message = connection.lastOutput
    await close(connection)
    update({ ...empty('ended'), reason, message })
  }

  function onExit(connection: Connection, exit: { exitCode: number | null; reason?: string }): void {
    if (conn !== connection || stopping) return
    conn = null
    halted.clear()
    framePaths = new Map()
    // The adapter went away by itself: whatever it held on the instance may still be there.
    update({ ...empty('failed'), reason: exit.reason ?? 'adapter_exited', message: connection.lastOutput ?? connection.lastStderr })
  }

  // -------------------------------------------------------------------------------------------
  // Requests

  async function fetchThreads(): Promise<Thread[]> {
    const client = conn?.client
    if (!client) throw new SessionError('not_running')
    const body = asRecord(await client.request('threads'))
    const threads: Thread[] = []
    for (const item of asArray(body.threads).slice(0, MAX_THREADS)) {
      const thread = asRecord(item)
      const id = asNumber(thread.id)
      // Thread 0 is the adapter's placeholder while no script runs.
      if (id === null || id === 0) continue
      threads.push({ id, name: await mask(asText(thread.name) || `#${id}`), halted: halted.has(id) })
    }
    return threads.sort((a, b) => Number(b.halted) - Number(a.halted) || a.id - b.id)
  }

  async function fetchStack(threadId: number): Promise<Frame[]> {
    const client = conn?.client
    if (!client) throw new SessionError('not_running')
    const body = asRecord(await client.request('stackTrace', { threadId, startFrame: 0, levels: MAX_FRAMES }))
    const frames: Frame[] = []
    for (const item of asArray(body.stackFrames).slice(0, MAX_FRAMES)) {
      const frame = asRecord(item)
      const id = asNumber(frame.id)
      if (id === null) continue
      const source = asRecord(frame.source)
      const full = asText(source.path)
      const rel = full ? relative(full) : null
      if (rel) framePaths.set(id, rel)
      const fileName = asText(source.name) || (full ? paths.basename(full) : '')
      frames.push({
        id,
        name: await mask(asText(frame.name)),
        // A source the adapter could not map is named by its server path: only its last part is shown.
        file: await mask(fileName.split(/[\\/]/).filter(Boolean).at(-1) ?? ''),
        line: asNumber(frame.line) ?? 0,
        path: rel === null ? null : await mask(rel)
      })
    }
    return frames
  }

  async function sendFile(file: BreakpointFile): Promise<void> {
    const client = conn?.client
    if (!client) return
    const body = asRecord(
      await client.request('setBreakpoints', {
        source: { path: absolute(file.path) },
        breakpoints: file.lines.map((line) => ({ line })),
        lines: file.lines
      })
    )
    const answered = asArray(body.breakpoints)
    const verified = { ...state.verified }
    if (file.lines.length === 0) delete verified[file.path]
    else verified[file.path] = file.lines.map((line, i) => ({ line, verified: asRecord(answered[i]).verified === true }))
    update({ verified })
  }

  return {
    snapshot(): SessionSnapshot {
      return state
    },

    /** The workspace folder the running session debugs, or null. */
    get root(): string | null {
      return conn ? root : null
    },

    /**
     * Starts a session in `cwd` (the workspace's folder) with `files` as its breakpoints. Answers
     * once it is attached or failed; never throws.
     */
    async start(cwd: string, files: readonly BreakpointFile[]): Promise<SessionSnapshot> {
      if (disposed) {
        deps.log('start refused: the worker is stopping')
        return state
      }
      if (state.status === 'connecting' || running()) return state
      if (stopping) await stopping
      if (disposed || statusNow() === 'connecting' || running()) return state
      const token = ++attempt
      /** Throws once a stop or a dispose overtook this start: from then on it writes nothing. */
      const live = () => {
        if (token !== attempt || disposed) throw new Cancelled()
      }
      root = cwd
      halted.clear()
      framePaths = new Map()
      update(empty('connecting'))
      const run = async (): Promise<SessionSnapshot> => {
        let connection: Connection | null = null
        try {
          if (await deps.unclean.get()) {
            live()
            await cleanup(cwd, live)
          }
          live()
          connection = await open(cwd, onEvent)
          const self = connection
          void connection.running.exited.then((exit) => onExit(self, exit))
          live()
          conn = connection
          await connection.client.request('initialize', initializeArguments())
          live()
          // From here a debugger client may exist on the instance until a disconnect is answered.
          await deps.unclean.set(true)
          live()
          const initialized = connection.waitEvent('initialized', timeouts.launchMs)
          initialized.catch(() => {})
          await launch(connection)
          live()
          await initialized
          for (const file of files) {
            live()
            await sendFile(file)
          }
          live()
          await connection.client.request('configurationDone')
          live()
          if (conn === connection && statusNow() === 'connecting') update({ status: 'attached' })
          return state
        } catch (error) {
          if (error instanceof Cancelled || token !== attempt || disposed) {
            // The stop or dispose that overtook this start owns the state; what it opened is closed.
            if (connection) await close(connection)
            return state
          }
          // The adapter ended by itself, and that was already said.
          if (connection && conn !== connection && statusNow() === 'failed') return state
          conn = null
          const reason =
            error instanceof B2cError ? error.code : error instanceof DapError ? (error.code === 'refused' ? 'launch_failed' : error.code === 'timeout' ? 'timeout' : 'adapter_exited') : 'start_failed'
          let message: string | null = null
          if (error instanceof DapError && error.detail) message = await mask(error.detail)
          else if (connection) message = connection.lastOutput ?? connection.lastStderr
          deps.log(`start failed (${reason})`)
          if (connection) await close(connection)
          update({ ...empty('failed'), reason, message })
          return state
        }
      }
      const current = run()
      starting = current
      try {
        return await current
      } finally {
        if (starting === current) starting = null
      }
    },

    /**
     * Disconnects (which releases a halted request), closes the adapter and answers once it ended.
     * A start under way is overtaken: it writes nothing more, and what it opened is closed. Ends
     * with `disconnect_unconfirmed` when the instance may still hold the debugger client (a
     * disconnect got no answer), which the next start cleans up.
     */
    async stop(): Promise<SessionSnapshot> {
      if (stopping) {
        await stopping
        return state
      }
      attempt += 1
      const pending = starting
      if (opened.size === 0 && !pending) {
        if (state.status !== 'failed' && state.status !== 'ended') update(empty('idle'))
        return state
      }
      conn = null
      const closing = closeAll()
      const done = (async () => {
        await closing
        if (pending) await pending.catch(() => {})
      })()
      stopping = done
      try {
        await done
      } finally {
        if (stopping === done) stopping = null
        halted.clear()
        framePaths = new Map()
        const unconfirmed = await deps.unclean.get().catch(() => true)
        update({ ...empty('ended'), reason: unconfirmed ? 'disconnect_unconfirmed' : null })
      }
      return state
    },

    /**
     * The worker is going away: disconnect now. Each disconnect is written before this returns
     * (an adapter whose launch is still unanswered waits for that answer first), so it reaches the
     * adapter even if the worker goes first; the promise resolves once every adapter closed and a
     * start under way wound down. Any later start is refused. If it never completes, the flag stays
     * set and the next start cleans up.
     */
    dispose(): Promise<void> {
      disposed = true
      attempt += 1
      conn = null
      const pending = starting
      const closing = closeAll()
      const done = (async () => {
        await closing
        if (pending) await pending.catch(() => {})
      })().finally(() => {
        if (stopping === done) stopping = null
      })
      stopping = done
      return done
    },

    /** Sends one file's lines to the running adapter; nothing to do when no session runs. */
    async syncFile(file: BreakpointFile): Promise<void> {
      if (!running()) return
      try {
        await sendFile(file)
      } catch (error) {
        deps.log(`setting breakpoints failed (${codeOf(error)})`)
      }
    },

    async threads(): Promise<Thread[]> {
      if (!running()) throw new SessionError('not_running')
      const threads = await fetchThreads()
      update({ threads })
      return threads
    },

    /** The stack of a thread, which becomes the one shown. */
    async stack(threadId: number): Promise<Frame[]> {
      if (!running()) throw new SessionError('not_running')
      const at = ++generation
      const frames = await fetchStack(threadId)
      if (at === generation) update({ threadId, frames })
      return frames
    },

    /** A frame's scopes (`frameId`), or the children of a scope or variable (`reference`). */
    async variables(input: { frameId?: number; reference?: number }): Promise<Variable[]> {
      if (state.status !== 'halted' || !conn) throw new SessionError('not_halted')
      if (typeof input.frameId === 'number') {
        const body = asRecord(await conn.client.request('scopes', { frameId: input.frameId }))
        const scopes: Variable[] = []
        for (const item of asArray(body.scopes).slice(0, MAX_VARIABLES)) {
          const scope = asRecord(item)
          scopes.push({ name: await mask(asText(scope.name)), value: '', reference: asNumber(scope.variablesReference) ?? 0, expensive: scope.expensive === true })
        }
        return scopes
      }
      if (typeof input.reference === 'number' && input.reference > 0) {
        const body = asRecord(await conn.client.request('variables', { variablesReference: input.reference }))
        const variables: Variable[] = []
        for (const item of asArray(body.variables).slice(0, MAX_VARIABLES)) {
          const variable = asRecord(item)
          variables.push({
            name: await mask(asText(variable.name)),
            value: await mask(asText(variable.value)),
            reference: asNumber(variable.variablesReference) ?? 0,
            expensive: false
          })
        }
        return variables
      }
      throw new SessionError('invalid_input')
    },

    /** Evaluates an expression in a frame of the halted thread; the answer is masked, never kept. */
    async evaluate(expression: string, frameId: number | undefined): Promise<{ result: string; reference: number }> {
      if (state.status !== 'halted' || !conn) throw new SessionError('not_halted')
      if (!expression.trim() || expression.length > MAX_EXPRESSION) throw new SessionError('invalid_input')
      const args: Record<string, unknown> = { expression, context: 'repl' }
      if (typeof frameId === 'number') args.frameId = frameId
      try {
        const body = asRecord(await conn.client.request('evaluate', args))
        return { result: await mask(asText(body.result)), reference: asNumber(body.variablesReference) ?? 0 }
      } catch (error) {
        // The adapter's own answer to a bad expression is shown as the result.
        if (error instanceof DapError && error.code === 'refused' && error.detail) return { result: await mask(error.detail), reference: 0 }
        throw error
      }
    },

    /**
     * Continue or step a halted thread. The request is sent and not waited for: the thread counts
     * as running at once, and the next `stopped` event halts it again.
     */
    step(kind: StepKind, threadId?: number): void {
      if (state.status !== 'halted' || !conn) throw new SessionError('not_halted')
      const thread = threadId ?? state.threadId
      if (thread === null || thread === undefined) throw new SessionError('invalid_input')
      const command = { continue: 'continue', over: 'next', in: 'stepIn', out: 'stepOut' }[kind]
      conn.client.request(command, { threadId: thread }, { timeoutMs: 0 }).catch((error) => deps.log(`${command} failed (${codeOf(error)})`))
      halted.delete(thread)
      released()
    },

    /** The path (relative to the workspace) and line of a frame inside it, to open it; null otherwise. */
    frameLocation(frameId: number): { path: string; line: number } | null {
      const path = framePaths.get(frameId)
      const frame = state.frames.find((each) => each.id === frameId)
      return path && frame ? { path, line: frame.line } : null
    }
  }
}

export type Session = ReturnType<typeof createSession>
