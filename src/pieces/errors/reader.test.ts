// Parsing what `b2c logs get --json` prints: the timestamp, the order, the pipe fields, the logger,
// the text and the frames of the trace. Over invented entries only.
import { assert, test } from 'orca/testing'
import { cartError, jobError, LOGS_GET, paymentError } from './fixtures/logs'
import { filtersOf, parseFrame, parseLogEntries, parseMessage, parseTimestamp } from './reader'

test('parseTimestamp reads the GMT form b2c prints, and nothing else', () => {
  assert.equal(parseTimestamp('2026-11-26 10:15:02.123 GMT'), Date.UTC(2026, 10, 26, 10, 15, 2, 123))
  assert.equal(parseTimestamp('2026-11-26 10:15:02 GMT'), Date.UTC(2026, 10, 26, 10, 15, 2, 0))
  assert.equal(parseTimestamp('2026-11-26 10:15:02.5 GMT'), Date.UTC(2026, 10, 26, 10, 15, 2, 500))
  assert.equal(parseTimestamp(' 2026-01-02 03:04:05.006 GMT '), Date.UTC(2026, 0, 2, 3, 4, 5, 6))
  for (const bad of ['', 'yesterday', '2026-11-31 10:00:00.000 GMT', '26/11/2026 10:15', 42, null, undefined]) {
    assert.equal(parseTimestamp(bad), null, String(bad))
  }
})

test('parseLogEntries sorts by time, drops what cannot be read and never keeps raw', () => {
  const entries = parseLogEntries(LOGS_GET)
  assert.equal(entries.length, LOGS_GET.entries.length)
  const times = entries.map((entry) => entry.timestamp)
  assert.deepEqual(times, [...times].sort((a, b) => a - b))
  assert.equal(entries[0].timestamp, Date.UTC(2026, 10, 25, 23, 59, 58, 1))
  for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(), ['file', 'level', 'message', 'timestamp'])

  const mixed = {
    entries: [
      { file: 'a.log', timestamp: 'not a time', level: 'ERROR', message: 'x' },
      { file: 'a.log', timestamp: '2026-11-26 10:00:00.000 GMT', level: 'ERROR' },
      null,
      'text',
      { timestamp: '2026-11-26 10:00:00.000 GMT', message: 'kept' }
    ]
  }
  assert.deepEqual(parseLogEntries(mixed), [{ file: '', timestamp: Date.UTC(2026, 10, 26, 10), level: '', message: 'kept' }])
  for (const nothing of [null, undefined, {}, { entries: 'x' }, [], 'x']) assert.deepEqual(parseLogEntries(nothing), [])
})

test('parseLogEntries keeps the order b2c gave for two entries of the same millisecond', () => {
  const at = '2026-11-26 10:00:00.000 GMT'
  const entries = parseLogEntries({ entries: [{ timestamp: at, message: 'first' }, { timestamp: at, message: 'second' }] })
  assert.deepEqual(entries.map((entry) => entry.message), ['first', 'second'])
})

test('parseMessage takes the pipe fields, the logger and the text from the first line', () => {
  const parsed = parseMessage(cartError({ at: '2026-11-26 10:15:02.123 GMT' }).message)
  assert.deepEqual(parsed.fields, ['PipelineCallServlet', '1186012345', 'Sites-Example-Site', 'Cart-AddProduct', 'PipelineCall', 'k3Jd8sLq0aZx2Vb7Nn4Mc1Pq'])
  assert.equal(parsed.site, 'Sites-Example-Site')
  assert.equal(parsed.pipeline, 'Cart-AddProduct')
  assert.equal(parsed.logger, 'system.core')
  assert.match(parsed.text, /^ISH-CORE-2368 Error executing script/)
  assert.ok(!parsed.text.includes('Sites-Example-Site|'), 'the fields are not in the text')

  const custom = parseMessage(paymentError('2026-11-26 09:00:00.500 GMT', '00012345', 'jane.doe@example.com', '59.90').message)
  assert.equal(custom.logger, 'custom.PaymentService')
  assert.match(custom.text, /^Payment authorization failed/, 'the level and the dash are dropped')
  assert.deepEqual(custom.frames, [])
  assert.deepEqual(custom.trace, [])

  const noSession = parseMessage(jobError('2026-11-25 23:59:58.001 GMT').message)
  assert.deepEqual(noSession.fields, ['JobThread', '2201', 'Sites-Example-Site', 'ExportOrders', 'JobExecutor', ''])
  assert.equal(noSession.logger, 'system.job')
  assert.equal(noSession.pipeline, 'ExportOrders')
})

test('parseMessage reads a first line with no fields or no logger as text', () => {
  assert.deepEqual(parseMessage('Something broke'), { fields: [], site: null, pipeline: null, logger: null, text: 'Something broke', trace: [], frames: [] })
  const noLogger = parseMessage('Thread|1|Sites-A-Site|Home-Show|PipelineCall|abc plain words here')
  assert.equal(noLogger.logger, null)
  assert.equal(noLogger.text, 'plain words here')
  const pipeInText = parseMessage('Thread|1|Sites-A-Site|Home-Show|PipelineCall|abc custom.X value a|b failed')
  assert.equal(pipeInText.logger, 'custom.X')
  assert.equal(pipeInText.text, 'value a|b failed')
  assert.equal(parseMessage('').text, '')
  assert.deepEqual(parseMessage('line one\r\nline two').trace, ['line two'])
})

test('parseMessage takes the trace and its frames, top first, script and Java alike', () => {
  const parsed = parseMessage(cartError({ at: '2026-11-26 10:15:02.123 GMT' }).message)
  assert.equal(parsed.trace[0], 'System Information')
  assert.deepEqual(parsed.frames, [
    { file: 'app_example/cartridge/scripts/helpers/cartHelper.js', function: 'calculateLineTotal', line: 118, script: true },
    { file: 'app_example/cartridge/scripts/helpers/cartHelper.js', function: 'addProductToCart', line: 64, script: true },
    { file: 'app_example/cartridge/controllers/Cart.js', function: 'addProduct', line: 42, script: true },
    { file: 'ScriptRunner.java', function: 'example.engine.ScriptRunner.call', line: 210, script: false },
    { file: 'RequestHandler.java', function: 'example.engine.RequestHandler.handle', line: 57, script: false }
  ])
})

test('parseFrame reads each form of a frame, and refuses other lines', () => {
  assert.deepEqual(parseFrame('\tat app_x/cartridge/scripts/a.js:12 (run)'), { file: 'app_x/cartridge/scripts/a.js', function: 'run', line: 12, script: true })
  assert.deepEqual(parseFrame('  at /app_x/cartridge/scripts/a.ds:7'), { file: 'app_x/cartridge/scripts/a.ds', function: null, line: 7, script: true })
  assert.deepEqual(parseFrame('at app_x/cartridge/templates/default/a.isml'), { file: 'app_x/cartridge/templates/default/a.isml', function: null, line: null, script: true })
  assert.deepEqual(parseFrame('\tat app_x/cartridge/scripts/a.js#30 ()'), { file: 'app_x/cartridge/scripts/a.js', function: null, line: 30, script: true })
  assert.deepEqual(parseFrame('\tat example.A.b(A.java:3)'), { file: 'A.java', function: 'example.A.b', line: 3, script: false })
  assert.deepEqual(parseFrame('\tat example.A.<init>(Native Method)'), { file: 'Native Method', function: 'example.A.<init>', line: null, script: false })
  for (const line of ['Stack trace', 'System Information', 'at', '\tat ', 'URI: /on/demandware.store/x', 'what is at stake']) assert.equal(parseFrame(line), null, line)
})

test('filtersOf keeps plain prefixes and falls back to the error logs', () => {
  assert.deepEqual(filtersOf('error,customerror'), ['error', 'customerror'])
  assert.deepEqual(filtersOf(' error , custom-cart  customerror,error'), ['error', 'custom-cart', 'customerror'])
  assert.deepEqual(filtersOf('error,--server,-x,a b&c'), ['error', 'a'])
  for (const nothing of ['', '  ', ',', '&&', 42, null]) assert.deepEqual(filtersOf(nothing), ['error', 'customerror'], String(nothing))
})
