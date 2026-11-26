// The debug adapter protocol's framing and the matching of responses to requests, byte by byte.
import { assert, test } from 'orca/testing'
import { createDapClient, createFrameReader, DapError, encodeFrame, type DapEvent, type DapMessage } from './dap-client'

const bytes = (text: string) => new TextEncoder().encode(text)

function join(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function reader() {
  const messages: DapMessage[] = []
  const dropped: string[] = []
  const frames = createFrameReader(
    (message) => messages.push(message),
    (why) => dropped.push(why)
  )
  return { frames, messages, dropped }
}

const EVENT = { seq: 1, type: 'event', event: 'output', body: { category: 'console', output: 'Thread 7 halted at Página.js:11 ✓ 😀\n' } } as const
const RESPONSE = { seq: 2, type: 'response', request_seq: 1, command: 'initialize', success: true, body: {} } as const

test('a frame counts its body in bytes, not characters', () => {
  const frame = encodeFrame(EVENT)
  const text = new TextDecoder().decode(frame)
  const body = JSON.stringify(EVENT)
  const length = Number(/^Content-Length: (\d+)\r\n\r\n/.exec(text)?.[1])
  assert.equal(length, bytes(body).length)
  assert.ok(length > body.length, 'the body holds characters of more than one byte')
  assert.ok(!text.endsWith('\n'), 'no newline after the body')
})

test('two frames joined in one chunk arrive as two messages', () => {
  const { frames, messages } = reader()
  frames.push(join(encodeFrame(EVENT), encodeFrame(RESPONSE)))
  assert.deepEqual(messages, [EVENT, RESPONSE])
  assert.equal(frames.pending, 0)
})

test('a frame cut at every byte, a character of four bytes included, arrives whole and once', () => {
  const whole = join(encodeFrame(EVENT), encodeFrame(RESPONSE))
  for (let size = 1; size <= 7; size++) {
    const { frames, messages } = reader()
    for (let i = 0; i < whole.length; i += size) frames.push(whole.subarray(i, i + size))
    assert.deepEqual(messages, [EVENT, RESPONSE], `chunks of ${size}`)
  }
  // Cut right inside the emoji's four bytes, and inside the header.
  const frame = encodeFrame(EVENT)
  const emoji = bytes('😀')
  const at = frame.findIndex((_, i) => frame[i] === emoji[0] && frame[i + 1] === emoji[1])
  for (const cut of [3, 10, at + 1, at + 2, at + 3]) {
    const { frames, messages } = reader()
    frames.push(frame.subarray(0, cut))
    assert.deepEqual(messages, [], `nothing before the frame is whole (cut at ${cut})`)
    frames.push(frame.subarray(cut))
    assert.deepEqual(messages, [EVENT], `cut at ${cut}`)
  }
})

test('the header may hold other fields and any letter case; a frame without a usable length is dropped and reading goes on', () => {
  const { frames, messages, dropped } = reader()
  const body = JSON.stringify(RESPONSE)
  frames.push(bytes(`content-length: ${bytes(body).length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`))
  assert.deepEqual(messages, [RESPONSE])
  frames.push(bytes('Content-Type: x\r\n\r\n'))
  frames.push(bytes(`Content-Length: 999999999999\r\n\r\n`))
  frames.push(encodeFrame(EVENT))
  assert.deepEqual(messages, [RESPONSE, EVENT])
  // The stray header line is skipped as one run of garbage; the oversized length is its own drop.
  assert.deepEqual(dropped, ['garbage', 'length'])
})

test('a body that is not JSON, or not a protocol message, is dropped; the next frame still reads', () => {
  const { frames, messages, dropped } = reader()
  frames.push(join(bytes('Content-Length: 5\r\n\r\n{nope'), bytes('Content-Length: 2\r\n\r\n[]'), encodeFrame(EVENT)))
  assert.deepEqual(messages, [EVENT])
  assert.deepEqual(dropped, ['json', 'message'])
})

test('stray bytes that never make a header are let go instead of growing without end', () => {
  const { frames, messages, dropped } = reader()
  frames.push(new Uint8Array(9000).fill(65))
  assert.deepEqual(dropped, ['garbage'])
  assert.ok(frames.pending < 16, 'only what could begin a header is kept')
  frames.push(encodeFrame(EVENT))
  assert.deepEqual(messages, [EVENT])
})

/** Ten frames that must all arrive whatever came before them. */
const TEN = Array.from({ length: 10 }, (_, i) => ({ seq: 100 + i, type: 'event', event: 'output', body: { output: `line ${i}` } }))

function withLength(body: string, delta: number): Uint8Array {
  return bytes(`Content-Length: ${bytes(body).length + delta}\r\n\r\n${body}`)
}

test('garbage before, between and inside frames is dropped and reading resynchronises on the next header', () => {
  const body = JSON.stringify(EVENT)
  const cases: [string, Uint8Array][] = [
    ['a stray line (LF only)', bytes('Warning: something\n')],
    ['a header whose length is not a number, with its body', bytes('Content-Length: abc\r\n\r\n{"seq":1,"type":"event","event":"x"}')],
    ['a body one byte shorter than its declared length', withLength(body, 1)],
    ['a body one byte longer than its declared length', withLength(body, -1)],
    ['junk inside a header', bytes('Content-Length: 1\u0000\u0000 2\r\n\r\n{}')],
    ['junk inside a body', bytes(`Content-Length: ${bytes(body).length}\r\n\r\n${body.slice(0, 10)}<<junk>>${body.slice(10, -8)}`)],
    ['binary noise', new Uint8Array([0xff, 0xfe, 0x00, 0x43, 0x6f, 0x6e, 0x0a, 0x0d, 0x0a])]
  ]
  for (const [name, garbage] of cases) {
    for (const size of [0, 1, 5]) {
      const { frames, messages, dropped } = reader()
      const whole = join(encodeFrame(RESPONSE), garbage, ...TEN.map((frame) => encodeFrame(frame)))
      if (size === 0) frames.push(whole)
      else for (let i = 0; i < whole.length; i += size) frames.push(whole.subarray(i, i + size))
      const where = `${name}, chunks of ${size || 'all'}`
      assert.deepEqual(messages[0], RESPONSE, `${where}: the frame before it`)
      assert.deepEqual(messages.slice(-10), TEN, `${where}: the ten frames after it`)
      assert.equal(messages.length, 11, `${where}: nothing invented`)
      assert.ok(dropped.length >= 1 && dropped.length <= 2, `${where}: counted (${dropped.join(', ')})`)
    }
  }
})

test('the client counts what it drops and goes on answering', async () => {
  const counts: number[] = []
  let dap: ReturnType<typeof createDapClient> | null = null
  const reading = createFrameReader((message) => {
    if (message.type !== 'request') return
    dap?.receive(bytes('noise\n'))
    dap?.receive(encodeFrame({ seq: 9, type: 'response', request_seq: message.seq, command: message.command, success: true, body: { ok: true } }))
  })
  dap = createDapClient({
    write: (data) => {
      reading.push(data)
      return true
    },
    onEvent: () => {},
    onDropped: (count) => counts.push(count)
  })
  assert.deepEqual(await dap.request('threads'), { ok: true })
  assert.deepEqual(await dap.request('threads'), { ok: true })
  assert.deepEqual(counts, [1, 2])
})

/** A client over a fake adapter that records the requests written. */
function client(defaultTimeoutMs?: number) {
  const written: { seq: number; command: string; arguments?: unknown }[] = []
  const events: DapEvent[] = []
  let writable = true
  const reading = createFrameReader((message) => written.push(message as never))
  const dap = createDapClient({
    write: (data) => {
      if (!writable) return false
      reading.push(data)
      return true
    },
    onEvent: (event) => events.push(event),
    defaultTimeoutMs
  })
  const answer = (requestSeq: number, command: string, extra: object = { success: true }) =>
    dap.receive(encodeFrame({ seq: 900 + requestSeq, type: 'response', request_seq: requestSeq, command, ...extra }))
  return { dap, written, events, answer, close: () => (writable = false) }
}

test('each response settles its own request, by request_seq, in whatever order they come', async () => {
  const { dap, written, answer } = client()
  const threads = dap.request('threads')
  const stack = dap.request('stackTrace', { threadId: 7 })
  assert.deepEqual(
    written.map(({ seq, command, arguments: args }) => ({ seq, command, args })),
    [
      { seq: 1, command: 'threads', args: undefined },
      { seq: 2, command: 'stackTrace', args: { threadId: 7 } }
    ]
  )
  answer(2, 'stackTrace', { success: true, body: { stackFrames: [{ id: 1 }] } })
  answer(1, 'threads', { success: true, body: { threads: [] } })
  // A response nobody waits for is ignored.
  answer(99, 'threads')
  assert.deepEqual(await stack, { stackFrames: [{ id: 1 }] })
  assert.deepEqual(await threads, { threads: [] })
})

test('a refusal carries the adapter’s message; events go to their listener, not to a request', async () => {
  const { dap, events, answer } = client()
  const launch = dap.request('launch', {})
  dap.receive(encodeFrame({ seq: 5, type: 'event', event: 'output', body: { output: 'x' } }))
  answer(1, 'launch', { success: false, message: 'Failed to connect: Script debugger is not enabled' })
  const error = await launch.then(
    () => null,
    (failure: unknown) => failure
  )
  assert.ok(error instanceof DapError)
  assert.equal(error.code, 'refused')
  assert.equal(error.detail, 'Failed to connect: Script debugger is not enabled')
  assert.equal(error.message, 'launch: refused', 'its message is no adapter text')
  assert.deepEqual(
    events.map((event) => event.event),
    ['output']
  )
})

test('a request times out on its own; one sent without waiting gets a sequence number and no timer', async () => {
  const { dap, written } = client(20)
  const slow = dap.request('evaluate', { expression: 'x' })
  const error = await slow.then(
    () => null,
    (failure: unknown) => failure
  )
  assert.ok(error instanceof DapError && error.code === 'timeout')
  assert.equal(dap.send('next', { threadId: 7 }), 2)
  assert.equal(written.at(-1)?.command, 'next')
})

test('when the adapter goes away every waiting request fails as closed, and later ones at once', async () => {
  const { dap, close } = client()
  const pending = [dap.request('threads'), dap.request('stackTrace', { threadId: 1 }, { timeoutMs: 0 })]
  dap.close()
  for (const request of pending) {
    const error = await request.then(
      () => null,
      (failure: unknown) => failure
    )
    assert.ok(error instanceof DapError && error.code === 'closed')
  }
  assert.ok(dap.closed)
  const after = await dap.request('threads').then(
    () => null,
    (failure: unknown) => failure
  )
  assert.ok(after instanceof DapError && after.code === 'closed')
  // A stdin that no longer takes bytes fails the request at once.
  const other = client()
  other.close()
  const failed = await other.dap.request('threads').then(
    () => null,
    (failure: unknown) => failure
  )
  assert.ok(failed instanceof DapError && failed.code === 'write_failed')
  void close
})

test('an answer the adapter writes back while the request is still being written is matched', async () => {
  let dap: ReturnType<typeof createDapClient> | null = null
  const reading = createFrameReader((message) => {
    if (message.type === 'request') dap?.receive(encodeFrame({ seq: 1, type: 'response', request_seq: message.seq, command: message.command, success: true, body: { echo: message.command } }))
  })
  dap = createDapClient({
    write: (data) => {
      reading.push(data)
      return true
    },
    onEvent: () => {}
  })
  assert.deepEqual(await dap.request('launch', {}), { echo: 'launch' })
})
