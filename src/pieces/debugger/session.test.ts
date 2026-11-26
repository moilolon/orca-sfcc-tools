// The session over a scripted fake adapter: its states, a stop at a breakpoint with its stack and
// variables, steps driven by events, the disconnect on every way out, the cleanup after an
// unclean end, and masking of what the adapter says.
import { assert, test } from 'orca/testing'
import { B2cError } from '../../core/b2c'
import { FAKE_HOST, FAKE_ROOT, FAKE_SECRET_VALUE, FakeAdapter, type FakeConfig, type Handler } from './fake-adapter'
import { createSession, type SessionSnapshot } from './session'

const PAGE = 'cartridges/app_example/cartridge/controllers/Page.js'
const PAGE_ABSOLUTE = `${FAKE_ROOT}/${PAGE}`

const FRAMES = [
  { id: 70000, name: 'show()', source: { name: 'Page.js', path: PAGE_ABSOLUTE, sourceReference: 0 }, line: 11, column: 0 },
  { id: 70001, name: `next() via ${FAKE_HOST}`, source: { name: 'route.js', path: `${FAKE_ROOT}/cartridges/modules/server/route.js` }, line: 83, column: 0 },
  // A cartridge the adapter could not map: only the server path, which is not shown whole.
  { id: 70002, name: '-anonymous-()', source: { name: '/app_other/cartridge/scripts/x.js' }, line: 3, column: 0 }
]

const CONFIG: FakeConfig = {
  frames: FRAMES,
  threads: [
    { id: 7, name: 'Thread 7' },
    { id: 9, name: 'Thread 9' }
  ],
  scopes: [
    { name: 'Local', variablesReference: 1, expensive: false },
    { name: 'Global', variablesReference: 3, expensive: true }
  ],
  variables: {
    1: [
      { name: 'flag', value: 'undefined', variablesReference: 0 },
      { name: 'url', value: FAKE_SECRET_VALUE, variablesReference: 0 },
      { name: 'req', value: '[object Object]', variablesReference: 5 }
    ]
  }
}

/** Waits until `check` holds, letting the fake adapter's microtasks and timers run. */
async function until(check: () => boolean, what: string, limitMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > limitMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function setup(config: FakeConfig = CONFIG, unclean = false) {
  const adapter = new FakeAdapter(config)
  const flag = { value: unclean, writes: [] as boolean[], reads: 0 }
  const logs: string[] = []
  const states: SessionSnapshot['status'][] = []
  const session = createSession({
    b2c: adapter.b2c,
    log: (line) => logs.push(line),
    platform: 'linux',
    timeouts: { requestMs: 500, launchMs: 500, disconnectMs: 300, exitMs: 50 },
    unclean: {
      get: async () => {
        flag.reads += 1
        return flag.value
      },
      set: async (value) => {
        flag.value = value
        flag.writes.push(value)
      }
    },
    onChange: () => {
      const status = session.snapshot().status
      if (states.at(-1) !== status) states.push(status)
    }
  })
  return { adapter, session, flag, logs, states }
}

const BREAKPOINTS = [{ path: PAGE, lines: [11, 24] }]

test('starts b2c debug on the sandbox, in the workspace, with its own client id; then attaches in the order the adapter needs', async () => {
  const { adapter, session, states, flag } = setup({ ...CONFIG, unverified: { [PAGE_ABSOLUTE]: [24] } })
  assert.equal(session.snapshot().status, 'idle')
  const answer = await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.equal(answer.status, 'attached')
  assert.deepEqual(states, ['connecting', 'attached'])
  const process = adapter.last
  assert.deepEqual(process.args, ['debug', '--client-id', 'orca-sfcc-tools'])
  assert.equal(process.options.role, 'sandbox')
  assert.equal(process.options.cwd, FAKE_ROOT)
  assert.equal(process.options.jsonl, undefined, 'stdout stays pure protocol: no --jsonl')
  assert.deepEqual(process.commands, ['initialize', 'launch', 'setBreakpoints', 'configurationDone'])
  assert.deepEqual(process.requests[1].arguments, {})
  // The breakpoint takes the absolute local path; the store keeps it relative.
  assert.deepEqual(process.requests[2].arguments, { source: { path: PAGE_ABSOLUTE }, breakpoints: [{ line: 11 }, { line: 24 }], lines: [11, 24] })
  assert.deepEqual(session.snapshot().verified, {
    [PAGE]: [
      { line: 11, verified: true },
      { line: 24, verified: false }
    ]
  })
  assert.equal(flag.value, true, 'a client exists on the instance until a disconnect succeeds')
  assert.equal(session.root, FAKE_ROOT)
  // A second start while it runs does nothing.
  await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.equal(adapter.processes.length, 1)
})

test('the launch waits for its response and the initialized event both, before any breakpoint is set', async () => {
  const { adapter, session } = setup()
  let release: () => void = () => {}
  adapter.handlers.launch = (request, process) => {
    process.respond(request, {})
    release = () => process.event('initialized')
    return 'none'
  }
  const started = session.start(FAKE_ROOT, BREAKPOINTS)
  await until(() => adapter.processes.length === 1 && adapter.last.commands.includes('launch'), 'launch')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(adapter.last.commands, ['initialize', 'launch'], 'nothing more before initialized')
  assert.equal(session.snapshot().status, 'connecting')
  release()
  assert.equal((await started).status, 'attached')
})

test('a launch the sandbox refuses fails with its masked words, and the adapter is closed', async () => {
  const { adapter, session, flag } = setup()
  adapter.handlers.launch = () => ({ fail: `Failed to connect to ${FAKE_HOST}: Script debugger is not enabled on this instance.` })
  const answer = await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.equal(answer.status, 'failed')
  assert.equal(answer.reason, 'launch_failed')
  assert.equal(answer.message, 'Failed to connect to ***: Script debugger is not enabled on this instance.')
  assert.ok(!JSON.stringify(answer).includes(FAKE_HOST))
  assert.ok(adapter.last.ended, 'stdin closed')
  assert.ok(adapter.last.commands.includes('disconnect'), 'disconnected anyway')
  assert.equal(flag.value, false, 'the disconnect answered, so nothing is left on the instance')
})

test('a runner refusal (no usable credentials, no b2c) fails with its code and starts nothing', async () => {
  const { adapter, session } = setup()
  adapter.startError = new B2cError('credentials_missing')
  const answer = await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.deepEqual([answer.status, answer.reason], ['failed', 'credentials_missing'])
  assert.equal(adapter.processes.length, 0)
})

test('an adapter that ends before speaking fails with its last stderr line, already masked by the runner', async () => {
  const { adapter, session, flag } = setup()
  adapter.handlers.initialize = (_request, process) => {
    process.stderr('Error: the debugger needs a user and an access key')
    process.exit(2)
    return 'none'
  }
  const answer = await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.deepEqual([answer.status, answer.reason, answer.message], ['failed', 'adapter_exited', 'Error: the debugger needs a user and an access key'])
  assert.equal(flag.value, false, 'it never launched, so nothing was left on the instance')
})

async function attached(config: FakeConfig = CONFIG) {
  const context = setup(config)
  await context.session.start(FAKE_ROOT, BREAKPOINTS)
  return context
}

test('a stop at a breakpoint: halted, the threads without the placeholder, the stack with masked names and workspace paths', async () => {
  const { adapter, session, states } = await attached()
  adapter.last.chunkSize = 3
  adapter.last.event('output', { category: 'console', output: `Thread 7 halted at ${PAGE_ABSOLUTE}:11 (show())\n` })
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  assert.equal(session.snapshot().status, 'halted')
  await until(() => session.snapshot().frames.length > 0, 'the stack')
  const snapshot = session.snapshot()
  assert.deepEqual(states, ['connecting', 'attached', 'halted'])
  assert.equal(snapshot.threadId, 7)
  assert.deepEqual(snapshot.threads, [
    { id: 7, name: 'Thread 7', halted: true },
    { id: 9, name: 'Thread 9', halted: false }
  ])
  assert.deepEqual(snapshot.frames, [
    { id: 70000, name: 'show()', file: 'Page.js', line: 11, path: PAGE },
    { id: 70001, name: 'next() via ***', file: 'route.js', line: 83, path: 'cartridges/modules/server/route.js' },
    { id: 70002, name: '-anonymous-()', file: 'x.js', line: 3, path: null }
  ])
  assert.ok(!JSON.stringify(snapshot).includes(FAKE_HOST), 'no host')
  assert.ok(!JSON.stringify(snapshot).includes(FAKE_ROOT), 'no absolute path')
  assert.deepEqual(session.frameLocation(70000), { path: PAGE, line: 11 })
  assert.equal(session.frameLocation(70002), null, 'a frame outside the workspace cannot be opened')
  // The placeholder thread 0 is left out when nothing else runs.
  adapter.config.threads = [{ id: 0, name: 'Main Thread' }]
  assert.deepEqual(await session.threads(), [])
})

test('scopes and variables are read on demand, masked, and never kept by the session', async () => {
  const { adapter, session } = await attached()
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  await until(() => session.snapshot().frames.length > 0, 'the stack')
  const scopes = await session.variables({ frameId: 70000 })
  assert.deepEqual(scopes, [
    { name: 'Local', value: '', reference: 1, expensive: false },
    { name: 'Global', value: '', reference: 3, expensive: true }
  ])
  assert.deepEqual(adapter.last.requests.at(-1)?.arguments, { frameId: 70000 })
  const locals = await session.variables({ reference: 1 })
  assert.deepEqual(locals, [
    { name: 'flag', value: 'undefined', reference: 0, expensive: false },
    { name: 'url', value: 'https://***/on/demandware.store/Sites-Example-Site', reference: 0, expensive: false },
    { name: 'req', value: '[object Object]', reference: 5, expensive: false }
  ])
  assert.ok(!JSON.stringify(session.snapshot()).includes('demandware'), 'values are not kept in the state')
  const evaluated = await session.evaluate('req.httpMethod', 70000)
  assert.deepEqual(evaluated, { result: 'value of req.httpMethod at ***', reference: 0 })
  assert.deepEqual(adapter.last.requests.at(-1)?.arguments, { expression: 'req.httpMethod', context: 'repl', frameId: 70000 })
  // A refused expression answers with the adapter's own masked words.
  adapter.handlers.evaluate = () => ({ fail: `ReferenceError: nope is not defined (${FAKE_HOST})` })
  assert.deepEqual(await session.evaluate('nope', 70000), { result: 'ReferenceError: nope is not defined (***)', reference: 0 })
})

test('steps follow events: the thread runs at once, halts again on the next stopped event, and a late response changes nothing', async () => {
  const { adapter, session, states } = await attached()
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  await until(() => session.snapshot().frames.length > 0, 'the stack')
  // The response to `next` comes only when the test lets it, after its stopped event.
  let answerNext: () => void = () => {}
  adapter.handlers.next = (request, process) => {
    answerNext = () => process.respond(request, {})
    return 'none'
  }
  session.step('over')
  assert.equal(adapter.last.commands.at(-1), 'next')
  assert.deepEqual(adapter.last.requests.at(-1)?.arguments, { threadId: 7 })
  assert.equal(session.snapshot().status, 'attached', 'running until the next stop')
  assert.deepEqual(session.snapshot().frames, [])
  adapter.config.frames = [{ ...FRAMES[0], line: 12 }]
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  await until(() => session.snapshot().frames[0]?.line === 12, 'the new line')
  answerNext()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(session.snapshot().status, 'halted')
  assert.equal(session.snapshot().frames[0].line, 12)
  // In and out send their own commands; continue releases the thread.
  session.step('in')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  session.step('out')
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  session.step('continue')
  // Each stop also reads the threads and the stack; the steps went out in order.
  assert.deepEqual(
    adapter.last.commands.filter((command) => ['next', 'stepIn', 'stepOut', 'continue'].includes(command)),
    ['next', 'stepIn', 'stepOut', 'continue']
  )
  assert.equal(session.snapshot().status, 'attached')
  assert.deepEqual(states.slice(0, 4), ['connecting', 'attached', 'halted', 'attached'])
  // Stepping with nothing halted is refused.
  assert.throws(() => session.step('over'), /not_halted/)
})

test('a halted thread that exits, or continues by itself, returns the session to attached', async () => {
  const { adapter, session } = await attached()
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 9 })
  assert.equal(session.snapshot().threadId, 9)
  adapter.last.event('thread', { reason: 'exited', threadId: 9 })
  assert.equal(session.snapshot().status, 'halted')
  assert.equal(session.snapshot().threadId, 7, 'the other halted thread is shown')
  adapter.last.event('continued', { threadId: 7 })
  assert.equal(session.snapshot().status, 'attached')
  // Any thread exiting that was not halted changes nothing.
  adapter.last.event('thread', { reason: 'exited', threadId: 12 })
  assert.equal(session.snapshot().status, 'attached')
})

test('stop disconnects first, then closes stdin; the flag is cleared and the session ends', async () => {
  const { adapter, session, flag } = await attached()
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  const answer = await session.stop()
  assert.equal(answer.status, 'ended')
  const process = adapter.last
  assert.equal(process.commands.at(-1), 'disconnect')
  assert.deepEqual(process.requests.at(-1)?.arguments, { terminateDebuggee: false })
  assert.ok(process.ended, 'stdin closed after the disconnect')
  assert.ok(!process.stopped, 'it exited by itself; nothing was killed')
  assert.equal(flag.value, false)
  assert.equal(session.root, null)
})

test('stop kills an adapter that will not exit, and keeps the flag when the disconnect got no answer', async () => {
  const { adapter, session, flag } = await attached()
  adapter.exitOnEnd = false
  adapter.handlers.disconnect = () => 'none'
  await session.stop()
  assert.ok(adapter.last.stopped, 'stopped after a moment')
  assert.equal(flag.value, true, 'the next start cleans up')
})

test('when the worker goes away the disconnect is written at once, before stdin closes', async () => {
  const { adapter, session, flag } = await attached()
  const before = adapter.last.requests.length
  session.dispose()
  // Written synchronously: the request is already in the adapter's stdin.
  assert.equal(adapter.last.requests.length, before + 1)
  assert.equal(adapter.last.commands.at(-1), 'disconnect')
  await until(() => adapter.last.ended, 'stdin closed')
  await until(() => flag.value === false, 'the flag cleared')
})

test('after a session that did not end cleanly, the next start first runs a cleanup session: launch, then disconnect', async () => {
  const { adapter, session, flag } = setup(CONFIG, true)
  const answer = await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.equal(answer.status, 'attached')
  assert.equal(adapter.processes.length, 2)
  const [cleanup, real] = adapter.processes
  assert.deepEqual(cleanup.commands, ['initialize', 'launch', 'disconnect'])
  assert.deepEqual(cleanup.args, ['debug', '--client-id', 'orca-sfcc-tools'], 'the same client id, so launch replaces the old client')
  assert.ok(cleanup.ended)
  assert.deepEqual(real.commands, ['initialize', 'launch', 'setBreakpoints', 'configurationDone'])
  assert.equal(flag.value, true)
  assert.deepEqual(flag.writes, [false, true], 'cleared by the cleanup, set again by the real launch')
})

test('a cleanup that fails does not keep the real start from running and saying why', async () => {
  const { adapter, session } = setup(CONFIG, true)
  adapter.handlers.launch = () => ({ fail: 'Script debugger is not enabled on this instance.' })
  const answer = await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.equal(adapter.processes.length, 2)
  assert.deepEqual([answer.status, answer.reason, answer.message], ['failed', 'launch_failed', 'Script debugger is not enabled on this instance.'])
})

test('an adapter that dies while attached fails the session and leaves the flag for the next start', async () => {
  const { adapter, session, flag } = await attached()
  adapter.last.event('output', { category: 'important', output: `Lost the connection to ${FAKE_HOST}` })
  await new Promise((resolve) => setTimeout(resolve, 5))
  adapter.last.exit(1)
  await until(() => session.snapshot().status === 'failed', 'failed')
  assert.deepEqual([session.snapshot().reason, session.snapshot().message], ['adapter_exited', 'Lost the connection to ***'])
  assert.equal(flag.value, true)
  // A new start cleans up first.
  await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.deepEqual(adapter.processes[1].commands, ['initialize', 'launch', 'disconnect'])
})

test('the instance ending the session (terminated) ends it with the adapter’s masked words', async () => {
  const { adapter, session } = await attached()
  adapter.last.event('output', { category: 'important', output: `Script debugger was disabled on ${FAKE_HOST}` })
  await new Promise((resolve) => setTimeout(resolve, 5))
  adapter.last.event('terminated')
  await until(() => session.snapshot().status === 'ended', 'ended')
  assert.deepEqual([session.snapshot().reason, session.snapshot().message], ['terminated', 'Script debugger was disabled on ***'])
})

test('the terminated path still disconnects, and an answered disconnect clears the flag', async () => {
  const { adapter, session, flag } = await attached()
  adapter.last.event('terminated')
  await until(() => session.snapshot().status === 'ended', 'ended')
  assert.equal(adapter.last.commands.at(-1), 'disconnect')
  assert.ok(adapter.last.ended)
  assert.equal(flag.value, false)
})

test('a stop whose disconnect gets no answer ends as disconnect_unconfirmed and keeps the flag', async () => {
  const { adapter, session, flag } = await attached()
  adapter.handlers.disconnect = () => 'none'
  const answer = await session.stop()
  assert.deepEqual([answer.status, answer.reason], ['ended', 'disconnect_unconfirmed'])
  assert.equal(flag.value, true)
  // An answered one ends with no reason.
  const clean = await attached()
  assert.deepEqual([(await clean.session.stop()).reason, clean.flag.value], [null, false])
})

test('text is masked whole before it is cut: a value straddling the cut never leaves a piece of itself', async () => {
  const { adapter, session } = setup()
  const long = `${'x'.repeat(1990)}${FAKE_HOST}/path`
  adapter.handlers.launch = () => ({ fail: long })
  const failed = await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.equal(failed.message, `${'x'.repeat(1990)}***/path`)
  // Past the cut too: masked first, then cut, so no fragment of the host survives either way.
  const other = setup({ ...CONFIG, variables: { 1: [{ name: 'v', value: `${'y'.repeat(1995)}${FAKE_HOST}${'z'.repeat(3000)}`, variablesReference: 0 }] } })
  await other.session.start(FAKE_ROOT, BREAKPOINTS)
  other.adapter.last.event('stopped', { reason: 'breakpoint', threadId: 7 })
  await until(() => other.session.snapshot().status === 'halted', 'halted')
  const [variable] = await other.session.variables({ reference: 1 })
  assert.ok(!variable.value.includes('sandbox'), 'no part of the host')
  assert.ok(variable.value.startsWith(`${'y'.repeat(1995)}***`))
  assert.ok(variable.value.endsWith('…'))
})

test('a stray line or a malformed frame from the adapter is dropped; the session goes on and the log has only the count', async () => {
  const { adapter, session, logs } = await attached()
  const process = adapter.last
  process.options.onStdout?.(new TextEncoder().encode(`Warning: something about ${FAKE_HOST}\n`))
  process.options.onStdout?.(new TextEncoder().encode('Content-Length: abc\r\n\r\n{"seq":1}'))
  process.event('stopped', { reason: 'breakpoint', threadId: 7 })
  assert.equal(session.snapshot().status, 'halted', 'the next frame still reads')
  await until(() => session.snapshot().frames.length > 0, 'the stack')
  assert.deepEqual(
    logs.filter((line) => line.includes('dropped')),
    ['dropped 1 malformed frame(s) from the adapter']
  )
  assert.ok(!logs.join('\n').includes('Warning') && !logs.join('\n').includes(FAKE_HOST))
})

// ---------------------------------------------------------------------------------------------
// A stop or a dispose landing at each await of the start sequence

type Gate = { reached: Promise<void>; release(): void }

/** A point the start waits at, held until the test lets it go. */
function gate(): Gate & { arrive(): void; passed: Promise<void> } {
  let arrive: () => void = () => {}
  let release: () => void = () => {}
  const reached = new Promise<void>((resolve) => (arrive = resolve))
  const passed = new Promise<void>((resolve) => (release = resolve))
  return { reached, passed, arrive, release }
}

/** Holds a request until released, then answers it as the fake would. */
function holdRequest(adapter: FakeAdapter, command: string, onlyProcess?: number): Gate {
  const held = gate()
  adapter.handlers[command] = async (request, process) => {
    if (onlyProcess !== undefined && adapter.processes.indexOf(process) !== onlyProcess) return defaultReply(command, request, process)
    held.arrive()
    await held.passed
    return defaultReply(command, request, process)
  }
  return held
}

function defaultReply(command: string, request: Parameters<Handler>[0], process: Parameters<Handler>[1]) {
  if (command === 'launch') {
    process.respond(request, {})
    process.event('initialized')
    return 'none' as const
  }
  if (command === 'setBreakpoints') return { body: { breakpoints: [{ id: 1, line: 11, verified: true }] } }
  return {}
}

type Point = { name: string; unclean?: boolean; hold(adapter: FakeAdapter, flag: GatedFlag): Gate }
type Held = ReturnType<typeof gate>
type GatedFlag = { value: boolean; holdGet: Held | null; holdSet: Held | null }

const POINTS: Point[] = [
  { name: 'reading the flag', hold: (_adapter, flag) => (flag.holdGet = gate()) },
  { name: 'the cleanup session’s launch', unclean: true, hold: (adapter) => holdRequest(adapter, 'launch', 0) },
  {
    name: 'starting b2c',
    hold: (adapter) => {
      const held = gate()
      const start = adapter.b2c.start
      adapter.b2c.start = async (...args) => {
        held.arrive()
        await held.passed
        return start(...args)
      }
      return held
    }
  },
  { name: 'initialize', hold: (adapter) => holdRequest(adapter, 'initialize') },
  { name: 'setting the flag', hold: (_adapter, flag) => (flag.holdSet = gate()) },
  { name: 'launch', hold: (adapter) => holdRequest(adapter, 'launch') },
  {
    name: 'the initialized event',
    hold: (adapter) => {
      const held = gate()
      adapter.handlers.launch = (request, process) => {
        process.respond(request, {})
        held.arrive()
        void held.passed.then(() => process.event('initialized'))
        return 'none'
      }
      return held
    }
  },
  { name: 'setBreakpoints', hold: (adapter) => holdRequest(adapter, 'setBreakpoints') },
  { name: 'configurationDone', hold: (adapter) => holdRequest(adapter, 'configurationDone') }
]

function gatedSession(point: Point) {
  const adapter = new FakeAdapter(CONFIG)
  // As the real adapter can: it reads stdin until it is closed and answers the disconnect late,
  // so anything a start still wrote meanwhile would reach it.
  adapter.exitOnEnd = false
  adapter.handlers.disconnect = (request, process) => {
    setTimeout(() => process.respond(request, {}), 30)
    return 'none'
  }
  const flag: GatedFlag = { value: point.unclean === true, holdGet: null, holdSet: null }
  const held = point.hold(adapter, flag)
  const session = createSession({
    b2c: adapter.b2c,
    log: () => {},
    platform: 'linux',
    timeouts: { requestMs: 500, launchMs: 500, disconnectMs: 300, exitMs: 50 },
    unclean: {
      get: async () => {
        if (flag.holdGet) {
          flag.holdGet.arrive()
          await flag.holdGet.passed
        }
        return flag.value
      },
      set: async (value) => {
        if (value && flag.holdSet) {
          flag.holdSet.arrive()
          await flag.holdSet.passed
        }
        flag.value = value
      }
    },
    onChange: () => {}
  })
  return { adapter, flag, held, session }
}

for (const kind of ['stop', 'dispose'] as const) {
  test(`a ${kind} at each await of the start: nothing but the disconnect is written after it, every adapter closes, the flag clears only on an answered disconnect`, async () => {
    for (const point of POINTS) {
      const { adapter, flag, held, session } = gatedSession(point)
      const where = `${kind} at ${point.name}`
      const started = session.start(FAKE_ROOT, BREAKPOINTS)
      await held.reached
      const before = adapter.processes.map((process) => process.commands.length)
      const processesBefore = adapter.processes.length
      const ending = kind === 'stop' ? session.stop() : session.dispose()
      held.release()
      await ending
      await started
      await new Promise((resolve) => setTimeout(resolve, 20))
      // No new adapter after it, and in each one only a disconnect, once.
      assert.ok(adapter.processes.length <= Math.max(processesBefore, point.name === 'starting b2c' ? 1 : 0), `${where}: no new adapter`)
      adapter.processes.forEach((process, i) => {
        const after = process.commands.slice(before[i] ?? 0)
        assert.ok(
          after.every((command) => command === 'disconnect'),
          `${where}: wrote ${after.join(', ')}`
        )
        assert.ok(after.length <= 1, `${where}: one disconnect at most`)
        const launched = process.commands.includes('launch')
        if (launched) assert.equal(process.commands.at(-1), 'disconnect', `${where}: a launched adapter is disconnected last`)
        assert.ok(process.ended || process.stopped || process.exitCode !== null, `${where}: the adapter is closed`)
      })
      const launchedAny = adapter.processes.some((process) => process.commands.includes('launch'))
      if (launchedAny) assert.equal(flag.value, false, `${where}: the answered disconnect cleared the flag`)
      if (kind === 'stop') assert.equal(session.snapshot().status, 'ended', where)
      if (kind === 'dispose') {
        const count = adapter.processes.length
        await session.start(FAKE_ROOT, BREAKPOINTS)
        assert.equal(adapter.processes.length, count, `${where}: a start after disposal is refused`)
      }
    }
  })
}

test('the reviewed race: a stop while initialize is unanswered leaves no launch, breakpoints or configurationDone after it', async () => {
  const { adapter, session, held, flag } = gatedSession(POINTS.find((point) => point.name === 'initialize') as Point)
  const started = session.start(FAKE_ROOT, BREAKPOINTS)
  await held.reached
  const stopping = session.stop()
  held.release()
  await stopping
  await started
  assert.deepEqual(adapter.last.commands, ['initialize'])
  assert.equal(flag.value, false)
})

test('the reviewed race: a dispose during the cleanup session’s launch opens no new adapter and disconnects the cleanup’s', async () => {
  const { adapter, session, held, flag } = gatedSession(POINTS.find((point) => point.name === 'the cleanup session’s launch') as Point)
  const started = session.start(FAKE_ROOT, BREAKPOINTS)
  await held.reached
  const disposing = session.dispose()
  held.release()
  await disposing
  await started
  assert.equal(adapter.processes.length, 1)
  assert.deepEqual(adapter.last.commands, ['initialize', 'launch', 'disconnect'])
  assert.equal(flag.value, false, 'the cleanup ran to its disconnect')
  assert.notEqual(session.snapshot().status, 'attached')
})

test('the adapter’s own output (Connected to <host>) never reaches the state', async () => {
  const { session } = await attached()
  assert.ok(!JSON.stringify(session.snapshot()).includes(FAKE_HOST))
  assert.equal(session.snapshot().message, null)
})

test('a file changed while attached is sent alone; an emptied one is sent with no lines and forgotten', async () => {
  const { adapter, session } = await attached()
  await session.syncFile({ path: 'cartridges/app_example/cartridge/scripts/a.js', lines: [3] })
  assert.deepEqual(adapter.last.requests.at(-1)?.arguments, { source: { path: `${FAKE_ROOT}/cartridges/app_example/cartridge/scripts/a.js` }, breakpoints: [{ line: 3 }], lines: [3] })
  await session.syncFile({ path: PAGE, lines: [] })
  assert.deepEqual(Object.keys(session.snapshot().verified), ['cartridges/app_example/cartridge/scripts/a.js'])
})

test('on Windows the adapter gets backslashed paths and a frame in another letter case is still the workspace’s', async () => {
  const adapter = new FakeAdapter({ frames: [{ id: 1, name: 'show()', source: { name: 'Page.js', path: 'c:\\WORK\\shop\\cartridges\\app_example\\cartridge\\controllers\\Page.js' }, line: 4 }] })
  const session = createSession({ b2c: adapter.b2c, log: () => {}, platform: 'win32', unclean: { get: async () => false, set: async () => {} }, onChange: () => {} })
  await session.start('C:\\work\\shop', BREAKPOINTS)
  assert.deepEqual((adapter.last.requests[2].arguments as { source: unknown }).source, { path: 'C:\\work\\shop\\cartridges\\app_example\\cartridge\\controllers\\Page.js' })
  adapter.last.event('stopped', { reason: 'breakpoint', threadId: 1 })
  await until(() => session.snapshot().frames.length > 0, 'the stack')
  assert.equal(session.snapshot().frames[0].path, PAGE)
  await session.stop()
})

// ---------------------------------------------------------------------------------------------
// Guards each pinned by a test of its own

test('a disconnect waits for a launch still in flight, so it can never reach the adapter first', async () => {
  const { adapter, session, flag, held } = gatedSession(POINTS.find((point) => point.name === 'launch') as Point)
  let launchAnswered = false
  let disconnectBeforeLaunchAnswer = false
  const answerLaunch = adapter.handlers.launch
  adapter.handlers.launch = (request, process) => {
    // Noted the moment the answer is written, before the session can react to it.
    const respond = process.respond.bind(process)
    process.respond = (answered, reply) => {
      if (answered.command === 'launch') launchAnswered = true
      respond(answered, reply)
    }
    return answerLaunch ? answerLaunch(request, process) : {}
  }
  const answerDisconnect = adapter.handlers.disconnect
  adapter.handlers.disconnect = (request, process) => {
    if (!launchAnswered) disconnectBeforeLaunchAnswer = true
    return answerDisconnect ? answerDisconnect(request, process) : {}
  }
  const started = session.start(FAKE_ROOT, BREAKPOINTS)
  await held.reached
  const stopping = session.stop()
  // Held a while, so a disconnect that did not wait would have gone out already.
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(!adapter.last.commands.includes('disconnect'), 'nothing is written while the launch is unanswered')
  held.release()
  await stopping
  await started
  assert.ok(!disconnectBeforeLaunchAnswer, 'the disconnect came after the launch was answered')
  assert.deepEqual(adapter.last.commands, ['initialize', 'launch', 'disconnect'])
  assert.equal(flag.value, false, 'the answered disconnect cleared the flag')
})

test('after dispose a start is refused at once: no state change, no flag read, no adapter', async () => {
  const { adapter, session, flag } = await attached()
  // Ended first, so nothing but the disposal itself can refuse the start.
  await session.stop()
  assert.equal(session.snapshot().status, 'ended')
  await session.dispose()
  const before = session.snapshot()
  const processes = adapter.processes.length
  const reads = flag.reads
  const answer = await session.start(FAKE_ROOT, BREAKPOINTS)
  assert.notEqual(answer.status, 'connecting', 'it never says it is connecting')
  assert.equal(session.snapshot(), before, 'the state did not change')
  assert.equal(flag.reads, reads, 'the flag was not even read')
  assert.equal(adapter.processes.length, processes)
  // A refused start is not left behind half way either: a stop after it has nothing to wait for.
  const stopped = await Promise.race([session.stop().then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('hung'), 500))])
  assert.equal(stopped, 'stopped')
})
