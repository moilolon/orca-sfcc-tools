// Opening a file through `orca file open`, or in the plugin's own editor through `orca plugin
// open --editor`, over a fake process: the executable it picks, the
// environment and the arguments it gives, and the paths it refuses.
import { assert, test } from 'orca/testing'
import { fakeSpawner } from './test-support'
import { readFileSync } from 'node:fs'
import { createOpenFile, EditorOpens, editorTakes, isInside, openArguments, orcaEnvironment, pluginKeyIn, pluginOpenArguments, type OpenFileDeps, type OpenFileSpawnOptions } from './open-file'
import type { SpawnCall } from './test-support'

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

test('a folder whose name starts with two dots is inside the workspace', async () => {
  assert.ok(isInside('C:\\work\\shop', 'C:\\work\\shop\\..cache\\a.js', 'win32'))
  assert.ok(isInside('/w', '/w/..cache/a.js', 'linux'))
  assert.ok(!isInside('/w', '/w/../a.js', 'linux'))
  assert.ok(!isInside('/w', '/', 'linux'))
  const odd = 'C:\\work\\shop\\..cache\\a.js'
  const { open, calls } = windows({}, [WINDOWS_ORCA, odd])
  assert.deepEqual(await open({ root: WINDOWS_ROOT, path: odd }), { opened: true })
  assert.equal(calls[0].args[2], odd)
})

test('the file opened is the one checked: a link inside the workspace opens its target', async () => {
  const link = 'C:\\work\\shop\\link.js'
  const target = 'C:\\work\\shop\\cartridges\\real.js'
  const { open, calls } = windows({ realPath: async (path) => (path === link ? target : path) }, [WINDOWS_ORCA, link, target])
  assert.deepEqual(await open({ root: WINDOWS_ROOT, path: 'link.js' }), { opened: true })
  assert.equal(calls[0].args[2], target)
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

// ---- In the plugin's own editor ----

const TEMPLATE = 'C:\\work\\shop\\cartridges\\app_x\\cartridge\\templates\\default\\cart.isml'

/** What `orca plugin list --json` prints: this plugin running under `key`, beside others. */
function listed(plugins: { pluginKey: string; status: string }[]): string {
  return JSON.stringify({ ok: true, result: { plugins: [{ pluginKey: 'stablyai.orca-github-vscode-theme', status: 'idle' }, ...plugins] } })
}

/** A Windows machine where `plugin list` prints `list` and `plugin open` exits with `openCode`. */
function editorMachine(list: string, openCode = 0) {
  const script = (call: SpawnCall) => {
    if (call.args[0] === 'plugin' && call.args[1] === 'list') call.child.finish(0, list)
    else if (call.args[0] === 'plugin' && call.args[1] === 'open') call.child.finish(openCode, '{"ok":true}')
    else call.child.finish(0, '{"ok":true}')
  }
  const spawner = fakeSpawner(script)
  const opens = new EditorOpens()
  const open = createOpenFile({
    spawn: spawner.spawn,
    platform: 'win32',
    execPath: 'C:\\Program Files\\Orca\\Orca.exe',
    env: { PATH: 'C:\\Windows\\system32' },
    homedir: 'C:\\Users\\someone',
    isFile: async (path) => [WINDOWS_ORCA, FILE, TEMPLATE, 'C:\\work\\shop\\package.json'].includes(path),
    realPath: async (path) => (path === WINDOWS_ROOT || [FILE, TEMPLATE, 'C:\\work\\shop\\package.json'].includes(path) ? path : null),
    editorOpens: opens,
    now: () => 5
  })
  return { open, calls: spawner.calls, opens }
}

test('inEditor: the plugin’s key is found in the list of running plugins, the open recorded, then plugin open --editor', async () => {
  const { open, calls, opens } = editorMachine(listed([{ pluginKey: 'local.sfcc-tools', status: 'running' }]))
  assert.deepEqual(await open({ root: WINDOWS_ROOT, path: 'cartridges\\app_x\\cartridge\\templates\\default\\cart.isml', line: 12, column: 3, focus: true, inEditor: true }), { opened: true })
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['plugin', 'list', '--json'],
      ['plugin', 'open', 'local.sfcc-tools', '--editor', TEMPLATE, '--json']
    ]
  )
  for (const call of calls) {
    assert.equal(call.file, WINDOWS_ORCA, 'orca.exe directly')
    const options = call.options as unknown as OpenFileSpawnOptions
    assert.equal(options.shell, false)
    assert.equal(options.windowsVerbatimArguments, false)
    assert.equal(options.cwd, WINDOWS_ROOT)
    assert.equal(options.env.APPDATA, 'C:\\Users\\someone\\AppData\\Roaming')
  }
  assert.deepEqual(opens.under(WINDOWS_ROOT, 'win32'), [{ root: WINDOWS_ROOT, file: TEMPLATE, line: 12, column: 3, at: 5 }])
  // The key is asked once; an installed plugin's key works the same.
  await open({ root: WINDOWS_ROOT, path: FILE, inEditor: true })
  assert.equal(calls.filter((call) => call.args[1] === 'list').length, 1)
  assert.deepEqual(calls[2].args, pluginOpenArguments('local.sfcc-tools', FILE))
  assert.equal(pluginKeyIn(listed([{ pluginKey: 'moilolon.sfcc-tools', status: 'running' }])), 'moilolon.sfcc-tools')
})

test('inEditor: no running copy, or two, or a list that does not parse: the file opens in Orca’s editor at its line', async () => {
  const lists = [
    listed([{ pluginKey: 'local.sfcc-tools', status: 'idle' }]),
    listed([
      { pluginKey: 'local.sfcc-tools', status: 'running' },
      { pluginKey: 'moilolon.sfcc-tools', status: 'running' }
    ]),
    listed([{ pluginKey: 'local.sfcc-tools-extra', status: 'running' }]),
    'not json'
  ]
  for (const list of lists) {
    const { open, calls, opens } = editorMachine(list)
    assert.deepEqual(await open({ root: WINDOWS_ROOT, path: TEMPLATE, line: 4, inEditor: true }), { opened: true })
    assert.deepEqual(calls[1].args, ['file', 'open', TEMPLATE, '--worktree', `path:${WINDOWS_ROOT}`, '--line', '4', '--json'], list)
    assert.equal(opens.under(WINDOWS_ROOT, 'win32').length, 0, 'nothing recorded')
    // The failed search is not repeated on the next jump (the clock has not moved).
    await open({ root: WINDOWS_ROOT, path: TEMPLATE, inEditor: true })
    assert.equal(calls.filter((call) => call.args[1] === 'list').length, 1)
  }
})

test('inEditor: a plugin open that fails falls back to orca file open; a file type the editor does not take never asks', async () => {
  const failing = editorMachine(listed([{ pluginKey: 'local.sfcc-tools', status: 'running' }]), 1)
  assert.deepEqual(await failing.open({ root: WINDOWS_ROOT, path: TEMPLATE, line: 2, inEditor: true }), { opened: true })
  assert.deepEqual(
    failing.calls.map((call) => call.args[0] + ' ' + call.args[1]),
    ['plugin list', 'plugin open', 'file open']
  )
  const other = editorMachine(listed([{ pluginKey: 'local.sfcc-tools', status: 'running' }]))
  await other.open({ root: WINDOWS_ROOT, path: 'package.json', inEditor: true })
  assert.deepEqual(other.calls.map((call) => call.args[0] + ' ' + call.args[1]), ['file open'])
  assert.ok(editorTakes('a/B.ISML') && editorTakes('x.properties') && !editorTakes('x.json') && !editorTakes('x.isml.bak'))
})

test('inEditor keeps every condition: outside the workspace or missing is refused before anything starts, a shim too', async () => {
  const { open, calls } = editorMachine(listed([{ pluginKey: 'local.sfcc-tools', status: 'running' }]))
  for (const path of ['..\\other\\a.isml', 'D:\\elsewhere\\a.isml']) {
    assert.deepEqual(await open({ root: WINDOWS_ROOT, path, inEditor: true }), { opened: false, reason: 'outside_workspace' })
  }
  assert.deepEqual(await open({ root: WINDOWS_ROOT, path: 'missing.isml', inEditor: true }), { opened: false, reason: 'not_found' })
  assert.equal(calls.length, 0)
  const shim = windows({ env: { PATH: 'C:\\tools' } }, ['C:\\tools\\orca.cmd', TEMPLATE])
  assert.deepEqual(await shim.open({ root: WINDOWS_ROOT, path: TEMPLATE, inEditor: true }), { opened: false, reason: 'orca_shim_refused' })
  assert.equal(shim.calls.length, 0)
})

test('the recorded opens are bounded, newest first, per workspace', () => {
  const opens = new EditorOpens()
  for (let i = 0; i < EditorOpens.MAX + 5; i++) opens.record({ root: 'C:\\work\\shop', file: `C:\\work\\shop\\f${i}.isml`, at: i })
  opens.record({ root: 'C:\\work\\other', file: 'C:\\work\\other\\x.isml', at: 99 })
  const mine = opens.under('c:\\WORK\\shop', 'win32')
  assert.equal(mine.length, EditorOpens.MAX - 1)
  assert.equal(mine[0].file, `C:\\work\\shop\\f${EditorOpens.MAX + 4}.isml`)
  const entry = { root: '/w', file: '/w/a.isml', line: 3, column: 2, at: 1 }
  opens.record(entry)
  opens.takeLine(entry)
  assert.deepEqual(opens.under('/w', 'linux')[0], { root: '/w', file: '/w/a.isml', at: 1 })
})
