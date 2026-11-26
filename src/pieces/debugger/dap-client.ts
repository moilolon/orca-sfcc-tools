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
/** The header every frame begins with, matched in any letter case. */
const HEADER_NAME = new TextEncoder().encode('content-length:')
/** A header never runs this long: past it, what was taken for one is not. */
const MAX_HEADER_BYTES = 8192

function indexOfHeaderEnd(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 3 < bytes.length; i++) {
    if (bytes[i] === HEADER_END[0] && bytes[i + 1] === HEADER_END[1] && bytes[i + 2] === HEADER_END[2] && bytes[i + 3] === HEADER_END[3]) return i
  }
  return -1
}

/** Whether `HEADER_NAME`, or as much of it as `bytes` holds from `at`, is there (letters in any case). */
function nameAt(bytes: Uint8Array, at: number, whole: boolean): boolean {
  const available = Math.min(HEADER_NAME.length, bytes.length - at)
  if (whole && available < HEADER_NAME.length) return false
  for (let k = 0; k < available; k++) {
    const want = HEADER_NAME[k]
    const got = bytes[at + k]
    const letter = want >= 0x61 && want <= 0x7a
    if ((letter ? got | 0x20 : got) !== want) return false
  }
  return true
}

/** Where the next whole `Content-Length:` begins at or after `from`, or -1. */
function findHeader(bytes: Uint8Array, from: number): number {
  for (let i = from; i + HEADER_NAME.length <= bytes.length; i++) if (nameAt(bytes, i, true)) return i
  return -1
}

function isMessage(value: unknown): value is DapMessage {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'request' || type === 'response' || type === 'event'
}

/** Why a frame, or bytes that were not one, were dropped. */
export type DropReason = 'garbage' | 'header' | 'length' | 'json' | 'message'

/**
 * Turns the adapter's stdout, in chunks cut anywhere (in a header, in a body, in the middle of a
 * character), into whole messages. Whatever is not a well-formed frame is dropped and reading
 * resynchronises on the next `Content-Length:` header: bytes before a frame (a stray line), a
 * header with no usable length, a body that is not JSON (its declared length may be wrong, so the
 * search starts again right after its header), or JSON that is not a protocol message. Each
 * dropped frame or run of stray bytes is reported once through `onDropped`.
 */
export function createFrameReader(onMessage: (message: DapMessage) => void, onDropped: (why: DropReason) => void = () => {}) {
  let buffer = new Uint8Array(0)
  const decoder = new TextDecoder('utf-8')
  /** Whether the buffer begins where a frame should; false after anything went wrong. */
  let inStep = true
  /** Whether the bytes being skipped were already reported, so one bad run counts once. */
  let reported = false

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

  function drop(why: DropReason): void {
    if (reported && why === 'garbage') return
    reported = true
    onDropped(why)
  }

  /** Skips to the next header; false when there is none yet (the tail that may begin one is kept). */
  function resync(): boolean {
    const at = findHeader(buffer, 0)
    if (at === -1) {
      const keep = HEADER_NAME.length - 1
      if (buffer.length > keep) {
        drop('garbage')
        buffer = buffer.subarray(buffer.length - keep)
      }
      return false
    }
    if (at > 0) {
      drop('garbage')
      buffer = buffer.subarray(at)
    }
    inStep = true
    return true
  }

  return {
    push(chunk: Uint8Array): void {
      if (chunk.length === 0) return
      append(chunk)
      for (;;) {
        if (!inStep && !resync()) return
        // Line breaks or spaces between frames are no harm.
        let start = 0
        while (start < buffer.length && (buffer[start] === 13 || buffer[start] === 10 || buffer[start] === 32 || buffer[start] === 9)) start++
        if (start > 0) buffer = buffer.subarray(start)
        if (buffer.length === 0) return
        if (!nameAt(buffer, 0, false)) {
          inStep = false
          continue
        }
        const end = indexOfHeaderEnd(buffer, 0)
        if (end === -1) {
          if (buffer.length <= MAX_HEADER_BYTES) return
          drop('header')
          buffer = buffer.subarray(1)
          inStep = false
          continue
        }
        const header = decoder.decode(buffer.subarray(0, end))
        const match = /^content-length:[ \t]*(\d+)[ \t]*(?:\r\n|$)/i.exec(header)
        const length = match ? Number(match[1]) : NaN
        if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) {
          drop('length')
          buffer = buffer.subarray(1)
          inStep = false
          continue
        }
        const bodyStart = end + 4
        if (buffer.length < bodyStart + length) return
        const body = buffer.subarray(bodyStart, bodyStart + length)
        let parsed: unknown
        try {
          parsed = JSON.parse(decoder.decode(body))
        } catch {
          // The declared length may be wrong: look for the next header right after this one.
          drop('json')
          buffer = buffer.subarray(bodyStart)
          inStep = false
          continue
        }
        buffer = buffer.subarray(bodyStart + length)
        if (isMessage(parsed)) {
          reported = false
          onMessage(parsed)
        } else drop('message')
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
  /** A frame, or a run of bytes that was not one, was dropped: how many so far. */
  onDropped?(count: number): void
  defaultTimeoutMs?: number
}

export function createDapClient(options: DapClientOptions): DapClient {
  const waiting = new Map<number, { command: string; resolve: (body: unknown) => void; reject: (error: DapError) => void; timer: ReturnType<typeof setTimeout> | null }>()
  let seq = 0
  let closed = false
  let dropped = 0
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
  }, () => {
    dropped += 1
    options.onDropped?.(dropped)
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
