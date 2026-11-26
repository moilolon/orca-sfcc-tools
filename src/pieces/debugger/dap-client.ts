// The debug adapter protocol as `b2c debug` speaks it on its stdin and stdout: each message a JSON
// body after a `Content-Length` header, counted in bytes, with no newline after the body. This
// module frames and unframes those messages and matches each response to its request. It knows
// nothing of b2c, of the panel or of what a session means: src/pieces/debugger/session.ts does.
//
// Pure: no Node or Orca imports, so the tests drive it byte by byte.

export type DapRequest = { seq: number; type: 'request'; command: string; arguments?: unknown }
export type DapResponse = { seq: number; type: 'response'; request_seq: number; command: string; success: boolean; message?: string; body?: unknown }
export type DapEvent = { seq: number; type: 'event'; event: string; body?: unknown }
export type DapMessage = DapRequest | DapResponse | DapEvent

/** A body larger than this is not a message the adapter would send: the stream is out of step. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024

const HEADER_END = [13, 10, 13, 10] // \r\n\r\n

function indexOfHeaderEnd(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 3 < bytes.length; i++) {
    if (bytes[i] === HEADER_END[0] && bytes[i + 1] === HEADER_END[1] && bytes[i + 2] === HEADER_END[2] && bytes[i + 3] === HEADER_END[3]) return i
  }
  return -1
}

function isMessage(value: unknown): value is DapMessage {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'request' || type === 'response' || type === 'event'
}

/**
 * Turns the adapter's stdout, in chunks cut anywhere (in a header, in a body, in the middle of a
 * character), into whole messages. A frame whose header has no usable length, or whose body is
 * not a JSON message, is dropped and reading goes on after it.
 */
export function createFrameReader(onMessage: (message: DapMessage) => void, onDropped: (why: string) => void = () => {}) {
  let buffer = new Uint8Array(0)
  const decoder = new TextDecoder('utf-8')

  function append(chunk: Uint8Array): void {
    if (buffer.length === 0) {
      buffer = chunk.slice()
      return
    }
    const joined = new Uint8Array(buffer.length + chunk.length)
    joined.set(buffer)
    joined.set(chunk, buffer.length)
    buffer = joined
  }

  return {
    push(chunk: Uint8Array): void {
      if (chunk.length === 0) return
      append(chunk)
      for (;;) {
        const end = indexOfHeaderEnd(buffer, 0)
        if (end === -1) {
          // A header never runs this long: whatever this is, it is not a frame.
          if (buffer.length > 8192) {
            onDropped('header')
            buffer = new Uint8Array(0)
          }
          return
        }
        const header = decoder.decode(buffer.subarray(0, end))
        const match = /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header)
        const length = match ? Number(match[1]) : NaN
        if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) {
          onDropped('length')
          buffer = buffer.subarray(end + 4)
          continue
        }
        const start = end + 4
        if (buffer.length < start + length) return
        const body = buffer.subarray(start, start + length)
        buffer = buffer.subarray(start + length)
        let parsed: unknown
        try {
          parsed = JSON.parse(decoder.decode(body))
        } catch {
          onDropped('json')
          continue
        }
        if (isMessage(parsed)) onMessage(parsed)
        else onDropped('message')
      }
    },
    /** Bytes held while waiting for the rest of a frame. */
    get pending(): number {
      return buffer.length
    }
  }
}

/** One message as the adapter reads it: its header, then its UTF-8 body. */
export function encodeFrame(message: object): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`)
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header)
  frame.set(body, header.length)
  return frame
}

/** Why a request got no successful answer: the adapter said no, it took too long, or it went away. */
export class DapError extends Error {
  constructor(
    readonly code: 'refused' | 'timeout' | 'closed' | 'write_failed',
    readonly command: string,
    /** The adapter's own message on a refusal, as it wrote it: mask it before showing it. */
    readonly detail: string | null = null
  ) {
    super(`${command}: ${code}`)
  }
}

export type DapClient = {
  /**
   * Sends a request and resolves with its response's body once the adapter answers with success;
   * rejects with a DapError otherwise. Default timeout 30 s.
   */
  request(command: string, args?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  /** Sends a request without waiting for its answer (a step, whose answer can lag its event). */
  send(command: string, args?: unknown): number
  /** Every byte the adapter wrote on stdout. */
  receive(chunk: Uint8Array): void
  /** The adapter is gone: every request still waiting fails with `closed`. */
  close(): void
  readonly closed: boolean
}

export type DapClientOptions = {
  /** Writes bytes to the adapter's stdin; false when they could not be written. */
  write(bytes: Uint8Array): boolean
  onEvent(event: DapEvent): void
  defaultTimeoutMs?: number
}

export function createDapClient(options: DapClientOptions): DapClient {
  const waiting = new Map<number, { command: string; resolve: (body: unknown) => void; reject: (error: DapError) => void; timer: ReturnType<typeof setTimeout> | null }>()
  let seq = 0
  let closed = false
  const reader = createFrameReader((message) => {
    if (message.type === 'event') {
      options.onEvent(message)
      return
    }
    if (message.type !== 'response') return
    const entry = waiting.get(message.request_seq)
    if (!entry) return
    waiting.delete(message.request_seq)
    if (entry.timer) clearTimeout(entry.timer)
    if (message.success) entry.resolve(message.body)
    else entry.reject(new DapError('refused', entry.command, typeof message.message === 'string' ? message.message : null))
  })

  /** Writes a request; `before` runs with its number first, so an answer written back at once finds it. */
  function write(command: string, args: unknown, before: (id: number) => void = () => {}): number {
    seq += 1
    const id = seq
    const request: DapRequest = args === undefined ? { seq: id, type: 'request', command } : { seq: id, type: 'request', command, arguments: args }
    if (closed) return -1
    before(id)
    return options.write(encodeFrame(request)) ? id : -1
  }

  return {
    request(command, args, { timeoutMs = options.defaultTimeoutMs ?? 30_000 } = {}) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new DapError('closed', command))
          return
        }
        const id = write(command, args, (number) => {
          const timer =
            timeoutMs > 0
              ? setTimeout(() => {
                  if (!waiting.delete(number)) return
                  reject(new DapError('timeout', command))
                }, timeoutMs)
              : null
          waiting.set(number, { command, resolve, reject, timer })
        })
        if (id === -1) {
          const entry = waiting.get(seq)
          if (entry?.timer) clearTimeout(entry.timer)
          waiting.delete(seq)
          reject(new DapError('write_failed', command))
        }
      })
    },
    send(command, args) {
      return write(command, args)
    },
    receive(chunk) {
      if (!closed) reader.push(chunk)
    },
    close() {
      if (closed) return
      closed = true
      for (const [id, entry] of waiting) {
        waiting.delete(id)
        if (entry.timer) clearTimeout(entry.timer)
        entry.reject(new DapError('closed', entry.command))
      }
    },
    get closed() {
      return closed
    }
  }
}
