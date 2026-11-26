// The session over a scripted fake adapter: its states, a stop at a breakpoint with its stack and
// variables, steps driven by events, the disconnect on every way out, the cleanup after an
// unclean end, and masking of what the adapter says.
import { assert, test } from 'orca/testing'
import { B2cError } from '../../core/b2c'
import { FAKE_HOST, FAKE_ROOT, FAKE_SECRET_VALUE, FakeAdapter, type FakeConfig } from './fake-adapter'
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
  const flag = { value: unclean, writes: [] as boolean[] }
  const logs: string[] = []
  const states: SessionSnapshot['status'][] = []
  const session = createSession({
    b2c: adapter.b2c,
    log: (line) => logs.push(line),
    platform: 'linux',
    timeouts: { requestMs: 500, launchMs: 500, disconnectMs: 300, exitMs: 50 },
    unclean: {
      get: async () => flag.value,
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
