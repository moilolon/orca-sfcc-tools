// The git reader over a fake process: the only three commands it runs, the refs and paths it
// refuses before git starts, a shim refused, no shell, the timeout, the cap on output, stderr
// never shown; then the checkout index's git-ref source over it.
import { assert, test } from 'orca/testing'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { CheckoutIndex, GitError } from './checkout'
import { createGitReader, findGit, gitEnvironment, unquoteGitPath, validGitPath, validRef, type GitChild, type GitSpawnOptions } from './git'
import { MemoryFiles } from './memory'
import { fixtureEntries } from './testing'

class FakeGitChild extends EventEmitter implements GitChild {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
  finish(code: number, stdout = '', stderr = ''): void {
    queueMicrotask(() => {
      if (stdout) this.stdout.emit('data', new TextEncoder().encode(stdout))
      if (stderr) this.stderr.emit('data', new TextEncoder().encode(stderr))
      this.emit('close', code)
    })
  }
}

type Call = { file: string; args: readonly string[]; options: GitSpawnOptions; child: FakeGitChild }

const COMMIT = 'c'.repeat(40)

function reader(answer: (call: Call) => void, options: { platform?: string; files?: string[]; timeoutMs?: number; maxBytes?: number } = {}) {
  const calls: Call[] = []
  const platform = options.platform ?? 'win32'
  const present = new Set(options.files ?? ['C:\\tools\\git\\cmd\\git.exe'])
  const git = createGitReader('C:\\work\\shop', {
    platform,
    env: { PATH: platform === 'win32' ? 'C:\\tools\\git\\cmd;C:\\other' : '/usr/bin', SECRET_LOOKING: 'kept as the worker has it' },
    isFile: async (path) => present.has(path),
    spawn: (file, args, spawnOptions) => {
      const child = new FakeGitChild()
      const call = { file, args, options: spawnOptions, child }
      calls.push(call)
      answer(call)
      return child
    },
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes
  })
  return { git, calls }
}

const coded = (code: string) => (error: unknown) => error instanceof GitError && error.code === code

test('git runs only rev-parse, ls-tree and show, directly, with no shell, in the workspace, with no optional lock', async () => {
  const { git, calls } = reader((call) => {
    if (call.args[0] === 'rev-parse') call.child.finish(0, `${COMMIT}\n`)
    else if (call.args[0] === 'ls-tree') call.child.finish(0, 'sites/a/sites/Shop/site.xml\n"sites/a/meta/caf\\303\\251.xml"\n')
    else call.child.finish(0, '<site/>')
  })
  assert.equal(await git.commit('origin/main'), COMMIT)
  assert.deepEqual(await git.list(COMMIT, ''), ['sites/a/sites/Shop/site.xml', 'sites/a/meta/café.xml'])
  assert.equal(await git.read(COMMIT, 'sites/a/sites/Shop/site.xml'), '<site/>')
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'],
      ['ls-tree', '--full-tree', '-r', '--name-only', COMMIT, '--', '.'],
      ['show', `${COMMIT}:sites/a/sites/Shop/site.xml`]
    ]
  )
  for (const call of calls) {
    assert.equal(call.file, 'C:\\tools\\git\\cmd\\git.exe')
    assert.equal(call.options.shell, false)
    assert.equal(call.options.windowsVerbatimArguments, false)
    assert.equal(call.options.cwd, 'C:\\work\\shop')
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, '0')
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0')
  }
})

test('a ref or path that could be read as an option, or leave the repository, is refused before git starts', async () => {
  const { git, calls } = reader((call) => call.child.finish(0, ''))
  for (const ref of ['-p', '--output=x', 'a..b', 'HEAD@{1}', 'main~1', 'a b', '', 'x'.repeat(201), 'a:b', '/main', 'main/', 'main^{tree}', 'a;b', 'a$(b)']) {
    assert.ok(!validRef(ref), ref)
    await assert.rejects(git.commit(ref), coded('ref_invalid'))
  }
  for (const ref of ['main', 'origin/main', 'release/2026.11', 'v1.2.3', 'feature/x_y-z', COMMIT]) assert.ok(validRef(ref), ref)
  for (const path of ['-x', '../x', 'a/../../x', '/etc', 'C:/x', 'a\\b', 'a//b', 'a/-b', 'a\nb', 'a:b']) {
    assert.ok(!validGitPath(path), path)
    await assert.rejects(git.read(COMMIT, path), coded('path_invalid'))
    await assert.rejects(git.list(COMMIT, path), coded('path_invalid'))
  }
  await assert.rejects(git.read(COMMIT, ''), coded('path_invalid'))
  assert.deepEqual(calls, [])
})

test('a git.cmd or git.bat found first on the PATH is refused; no git is git_not_found', async () => {
  const shim = reader((call) => call.child.finish(0, ''), { files: ['C:\\tools\\git\\cmd\\git.cmd', 'C:\\other\\git.exe'] })
  await assert.rejects(shim.git.commit('main'), coded('git_shim_refused'))
  assert.deepEqual(shim.calls, [])
  const none = reader((call) => call.child.finish(0, ''), { files: [] })
  await assert.rejects(none.git.commit('main'), coded('git_not_found'))
  assert.deepEqual(await findGit({ platform: 'linux', env: { PATH: '/a:/usr/bin' }, isFile: async (path) => path === '/usr/bin/git' }), { file: '/usr/bin/git' })
  assert.equal(gitEnvironment({ PATH: '/x', EMPTY: undefined }).EMPTY, undefined)
})

test('a failure is a code; what git printed on stderr never reaches it', async () => {
  const words = 'fatal: not a git repository: C:/work/private-shop-name'
  const { git } = reader((call) => {
    if (call.args[0] === 'rev-parse' && call.args[3] === 'missing^{commit}') call.child.finish(1, '')
    else call.child.finish(128, '', words)
  })
  assert.equal(await git.commit('missing'), null)
  for (const attempt of [() => git.commit('main'), () => git.list(COMMIT, 'sites'), () => git.read(COMMIT, 'sites/x.xml')]) {
    await assert.rejects(attempt(), (error: unknown) => error instanceof GitError && error.code === 'git_failed' && !error.message.includes('private'))
  }
})

test('git is stopped past its timeout and past the output cap', async () => {
  const slow = reader(() => {}, { timeoutMs: 20 })
  await assert.rejects(slow.git.commit('main'), coded('git_timeout'))
  assert.ok(slow.calls[0].child.killed)
  const large = reader((call) => call.child.finish(0, 'x'.repeat(2000)), { maxBytes: 1000 })
  await assert.rejects(large.git.list(COMMIT, ''), coded('git_output_too_large'))
  assert.ok(large.calls[0].child.killed)
})

test('the checkout index reads its paths from the ref through the git reader when the checkout has no site archive', async () => {
  const entries = fixtureEntries()
  const tree: Record<string, string> = {}
  const files = new MemoryFiles()
  for (const [path, text] of Object.entries(entries)) {
    if (path.startsWith('sites/')) tree[path] = text
    else files.set(path, text)
  }
  const { git, calls } = reader((call) => {
    if (call.args[0] === 'rev-parse') call.child.finish(0, `${COMMIT}\n`)
    else if (call.args[0] === 'ls-tree') call.child.finish(0, Object.keys(tree).join('\n') + '\n')
    else call.child.finish(0, tree[(call.args[1] as string).slice(COMMIT.length + 1)])
  })
  const index = new CheckoutIndex(files, { metadataRef: 'origin/main', git })
  await index.build()
  assert.deepEqual(
    index.storefronts().map((s) => [s.id, s.source]),
    [
      ['GardenOutlet', 'git-ref'],
      ['GardenShop', 'git-ref']
    ]
  )
  assert.equal(index.sitePreferences().length, 2)
  assert.ok(calls.every((call) => ['rev-parse', 'ls-tree', 'show'].includes(call.args[0] as string)))
})

test('unquoteGitPath reads git’s C-quoted names and leaves plain ones', () => {
  assert.equal(unquoteGitPath('plain/name.xml'), 'plain/name.xml')
  assert.equal(unquoteGitPath('"tab\\there"'), 'tab\there')
  assert.equal(unquoteGitPath('"quote\\"d"'), 'quote"d')
})

test('git.ts imports nothing of b2c.ts or dw-config.ts and never names dw.json', () => {
  const source = readFileSync(new URL('./git.ts', import.meta.url), 'utf8')
  assert.ok(!/from\s+['"][^'"]*(b2c|dw-config)['"]/.test(source))
  assert.ok(!/dw\.json|SFCC_/.test(source.replace(/\/\/.*$/gm, '')))
})
