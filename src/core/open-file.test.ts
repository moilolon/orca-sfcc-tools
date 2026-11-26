// Opening a file through `orca file open`, over a fake process: the executable it picks, the
// environment and the arguments it gives, and the paths it refuses.
import { assert, test } from 'orca/testing'
import { fakeSpawner } from './test-support'
import { readFileSync } from 'node:fs'
import { createOpenFile, isInside, openArguments, orcaEnvironment, type OpenFileDeps, type OpenFileSpawnOptions } from './open-file'

const WINDOWS_ORCA = 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe'
const WINDOWS_ROOT = 'C:\\work\\shop'
const FILE = 'C:\\work\\shop\\cartridges\\app_x\\cartridge\\scripts\\cart.js'

/** A Windows machine with Orca installed and one workspace holding one file. */
function windows(overrides: Partial<OpenFileDeps> = {}, files: string[] = [WINDOWS_ORCA, FILE]) {
  const spawner = fakeSpawner((call) => call.child.finish(0, '{"ok":true}'))
  const deps: OpenFileDeps = {
    spawn: spawner.spawn,
    platform: 'win32',
    execPath: 'C:\\Program Files\\Orca\\Orca.exe',
    // A worker's environment: no APPDATA.
    env: { PATH: 'C:\\Windows\\system32', PATHEXT: '.EXE;.CMD', SystemRoot: 'C:\\Windows' },
    homedir: 'C:\\Users\\someone',
    isFile: async (path) => files.includes(path),
    realPath: async (path) => (path === WINDOWS_ROOT || files.includes(path) ? path : null),
    ...overrides
  }
  return { open: createOpenFile(deps), calls: spawner.calls }
}

test('it runs the Orca beside the running one, with APPDATA and the workspace named', async () => {
  const { open, calls } = windows()
  const result = await open({ root: WINDOWS_ROOT, path: 'cartridges\\app_x\\cartridge\\scripts\\cart.js', line: 118, column: 3 })
  assert.deepEqual(result, { opened: true })
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call.file, WINDOWS_ORCA)
  assert.deepEqual(call.args, ['file', 'open', FILE, '--worktree', `path:${WINDOWS_ROOT}`, '--line', '118', '--column', '3', '--json'])
  assert.equal(call.options.cwd, WINDOWS_ROOT, 'never Orca’s install folder')
  // The worker's own environment, plus the three folders: nothing else.
  assert.deepEqual(call.options.env, {
    PATH: 'C:\\Windows\\system32',
    PATHEXT: '.EXE;.CMD',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\someone',
    APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local'
  })
  // Started directly: no shell, no verbatim command line.
  const options = call.options as unknown as OpenFileSpawnOptions
  assert.equal(options.shell, false)
  assert.equal(options.windowsVerbatimArguments, false)
  assert.equal(options.windowsHide, true)
  assert.ok(!call.args.includes('--focus'), 'no focus unless asked')
})

test('--focus only when the caller asks; a column only with a line', async () => {
  const { open, calls } = windows()
  await open({ root: WINDOWS_ROOT, path: FILE, line: 5, focus: true })
  await open({ root: WINDOWS_ROOT, path: FILE, column: 9 })
  assert.deepEqual(calls[0].args.slice(5), ['--line', '5', '--focus', '--json'])
  assert.deepEqual(calls[1].args.slice(5), ['--json'])
  assert.deepEqual(openArguments('a.js', '/w', { line: 0, column: 2 }), ['file', 'open', 'a.js', '--worktree', 'path:/w', '--json'])
  assert.deepEqual(openArguments('a.js', '/w', { line: 1.5 }), ['file', 'open', 'a.js', '--worktree', 'path:/w', '--json'])
})

test('a worker that has APPDATA keeps its own', () => {
  const env = orcaEnvironment({ appdata: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local', USERPROFILE: 'D:\\me' }, { platform: 'win32', homedir: 'C:\\Users\\someone' })
  assert.equal(env.appdata, 'D:\\Roaming')
  assert.equal(env.APPDATA, undefined)
  assert.equal(env.LOCALAPPDATA, 'D:\\Local')
  const linux = orcaEnvironment({ HOME: '/home/someone' }, { platform: 'linux', homedir: '/home/someone' })
  assert.deepEqual(linux, { HOME: '/home/someone' })
})

test('without Orca beside the running one, orca.exe on the PATH; a .cmd or .bat is refused', async () => {
  const onPath = 'C:\\tools\\orca.exe'
  const { open, calls } = windows({ env: { PATH: 'C:\\tools;C:\\other' } }, [onPath, 'C:\\other\\orca.cmd', FILE])
  assert.deepEqual(await open({ root: WINDOWS_ROOT, path: FILE, line: 1 }), { opened: true })
  assert.equal(calls[0].file, onPath)
  assert.equal(calls[0].args[0], 'file')

  for (const shim of ['C:\\tools\\orca.cmd', 'C:\\tools\\orca.bat']) {
    const refused = windows({ env: { PATH: 'C:\\tools;C:\\later' } }, [shim, 'C:\\later\\orca.exe', FILE])
    assert.deepEqual(await refused.open({ root: WINDOWS_ROOT, path: FILE }), { opened: false, reason: 'orca_shim_refused' }, shim)
    assert.equal(refused.calls.length, 0, 'nothing started through cmd.exe')
  }

  const none = windows({ env: { PATH: 'C:\\tools' } }, [FILE])
  assert.deepEqual(await none.open({ root: WINDOWS_ROOT, path: FILE }), { opened: false, reason: 'orca_not_found' })
  assert.equal(none.calls.length, 0)
})

test('the arguments are only file open, the path, the line and column, the workspace, --json and --focus', async () => {
  const { open, calls } = windows()
  await open({ root: WINDOWS_ROOT, path: FILE, line: 3, column: 4, focus: true })
  const allowed = new Set(['file', 'open', FILE, '--line', '3', '--column', '4', '--worktree', `path:${WINDOWS_ROOT}`, '--json', '--focus'])
  for (const arg of calls[0].args) assert.ok(allowed.has(arg), arg)
  assert.equal(calls[0].args.length, allowed.size)
})

test('open-file.ts imports nothing of b2c.ts or dw-config.ts', () => {
  const source = readFileSync(new URL('./open-file.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.deepEqual(imports.filter((spec) => /(^|\/)(b2c|dw-config)$/.test(spec)), [])
  assert.ok(/shell: false/.test(source) && !/shell:\s*true/.test(source), 'never a shell')
  assert.ok(!/['"]\/[cC]['"]|COMSPEC/.test(source), 'never cmd /c')
})

test('a path outside the workspace is refused before anything starts', async () => {
  const outside = 'C:\\work\\other\\secret.js'
  const { open, calls } = windows({}, [WINDOWS_ORCA, FILE, outside])
  for (const path of ['..\\other\\secret.js', outside, 'cartridges\\..\\..\\other\\secret.js', 'D:\\elsewhere\\a.js']) {
    assert.deepEqual(await open({ root: WINDOWS_ROOT, path }), { opened: false, reason: 'outside_workspace' }, path)
  }
  assert.equal(calls.length, 0)
})

test('a link inside the workspace that points out of it is refused', async () => {
  const link = 'C:\\work\\shop\\linked.js'
  const { open, calls } = windows({ realPath: async (path) => (path === link ? 'C:\\work\\other\\secret.js' : path) }, [WINDOWS_ORCA, link, 'C:\\work\\other\\secret.js'])
  assert.deepEqual(await open({ root: WINDOWS_ROOT, path: 'linked.js' }), { opened: false, reason: 'outside_workspace' })
  assert.equal(calls.length, 0)
})

test('a file that does not exist is not opened', async () => {
  const { open, calls } = windows()
  assert.deepEqual(await open({ root: WINDOWS_ROOT, path: 'missing.js' }), { opened: false, reason: 'not_found' })
  assert.equal(calls.length, 0)
})

test('a failing or hanging Orca is reported, and a hanging one is stopped', async () => {
  const failing = fakeSpawner((call) => call.child.finish(2, '', 'error'))
  const failed = createOpenFile({ ...baseLinux(), spawn: failing.spawn })
  assert.deepEqual(await failed({ root: '/w', path: 'a.js' }), { opened: false, reason: 'orca_failed' })

  const hanging = fakeSpawner(() => {})
  const timedOut = createOpenFile({ ...baseLinux(), spawn: hanging.spawn, timeoutMs: 20 })
  assert.deepEqual(await timedOut({ root: '/w', path: 'a.js' }), { opened: false, reason: 'orca_timeout' })
  assert.equal(hanging.calls[0].child.killed, true)

  const broken = fakeSpawner((call) => call.child.emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' })))
  const notStarted = createOpenFile({ ...baseLinux(), spawn: broken.spawn })
  assert.deepEqual(await notStarted({ root: '/w', path: 'a.js' }), { opened: false, reason: 'orca_failed' })
})

test('on Linux and macOS: the bundled orca, no environment added', async () => {
  const spawner = fakeSpawner((call) => call.child.finish(0))
  const open = createOpenFile({ ...baseLinux(), spawn: spawner.spawn })
  assert.deepEqual(await open({ root: '/w', path: 'a.js', line: 3 }), { opened: true })
  assert.equal(spawner.calls[0].file, '/opt/orca/resources/bin/orca')
  assert.deepEqual(spawner.calls[0].args, ['file', 'open', '/w/a.js', '--worktree', 'path:/w', '--line', '3', '--json'])
  assert.deepEqual(spawner.calls[0].options.env, { PATH: '/usr/bin' })
})

test('isInside compares whole path segments, ignoring case on Windows only', () => {
  assert.ok(isInside('C:\\work\\shop', 'c:\\WORK\\shop\\a.js', 'win32'))
  assert.ok(!isInside('C:\\work\\shop', 'C:\\work\\shop-other\\a.js', 'win32'))
  assert.ok(isInside('/w', '/w', 'linux'))
  assert.ok(!isInside('/w', '/W/a.js', 'linux'))
  assert.ok(!isInside('/w', '/w2/a.js', 'linux'))
})

function baseLinux(): OpenFileDeps {
  return {
    platform: 'linux',
    execPath: '/opt/orca/orca',
    env: { PATH: '/usr/bin' },
    homedir: '/home/someone',
    isFile: async (path) => ['/opt/orca/resources/bin/orca', '/w/a.js'].includes(path),
    realPath: async (path) => path
  }
}
