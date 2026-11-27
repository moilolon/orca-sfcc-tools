// The command line's error diff (bin/errors.ts) over a fake b2c, an invented dw.json and a
// throwaway data folder: the report in text and JSON, an environment that cannot be read, one
// with nothing new, a signature marked in seen.json, the cursor of report.json, what the output
// may never hold, and that it runs under plain Node.
import { assert, test } from 'orca/testing'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoSecrets, fakeSpawner, INVENTED_DW, makeWorkspace, type SpawnCall } from '../../core/test-support'
import { main, parseArguments, parseSince } from './cli'
import { dataFiles } from './data-folder'
import { cartError, jobError, LOGS_GET, paymentError } from './fixtures/logs'
import { parseTimestamp } from './reader'
import { FIRST_REPORT_MS, nextCursor, REPORT_OVERLAP_MS, type Report } from './report'
import { signatureOf } from './signature'

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)
const HOME = '/home/someone'
const MACHINE = {
  platform: 'linux',
  env: { PATH: '/fake/bin' },
  homedir: HOME,
  isFile: async (path: string) => path === '/fake/bin/b2c',
  isDirectory: async () => true,
  killTree: (child: { kill(): boolean }) => void child.kill()
}

/** What each instance's `logs get` answers, by its host; a host missing here fails. */
type Answers = Record<string, () => unknown>

/** As b2c: only the entries stamped at or after `--since`. */
function b2cFor(answers: Answers) {
  return (call: SpawnCall) => {
    const answer = answers[call.options.env.SFCC_SERVER ?? '']
    if (call.args[0] !== 'logs' || call.args[1] !== 'get' || !answer) return call.child.finish(1, '', 'ERROR: unreachable\n')
    const since = Date.parse(call.args.find((arg) => arg.startsWith('--since='))?.slice('--since='.length) ?? '')
    const all = answer() as { entries: { timestamp: string }[] }
    const entries = all.entries.filter((entry) => Number.isNaN(since) || (parseTimestamp(entry.timestamp) ?? 0) >= since)
    call.child.finish(0, JSON.stringify({ count: entries.length, entries }))
  }
}

type Setup = { root: string; data: string; configFile: string; done(): void }

function setup(): Setup {
  const root = makeWorkspace()
  const data = mkdtempSync(join(tmpdir(), 'sfcc-tools-report-'))
  return {
    root,
    data,
    configFile: join(root, 'dw.json'),
    done() {
      rmSync(root, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  }
}

/** One run of the command line: its exit code, what it printed, and every b2c call. */
async function run(s: Setup, args: string[], answers: Answers, { now = NOW, write }: { now?: number; write?: (text: string) => Promise<void> } = {}) {
  const out: string[] = []
  const err: string[] = []
  const spawn = fakeSpawner(b2cFor(answers))
  const code = await main(['--config-file', s.configFile, ...args], {
    write: write ?? (async (text) => void out.push(text)),
    writeError: async (text) => void err.push(text),
    env: { LANG: 'en_GB.UTF-8' },
    now: () => now,
    cwd: s.root,
    dataFolder: s.data,
    runner: { ...MACHINE, spawn: spawn.spawn }
  })
  return { code, out: out.join(''), err: err.join(''), calls: spawn.calls }
}

const json = (text: string) => JSON.parse(text) as Report
const ALL_ROLES = ['--role', 'sandbox', '--role', 'development', '--role', 'staging', '--role', 'production']
const SANDBOX = INVENTED_DW.hostname
const DEVELOPMENT = INVENTED_DW['hostname-dev']

/** The signature of the payment error, as the worker would have recorded it. */
const PAYMENT = signatureOf(LOGS_GET.entries.find((entry) => entry.message.includes('Payment'))!.message).signature

function writeSeen(s: Setup, roles: Record<string, Record<string, unknown>>) {
  writeFileSync(dataFiles(s.data).seen, JSON.stringify({ version: 1, roles }))
}

function reportFile(s: Setup): { version: number; roles: Record<string, { lastReportAt: number; reported: string[]; counted: string[] }> } | null {
  const path = dataFiles(s.data).report
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

test('the report in JSON: new errors per environment, one marked in seen.json left out, one with nothing new, two that cannot be read', async () => {
  const s = setup()
  try {
    const record = { firstSeen: 1, lastSeen: 2, count: 1, sample: { message: 'm', logger: null, frames: [] } }
    // The panel marked the payment error on the sandbox; the cart error is in its list but new.
    writeSeen(s, { sandbox: { [PAYMENT]: { ...record, markedAt: 2 }, other: record } })
    const { code, out, calls } = await run(s, ['--json', ...ALL_ROLES], { [SANDBOX]: () => LOGS_GET, [DEVELOPMENT]: () => ({ count: 0, entries: [] }) })
    const report = json(out)
    assert.equal(code, 1, 'staging and production could not be read')
    assert.equal(report.version, 1)
    assert.equal(report.generatedAt, new Date(NOW).toISOString())
    assert.equal(report.config, 'ok')
    assert.equal(report.seenList, 'ok')
    assert.equal(report.lastReport, 'missing')
    assert.deepEqual(report.roles.map((role) => [role.role, role.read]), [['sandbox', true], ['development', true], ['staging', false], ['production', false]])
    const [sandbox, development, staging, production] = report.roles
    if (!sandbox.read || !development.read || staging.read || production.read) throw new Error('unexpected shape')
    // Five signatures in the fixtures; the payment error is marked.
    assert.equal(sandbox.new.length, 4)
    assert.equal(sandbox.unmarked.length, 0)
    assert.equal(sandbox.marked, 1)
    assert.ok(!sandbox.new.some((row) => row.signature === PAYMENT))
    assert.equal(sandbox.since, new Date(NOW - FIRST_REPORT_MS).toISOString())
    assert.equal(sandbox.mayHaveMissed, false)
    const cart = sandbox.new[0]
    assert.equal(cart.count, 2, 'the cart error twice, most frequent first')
    assert.equal(cart.firstSeen, '2026-11-26T10:15:02.123Z')
    assert.equal(cart.lastSeen, '2026-11-26T11:40:19.877Z')
    assert.match(cart.message, /^ISH-CORE-2368 Error executing script 'app_example\/cartridge\/controllers\/Cart\.js': TypeError: Cannot read property <q> of undefined/)
    assert.deepEqual(cart.frame, { file: 'app_example/cartridge/scripts/helpers/cartHelper.js', function: 'calculateLineTotal' })
    assert.equal(cart.logger, 'system.core')
    assert.equal(cart.pipeline, null)
    assert.deepEqual(Object.keys(cart).sort(), ['count', 'firstSeen', 'frame', 'lastSeen', 'logger', 'message', 'pipeline', 'signature'])
    assert.deepEqual([development.new, development.unmarked, development.marked], [[], [], 0], 'nothing new')
    assert.deepEqual(staging, { role: 'staging', read: false, error: 'credentials_missing' })
    assert.deepEqual(production, { role: 'production', read: false, error: 'role_not_configured' })
    // Only the two that can be read are asked, with the worker's own arguments, and never the file.
    assert.deepEqual(calls.map((call) => call.options.env.SFCC_SERVER), [SANDBOX, DEVELOPMENT])
    assert.deepEqual(calls[0].args.filter((arg) => !arg.startsWith('--since')), ['logs', 'get', '--no-normalize', '--filter=error', '--filter=customerror', '--level=ERROR', '--level=FATAL', '--count=200', '--json'])
    for (const call of calls) assertNoSecrets(call.args.join(' '), 'the arguments')
    // The cursor moved for the environments read, and only for them.
    const cursor = reportFile(s)
    assert.deepEqual(Object.keys(cursor?.roles ?? {}).sort(), ['development', 'sandbox'])
    // Development read nothing: its cursor keeps the start of this window, for the next report.
    assert.equal(cursor?.roles.development.lastReportAt, NOW - FIRST_REPORT_MS)
    // The newest entry's own time, not the clock of the machine.
    assert.equal(cursor?.roles.sandbox.lastReportAt, Date.UTC(2026, 10, 26, 11, 40, 19, 877))
    assert.deepEqual(cursor?.roles.sandbox.reported.sort(), sandbox.new.map((row) => row.signature).sort())
    // seen.json is read, never written.
    assert.deepEqual(JSON.parse(readFileSync(dataFiles(s.data).seen, 'utf8')).roles.sandbox.other, record)
  } finally {
    s.done()
  }
})

test('the next report reads since the last one: what it listed and nobody marked is still unmarked, the rest is new', async () => {
  const s = setup()
  try {
    const first = await run(s, ['--json', '--role', 'sandbox'], { [SANDBOX]: () => LOGS_GET })
    assert.equal(first.code, 0)
    const listed = json(first.out).roles[0]
    if (!listed.read) throw new Error('not read')
    // An hour later: the cart error again, and a payment error never seen; the panel marked the job error.
    const job = listed.new.find((row) => row.message.startsWith('Job step failed'))!
    writeSeen(s, { sandbox: { [job.signature]: { firstSeen: 1, lastSeen: 2, count: 1, markedAt: 3, sample: { message: 'm', logger: null, frames: [] } } } })
    const later = NOW + 3_600_000
    const at = '2026-11-26 12:30:00.000 GMT'
    const second = await run(s, ['--role', 'sandbox', '--json'], { [SANDBOX]: () => ({ entries: [cartError({ at }), paymentError(at, '00099999', 'alex.doe@example.com', '10.00'), cartError({ at, errorClass: 'RangeError' })] }) }, { now: later })
    assert.equal(second.code, 0)
    const newest = Date.UTC(2026, 10, 26, 11, 40, 19, 877)
    assert.ok(second.calls[0].args.includes(`--since=${new Date(newest - REPORT_OVERLAP_MS).toISOString()}`), 'a few minutes before the newest entry of the last report')
    const role = json(second.out).roles[0]
    if (!role.read) throw new Error('not read')
    assert.equal(role.since, new Date(newest - REPORT_OVERLAP_MS).toISOString())
    assert.deepEqual(role.unmarked.map((row) => row.message.slice(0, 20)).sort(), ['ISH-CORE-2368 Error ', 'Payment authorizatio'])
    assert.equal(role.new.length, 1, 'the cart error with another class')
    assert.match(role.new[0].message, /RangeError/)
    const cursor = reportFile(s)?.roles.sandbox
    assert.equal(cursor?.lastReportAt, Date.UTC(2026, 10, 26, 12, 30))
    assert.ok(!cursor?.reported.includes(job.signature), 'a marked signature is dropped from the cursor')
    assert.ok(cursor?.reported.includes(role.new[0].signature))
  } finally {
    s.done()
  }
})

test('an entry another server flushed after the last report, stamped before it, is reported once; nothing is counted twice', async () => {
  const s = setup()
  try {
    // The bot's machine runs hours ahead of the instance: its clock plays no part in the cursor.
    const clock = Date.UTC(2026, 10, 26, 20, 0)
    const atA = '2026-11-26 09:00:00.000 GMT'
    const entryA = cartError({ at: atA })
    const first = await run(s, ['--json', '--role', 'sandbox'], { [SANDBOX]: () => ({ entries: [entryA] }) }, { now: clock })
    assert.equal(first.code, 0)
    assert.equal(reportFile(s)?.roles.sandbox.lastReportAt, Date.UTC(2026, 10, 26, 9))
    // After that report, another blade flushes two entries stamped ten seconds before it: the same
    // cart error, and a job error never seen.
    const late = '2026-11-26 08:59:50.000 GMT'
    const log = { entries: [entryA, cartError({ at: late, pid: '777' }), jobError(late)] }
    const second = await run(s, ['--json', '--role', 'sandbox'], { [SANDBOX]: () => log }, { now: clock + 60_000 })
    const role = json(second.out).roles[0]
    if (!role.read) throw new Error('not read')
    assert.equal(role.since, '2026-11-26T08:55:00.000Z')
    assert.deepEqual(role.new.map((row) => row.message.slice(0, 15)), ['Job step failed'])
    assert.equal(role.unmarked.length, 1)
    assert.equal(role.unmarked[0].count, 1, 'the cart error of the report before is not counted again')
    assert.equal(role.unmarked[0].lastSeen, '2026-11-26T08:59:50.000Z')
    // A third report over the same log finds nothing more.
    const third = await run(s, ['--json', '--role', 'sandbox'], { [SANDBOX]: () => log }, { now: clock + 120_000 })
    const again = json(third.out).roles[0]
    if (!again.read) throw new Error('not read')
    assert.deepEqual([again.new.length, again.unmarked.length], [0, 0])
  } finally {
    s.done()
  }
})

test('the report in text: per environment, its groups and rows, and why one was not read', async () => {
  const s = setup()
  try {
    const { code, out } = await run(s, ALL_ROLES, { [SANDBOX]: () => LOGS_GET, [DEVELOPMENT]: () => ({ entries: [] }) })
    assert.equal(code, 1)
    const lines = out.split('\n')
    assert.equal(lines[0], 'SFCC error report, 2026-11-26 12:00 UTC')
    assert.ok(lines.includes('No seen list yet: nothing is marked as seen.'))
    assert.ok(lines.includes('Sandbox: 5 new, 0 still unmarked, since 2026-11-25 12:00 UTC'))
    assert.ok(lines.includes('New since the last report'))
    assert.ok(lines.includes('Development: nothing new, nothing unmarked, since 2026-11-25 12:00 UTC'))
    assert.ok(lines.includes('Staging: not read (credentials_missing)'))
    assert.ok(lines.includes('Production: not read (role_not_configured)'))
    const cart = signatureOf(LOGS_GET.entries[0].message).signature
    assert.ok(lines.includes(`  - ${cart.slice(0, 8)}  2×  first 2026-11-26 10:15 UTC, last 2026-11-26 11:40 UTC`))
    assert.ok(lines.includes('    system.core · app_example/cartridge/scripts/helpers/cartHelper.js calculateLineTotal'))
    // A pipeline stands in for a frame only when there is none.
    assert.ok(lines.includes('    custom.PaymentService · COPlaceOrder-Submit'))

    let spanishOut = ''
    const spanish = await main(['--config-file', s.configFile, '--role', 'staging', '--lang', 'es'], { write: async (text) => void (spanishOut += text), env: {}, now: () => NOW, dataFolder: s.data, runner: MACHINE })
    assert.equal(spanish, 1)
    assert.ok(spanishOut.includes('Staging: sin leer (credentials_missing)'))
  } finally {
    s.done()
  }
})

test('nothing raw, no host, no credential and no stack beyond the top frame in any output', async () => {
  const s = setup()
  try {
    const secret = paymentError('2026-11-26 11:00:00.000 GMT', '00012345', 'jane.doe@example.com', '59.90')
    secret.message = secret.message.replace('Payment authorization failed', `Payment authorization failed at ${SANDBOX} for ${INVENTED_DW['client-id']}`)
    secret.raw = `[${secret.timestamp}] ERROR ${secret.message}`
    const answer = () => ({ entries: [...LOGS_GET.entries, secret] })
    const failing = { [SANDBOX]: answer }
    for (const args of [['--json'], []]) {
      const { out, err } = await run(s, [...args, ...ALL_ROLES, '--since', '2d'], failing)
      const printed = out + err
      assertNoSecrets(printed, 'the report')
      assert.ok(printed.includes('Payment authorization failed at *** for ***'), 'the host and the client id are masked')
      for (const entry of LOGS_GET.entries) {
        assert.ok(!printed.includes(entry.raw.slice(0, 60)), 'no raw entry')
        assert.ok(!printed.includes(entry.message.split('\n')[0]), 'no first line as written')
      }
      for (const never of [
        // Hosts, a customer, ids, the site and the request.
        'www.example.com',
        'example.org',
        'https:',
        'jane.doe@example.com',
        'k3Jd8sLq0aZx2Vb7Nn4Mc1Pq',
        '3f6c2a9e-1b7d-4c5e-9a0f-2d8e6b4c1a37',
        'Sites-Example-Site',
        'Sites-Other-Site',
        'pid=100234',
        '00012345',
        // The rest of an entry and of its stack: only the top frame's file and function.
        'System Information',
        'Stack trace',
        'addProductToCart',
        'controllers/Cart.js:',
        'ScriptRunner',
        'RequestHandler',
        'JobExecutor.execute',
        'Scheduler.fire',
        ':118',
        '#118',
        // The file read and the home folder.
        s.configFile,
        s.root,
        HOME
      ]) {
        assert.ok(!printed.includes(never), `${args.join(' ') || 'text'}: ${never}`)
      }
    }
  } finally {
    s.done()
  }
})

test('report.json moves only once a report was printed whole, and only for what was read', async () => {
  const s = setup()
  try {
    const answers = { [SANDBOX]: () => LOGS_GET }
    // The output cannot be written (a closed pipe): nothing moves.
    await assert.rejects(
      run(s, ['--json', '--role', 'sandbox'], answers, {
        write: async () => {
          throw Object.assign(new Error('closed'), { code: 'EPIPE' })
        }
      })
    )
    assert.equal(reportFile(s), null)
    // A failed read moves nothing for that environment, the others move.
    const failed = await run(s, ['--json', '--role', 'sandbox', '--role', 'development'], answers)
    assert.equal(failed.code, 1)
    const development = json(failed.out).roles[1]
    assert.deepEqual(development, { role: 'development', read: false, error: 'b2c_failed' })
    assert.deepEqual(Object.keys(reportFile(s)?.roles ?? {}), ['sandbox'])
    // A report.json that cannot be read is never overwritten, and the run says so.
    writeFileSync(dataFiles(s.data).report, 'broken')
    const broken = await run(s, ['--role', 'sandbox'], answers)
    assert.equal(broken.code, 1)
    assert.ok(broken.out.includes('The last report could not be read: its cursor is not moved.'))
    assert.equal(readFileSync(dataFiles(s.data).report, 'utf8'), 'broken')
    // A seen list that cannot be read: everything counts as unmarked, and the run says so.
    rmSync(dataFiles(s.data).report)
    writeFileSync(dataFiles(s.data).seen, '{')
    const unseen = await run(s, ['--json', '--role', 'sandbox'], answers)
    assert.equal(unseen.code, 1)
    assert.equal(json(unseen.out).seenList, 'invalid')
    assert.equal(readFileSync(dataFiles(s.data).seen, 'utf8'), '{')
  } finally {
    s.done()
  }
})

test('a dw.json that is not there makes every environment unreadable, without its path', async () => {
  const s = setup()
  try {
    rmSync(s.configFile)
    const { code, out } = await run(s, ['--role', 'sandbox'], {})
    assert.equal(code, 1)
    assert.ok(out.includes('No dw.json at the path given.'))
    assert.ok(out.includes('Sandbox: not read (config_missing)'))
    assert.ok(!out.includes(s.root))
  } finally {
    s.done()
  }
})

test('the arguments: both forms of a flag, a duration or a time for --since, and what is refused', () => {
  assert.deepEqual(parseArguments(['--config-file=a/dw.json', '--role', 'sandbox', '--role=staging', '--role', 'sandbox', '--json'], NOW), {
    configFile: 'a/dw.json',
    roles: ['sandbox', 'staging'],
    json: true,
    since: null,
    lang: null,
    help: false
  })
  assert.equal(parseSince('12h', NOW), NOW - 12 * 3_600_000)
  assert.equal(parseSince('90m', NOW), NOW - 90 * 60_000)
  assert.equal(parseSince('2d', NOW), NOW - 2 * 86_400_000)
  assert.equal(parseSince('2026-11-26T06:00:00Z', NOW), Date.UTC(2026, 10, 26, 6))
  for (const bad of ['yesterday', '12', '-1h', '']) assert.equal(parseSince(bad, NOW), null, bad)
  assert.deepEqual(parseArguments(['--role', 'sandbox'], NOW), { error: 'usage.config' })
  assert.deepEqual(parseArguments(['--config-file', 'a', '--config-file', 'b', '--role', 'sandbox'], NOW), { error: 'usage.config' })
  assert.deepEqual(parseArguments(['--config-file', 'a'], NOW), { error: 'usage.role' })
  assert.deepEqual(parseArguments(['--config-file', 'a', '--role', 'qa'], NOW), { error: 'usage.roleUnknown' })
  assert.deepEqual(parseArguments(['--config-file', 'a', '--role', 'sandbox', '--since', 'soon'], NOW), { error: 'usage.since' })
  assert.deepEqual(parseArguments(['--config-file', 'a', '--role', 'sandbox', '--lang', 'fr'], NOW), { error: 'usage.lang' })
  assert.deepEqual(parseArguments(['--config-file', 'a', '--role', 'sandbox', '--server', 'x'], NOW), { error: 'usage.unknown' })
  assert.equal((parseArguments(['--help'], NOW) as { help: boolean }).help, true)
})

test('wrong arguments exit 2 with one line on stderr, and nothing is read', async () => {
  const err: string[] = []
  const out: string[] = []
  const code = await main(['--role', 'sandbox'], { write: async (text) => void out.push(text), writeError: async (text) => void err.push(text), env: {}, now: () => NOW, runner: MACHINE })
  assert.equal(code, 2)
  assert.deepEqual(out, [])
  assert.equal(err.join(''), 'Wrong arguments: give --config-file once. See --help.\n')
})

/** The relative imports of a module, and of every module they reach. */
function reachable(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen
  seen.add(file)
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^'"]*?from\s*['"](\.[^'"]+)['"]/gm)) {
    // An `import type` is erased before the module runs: Node never loads it.
    if (match[1]) continue
    const spec = match[2]
    assert.ok(spec.endsWith('.ts'), `${file} imports ${spec} without .ts`)
    reachable(resolve(dirname(file), spec), seen)
  }
  return seen
}

test('bin/errors.ts runs under plain Node: every module it reaches imports explicit .ts files', () => {
  const bin = fileURLToPath(new URL('../../../bin/errors.ts', import.meta.url))
  const modules = reachable(bin)
  assert.ok(modules.size >= 10)
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 18)) return
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8' } })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /^Usage: node bin\/errors\.ts --config-file <dw\.json> --role <role>\.\.\./)
  const wrong = spawnSync(process.execPath, [bin, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8' } })
  assert.equal(wrong.status, 2)
})

/** One run over `log` at `now`, as JSON, for the sandbox. */
async function sandboxReport(s: Setup, log: () => unknown, now: number) {
  const { code, out } = await run(s, ['--json', '--role', 'sandbox'], { [SANDBOX]: log }, { now })
  assert.equal(code, 0)
  const role = json(out).roles[0]
  if (!role.read) throw new Error('not read')
  return role
}

test('an entry exactly on the overlap boundary is counted once, however many reports read it again', async () => {
  const s = setup()
  try {
    // The newest entry at 11:05, and one exactly five minutes before it, on a log that stays quiet.
    const log = () => ({ entries: [jobError('2026-11-26 11:00:00.000 GMT'), cartError({ at: '2026-11-26 11:05:00.000 GMT' })] })
    const first = await sandboxReport(s, log, NOW)
    assert.equal(first.new.length, 2)
    for (const later of [NOW + 60_000, NOW + 120_000]) {
      const again = await sandboxReport(s, log, later)
      assert.equal(again.since, '2026-11-26T11:00:00.000Z', 'the boundary entry is in the window')
      assert.deepEqual([again.new.length, again.unmarked.length], [0, 0], 'and counted already')
    }
  } finally {
    s.done()
  }
})

test('an entry stamped in the future never moves the cursor past the run itself', async () => {
  const s = setup()
  try {
    // One server's clock runs a day ahead.
    const future = jobError('2026-11-27 11:00:00.000 GMT')
    const first = await sandboxReport(s, () => ({ entries: [future] }), NOW)
    assert.equal(first.new.length, 1)
    assert.equal(reportFile(s)?.roles.sandbox.lastReportAt, NOW, 'held at the time of the run')
    // Another server writes an ordinary entry after the run.
    const ordinary = cartError({ at: '2026-11-26 12:30:00.000 GMT' })
    const second = await sandboxReport(s, () => ({ entries: [future, ordinary] }), NOW + 3_600_000)
    assert.deepEqual(second.new.map((row) => row.message.slice(0, 13)), ['ISH-CORE-2368'], 'the ordinary entry is listed')
    assert.equal(second.unmarked.length, 0, 'the future entry is not counted again')
    assert.equal(reportFile(s)?.roles.sandbox.lastReportAt, Date.UTC(2026, 10, 26, 13), 'held at the second run')
  } finally {
    s.done()
  }
})

test('an empty first report keeps its window start: an entry stamped just before it and flushed after is read a day later', async () => {
  const s = setup()
  try {
    const first = await sandboxReport(s, () => ({ entries: [] }), NOW)
    assert.deepEqual([first.new.length, first.since], [0, new Date(NOW - FIRST_REPORT_MS).toISOString()])
    assert.equal(reportFile(s)?.roles.sandbox.lastReportAt, NOW - FIRST_REPORT_MS)
    // Stamped ten seconds before the first report, flushed after it; the bot runs again a day later.
    const late = cartError({ at: '2026-11-26 11:59:50.000 GMT' })
    const second = await sandboxReport(s, () => ({ entries: [late] }), NOW + FIRST_REPORT_MS)
    assert.equal(second.since, new Date(NOW - FIRST_REPORT_MS - REPORT_OVERLAP_MS).toISOString())
    assert.equal(second.new.length, 1)
    assert.equal(reportFile(s)?.roles.sandbox.lastReportAt, Date.UTC(2026, 10, 26, 11, 59, 50), 'from then on, the entries\' own times')
  } finally {
    s.done()
  }
})

test('nextCursor: newest entry, never past the run, never back, the window start before any entry', () => {
  const run = { now: 1_000_000, since: 100_000 }
  const entry = (at: number) => ({ at, key: `s@${at}` })
  assert.deepEqual(nextCursor(null, [], run), { lastReportAt: 100_000, reported: [], counted: [] })
  assert.equal(nextCursor(null, [entry(500_000)], run).lastReportAt, 500_000)
  assert.equal(nextCursor(null, [entry(5_000_000)], run).lastReportAt, 1_000_000)
  assert.equal(nextCursor({ lastReportAt: 900_000, reported: [], counted: [] }, [entry(500_000)], run).lastReportAt, 900_000)
  const boundary = 500_000 - REPORT_OVERLAP_MS
  assert.deepEqual(nextCursor(null, [entry(boundary - 1), entry(boundary), entry(500_000)], { ...run, since: 0 }).counted, [`s@${boundary}`, 's@500000'])
})
