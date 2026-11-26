// For the tests only: a scripted stand-in for `b2c debug`. It reads the frames the session writes
// on stdin, answers them as the real adapter did in the spike S1 (values invented), and lets a
// test push events, cut stdout into chunks, delay a response or end the process. Its `mask`
// replaces the invented host and home folder as the runner would. No b2c ever runs.
import type { B2c, Exit, Running, StartOptions } from '../../core/b2c'
import { createFrameReader, encodeFrame, type DapRequest } from './dap-client'

export const FAKE_HOST = 'sandbox-01.example.com'
export const FAKE_HOME = '/home/someone'
export const FAKE_ROOT = '/home/someone/work/shop'
/** A value of a variable that must be masked: the invented host inside a URL. */
export const FAKE_SECRET_VALUE = `https://${FAKE_HOST}/on/demandware.store/Sites-Example-Site`

export type Reply = { body?: unknown; fail?: string } | 'none'
export type Handler = (request: DapRequest, process: FakeProcess) => Reply | Promise<Reply>

export class FakeProcess {
  readonly requests: DapRequest[] = []
  ended = false
  stopped = false
  exitCode: number | null = null
  private resolveExit: (exit: Exit) => void = () => {}
  readonly exited: Promise<Exit>
  private seq = 1000
  /** Bytes per stdout chunk; 0 sends each frame whole. */
  chunkSize = 0

  constructor(
    readonly args: readonly string[],
    readonly options: StartOptions,
    readonly adapter: FakeAdapter
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
  }

  get commands(): string[] {
    return this.requests.map((request) => request.command)
  }

  /** Writes a message on stdout, whole or cut into `chunkSize` pieces. */
  send(message: object): void {
    if (this.exitCode !== null || this.stopped) return
    const frame = encodeFrame({ seq: ++this.seq, ...message })
    if (!this.chunkSize) {
      this.options.onStdout?.(frame)
      return
    }
    for (let i = 0; i < frame.length; i += this.chunkSize) this.options.onStdout?.(frame.subarray(i, i + this.chunkSize))
  }

  event(event: string, body?: unknown): void {
    this.send(body === undefined ? { type: 'event', event } : { type: 'event', event, body })
  }

  respond(request: DapRequest, reply: { body?: unknown; fail?: string }): void {
    const base = { type: 'response', request_seq: request.seq, command: request.command }
    this.send(reply.fail !== undefined ? { ...base, success: false, message: reply.fail } : { ...base, success: true, ...(reply.body === undefined ? {} : { body: reply.body }) })
  }

  /** A line of b2c's stderr, as the runner hands it over (already masked there). */
  stderr(text: string): void {
    this.options.onEvent?.({ text })
  }

  exit(code: number | null = 0, reason?: Exit['reason']): void {
    if (this.exitCode !== null || this.stopped) return
    this.exitCode = code
    this.resolveExit(reason ? { exitCode: code, stopped: false, reason } : { exitCode: code, stopped: false })
  }

  readonly reader = createFrameReader((message) => {
    if (message.type !== 'request') return
    this.requests.push(message)
    void this.adapter.answer(message, this)
  })

  running(): Running {
    return {
      exited: this.exited,
      write: (data) => {
        if (this.ended || this.exitCode !== null || this.stopped) return false
        this.reader.push(typeof data === 'string' ? new TextEncoder().encode(data) : data)
        return true
      },
      end: () => {
        if (this.ended) return
        this.ended = true
        // As the real adapter: stdin closed, it exits a moment later.
        if (this.adapter.exitOnEnd) queueMicrotask(() => this.exit(0))
      },
      stop: () => {
        if (this.stopped || this.exitCode !== null) return
        this.stopped = true
        this.resolveExit({ exitCode: null, stopped: true })
      }
    }
  }
}

export type FakeConfig = {
  frames?: unknown[]
  threads?: unknown[]
  scopes?: unknown[]
  variables?: Record<number, unknown[]>
  /** Lines the instance does not accept, by absolute path. */
  unverified?: Record<string, number[]>
}

export class FakeAdapter {
  readonly processes: FakeProcess[] = []
  readonly handlers: Record<string, Handler> = {}
  /** Thrown by `start` instead of starting, when set. */
  startError: Error | null = null
  exitOnEnd = true
  config: FakeConfig = {}

  constructor(config: FakeConfig = {}) {
    this.config = config
  }

  get last(): FakeProcess {
    const process = this.processes.at(-1)
    if (!process) throw new Error('no adapter was started')
    return process
  }

  readonly b2c: Pick<B2c, 'start' | 'mask'> = {
    start: async (args, options = {}) => {
      if (this.startError) throw this.startError
      const process = new FakeProcess(args, options, this)
      this.processes.push(process)
      return process.running()
    },
    mask: async (text) => fakeMask(text)
  }

  async answer(request: DapRequest, process: FakeProcess): Promise<void> {
    const handler = this.handlers[request.command] ?? DEFAULTS[request.command]
    const reply = handler ? await handler(request, process) : { fail: `unknown command ${request.command}` }
    if (reply !== 'none') process.respond(request, reply)
  }
}

/** What the runner's masker would do with the invented values. */
export function fakeMask(text: string): string {
  return text.split(FAKE_HOST).join('***').split(FAKE_HOME).join('~')
}

function args(request: DapRequest): Record<string, unknown> {
  return (request.arguments ?? {}) as Record<string, unknown>
}

const DEFAULTS: Record<string, Handler> = {
  initialize: () => ({ body: { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true } }),
  launch: (request, process) => {
    process.event('output', { category: 'console', output: `Connected to ${FAKE_HOST}\n` })
    process.respond(request, {})
    process.event('initialized')
    return 'none'
  },
  setBreakpoints: (request, process) => {
    const source = args(request).source as { path: string }
    const lines = (args(request).breakpoints as { line: number }[]).map((each) => each.line)
    const refused = process.adapter.config.unverified?.[source.path] ?? []
    return { body: { breakpoints: lines.map((line, i) => ({ id: i + 1, line, verified: !refused.includes(line) })) } }
  },
  configurationDone: () => ({}),
  threads: (_request, process) => ({ body: { threads: adapterOf(process).config.threads ?? [{ id: 0, name: 'Main Thread' }] } }),
  stackTrace: (_request, process) => ({ body: { stackFrames: adapterOf(process).config.frames ?? [], totalFrames: (adapterOf(process).config.frames ?? []).length } }),
  scopes: (_request, process) => ({ body: { scopes: adapterOf(process).config.scopes ?? [] } }),
  variables: (request, process) => ({ body: { variables: adapterOf(process).config.variables?.[args(request).variablesReference as number] ?? [] } }),
  evaluate: (request) => ({ body: { result: `value of ${String(args(request).expression)} at ${FAKE_HOST}`, variablesReference: 0 } }),
  continue: () => ({ body: { allThreadsContinued: false } }),
  next: () => ({}),
  stepIn: () => ({}),
  stepOut: () => ({}),
  disconnect: (request, process) => {
    process.event('output', { category: 'console', output: 'Debugger disconnected\n' })
    process.respond(request, {})
    return 'none'
  }
}

function adapterOf(process: FakeProcess): FakeAdapter {
  return process.adapter
}
