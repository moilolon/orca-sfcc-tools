// The editor piece's worker over a mock host and an invented workspace on disk: `editor.locate`'s
// three sources in order (a file the plugin opened, the last save, the workspace's files), the
// ambiguous case and the choice kept, the save hook (observed, never refusing), and the command.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test, type MockHost } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { B2c } from '../../core/b2c'
import { translator } from '../../core/i18n'
import { EditorOpens, type OpenFileRequest } from '../../core/open-file'
import type { PieceContext } from '../../core/piece'
import { createSettings } from '../../core/settings'
import { createStore } from '../../core/store'
import { createWorkspaces } from '../../core/workspaces'
import { hashText, Locator, MAX_CANDIDATES, OPEN_WINDOW_MS } from './locate'
import type { EditorLocated } from './protocol'
import { createEditorPiece, hashOf, OPEN_COMMAND, workspaceOfSave } from './worker'

const CAPABILITIES = ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
const TILE = '<isinclude template="product/components/price"/>\n<div class="tile">${product.name}</div>\n'
const HOME = '<isdecorate template="common/layout/page">\n    <isslot id="home-main" context="global"/>\n</isdecorate>\n'
const PROPS = 'cart.title=Your basket\r\ncart.empty=Nothing yet\r\n'

/** An invented workspace: two cartridges holding the same tile, a home page, a bundle, things never indexed. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sfcc-editor-'))
  const write = (path: string, text: string) => {
    mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(root, ...path.split('/')), text)
  }
  write('cartridges/app_one/cartridge/templates/default/product/tile.isml', TILE)
  write('cartridges/app_two/cartridge/templates/default/product/tile.isml', TILE)
  write('cartridges/app_one/cartridge/templates/default/home.isml', HOME)
  write('cartridges/app_one/cartridge/templates/resources/cart.properties', '\uFEFF' + PROPS)
  write('node_modules/lib/tile.isml', TILE)
  write('.git/tile.isml', TILE)
  write('cartridges/app_one/cartridge/static/default/notes.md', TILE)
  return root
}

async function mount(root: string, extra: { opens?: EditorOpens; opened?: OpenFileRequest[]; focused?: string | null } = {}) {
  const SHOP = { id: 'identity:wt2:shop', kind: 'worktree', name: 'Shop', path: root, branch: 'main', hostId: 'local' }
  const REMOTE = { id: 'identity:wt2:remote', kind: 'folder', name: 'Remote', path: '/srv/shop', branch: null, hostId: 'ssh:build-01' }
  const host: MockHost = mockHost({
    capabilities: CAPABILITIES,
    results: {
      'workspace.list': { workspaces: [SHOP, REMOTE], truncated: false },
      'workspace.readContext': extra.focused === null ? null : { workspaceId: extra.focused ?? SHOP.id, branch: 'main', displayName: 'Shop', terminals: [] }
    }
  })
  const opened = extra.opened ?? []
  const timers: (() => void)[] = []
  let disposable: { dispose(): void | Promise<void> } | void = undefined
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        const store = createStore(orca.storage, 'editor')
        const piece = createEditorPiece({
          locator: new Locator({ store, opens: extra.opens ?? new EditorOpens() }),
          openFile: async (request) => {
            opened.push(request)
            return { opened: true }
          },
          setTimer: (run) => {
            timers.push(run)
            return run
          },
          clearTimer: () => {}
        })
        const ctx: PieceContext = {
          orca,
          b2c: {} as B2c,
          settings: createSettings(orca.settings),
          store,
          workspaces: createWorkspaces(orca.host, createStore(orca.storage, 'core')),
          t: translator(() => 'en'),
          log: (message) => orca.log(message)
        }
        disposable = await piece.activate(ctx)
      },
      deactivate: () => disposable?.dispose()
    },
    { host, hooks: ['editor.save.before'], commands: [OPEN_COMMAND] }
  )
  const locate = (input: { text?: string; hash?: string; workspaceId?: string | null }) =>
    worker.request('editor.locate', { workspaceId: SHOP.id, ...input }) as Promise<EditorLocated>
  return { worker, host, locate, opened, timers, SHOP, REMOTE }
}

test('(c) the workspace’s files: a unique text names its file, a BOM and CRLF kept as they are', async () => {
  const root = workspace()
  try {
    const { worker, locate } = await mount(root)
    assert.deepEqual(await locate({ text: HOME }), { path: 'cartridges/app_one/cartridge/templates/default/home.isml' })
    assert.deepEqual(await locate({ hash: hashText('\uFEFF' + PROPS) }), { path: 'cartridges/app_one/cartridge/templates/resources/cart.properties' })
    assert.equal(await locate({ text: PROPS }), null, 'without its BOM it is another text')
    assert.equal(await locate({ text: HOME + 'unsaved' }), null, 'unsaved edits match nothing')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('(c) identical copies are ambiguous, folders never indexed left out; the choice is kept per workspace and text', async () => {
  const root = workspace()
  try {
    const { worker, locate, host } = await mount(root)
    const both = ['cartridges/app_one/cartridge/templates/default/product/tile.isml', 'cartridges/app_two/cartridge/templates/default/product/tile.isml']
    assert.deepEqual(await locate({ text: TILE }), { candidates: both, more: 0 })
    // A path that does not hold this text is refused.
    assert.deepEqual(await worker.request('editor.choose', { workspaceId: 'identity:wt2:shop', text: TILE, path: 'cartridges/app_one/cartridge/templates/default/home.isml' }), { ok: false })
    assert.deepEqual(await worker.request('editor.choose', { workspaceId: 'identity:wt2:shop', text: TILE, path: '../outside.isml' }), { ok: false })
    assert.deepEqual(await worker.request('editor.choose', { workspaceId: 'identity:wt2:shop', text: TILE, path: both[1] }), { ok: true })
    assert.deepEqual(await locate({ text: TILE }), { path: both[1] })
    assert.ok(JSON.stringify(host.data().storage).includes(hashText(TILE)), 'kept in the piece’s storage')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('(c) a file changed on disk is found by its new text: the index is refreshed by file time on a miss', async () => {
  const root = workspace()
  try {
    const { worker, locate } = await mount(root)
    assert.ok(await locate({ text: HOME }))
    const file = join(root, 'cartridges', 'app_one', 'cartridge', 'templates', 'default', 'home.isml')
    const changed = HOME.replace('home-main', 'home-hero')
    writeFileSync(file, changed)
    utimesSync(file, new Date(), new Date(Date.now() + 5_000))
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    assert.deepEqual(await locate({ text: changed }), { path: 'cartridges/app_one/cartridge/templates/default/home.isml' })
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('(a) a file the plugin just opened in its editor goes, with its line, to the first editor holding its text, and only to it', async () => {
  const root = workspace()
  try {
    const opens = new EditorOpens()
    const { worker, locate } = await mount(root, { opens })
    const both = ['cartridges/app_one/cartridge/templates/default/product/tile.isml', 'cartridges/app_two/cartridge/templates/default/product/tile.isml']
    const two = join(root, 'cartridges', 'app_two', 'cartridge', 'templates', 'default', 'product', 'tile.isml')
    // A frame with another text is not taken for it.
    opens.record({ root, file: two, line: 2, column: 5, at: Date.now() })
    assert.deepEqual(await locate({ text: HOME }), { path: 'cartridges/app_one/cartridge/templates/default/home.isml' })
    assert.deepEqual(await locate({ text: TILE }), { path: both[1], line: 2, column: 5 })
    // A second editor with the same text (the identical copy, opened by Orca) is never taken for it.
    assert.deepEqual(await locate({ text: TILE }), { candidates: both, more: 0 })
    // An open older than the window counts for nobody.
    opens.record({ root, file: two, at: Date.now() - OPEN_WINDOW_MS - 1 })
    assert.deepEqual(await locate({ text: TILE }), { candidates: both, more: 0 })
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a save is posted with its path and the hash of its text, as Orca’s tab names its workspace (<project>::<folder>); it names no file in locate; the hook never refuses', async () => {
  const root = workspace()
  try {
    const { worker, locate } = await mount(root)
    const both = ['cartridges/app_one/cartridge/templates/default/product/tile.isml', 'cartridges/app_two/cartridge/templates/default/product/tile.isml']
    const decision = await worker.hooks.fire('editor.save.before', { workspaceId: `repo-1::${root}`, path: both[0], languageId: 'plaintext', text: TILE })
    assert.equal(decision.kind, 'continue')
    for (let i = 0; i < 20 && worker.posts.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(worker.posts, [{ event: 'editor.saved', payload: { workspaceId: 'identity:wt2:shop', path: both[0], hash: hashText(TILE) } }])
    // The base copy was saved (in Orca's own editor, say): the override's editor still gets the picker.
    assert.deepEqual(await locate({ text: TILE }), { candidates: both, more: 0 })
    // A save outside the workspace is not posted.
    await worker.hooks.fire('editor.save.before', { workspaceId: null, path: join(tmpdir(), 'elsewhere.isml'), text: TILE })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(worker.posts.length, 1)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a workspace on another host, an unknown one or none: nothing is read', async () => {
  const root = workspace()
  try {
    const { worker, locate } = await mount(root)
    assert.equal(await locate({ text: HOME, workspaceId: 'identity:wt2:remote' }), null)
    assert.equal(await locate({ text: HOME, workspaceId: 'identity:wt2:gone' }), null)
    assert.equal(await locate({ text: HOME, workspaceId: null }), null)
    await assert.rejects(worker.request('editor.locate', { workspaceId: 'identity:wt2:shop' }), /Invalid input|invalid/i)
    await assert.rejects(worker.request('editor.locate', { workspaceId: 'identity:wt2:shop', hash: 'not-a-hash' }))
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the command opens the last saved file of the focused workspace in the plugin’s editor, or says what to do', async () => {
  const root = workspace()
  try {
    const opened: OpenFileRequest[] = []
    const { worker } = await mount(root, { opened })
    assert.equal(await worker.command(OPEN_COMMAND), 'Save the file once (Ctrl+S), then run this again.')
    await worker.hooks.fire('editor.save.before', { workspaceId: `repo-1::${root}`, path: 'cartridges/app_one/cartridge/templates/default/home.isml', text: HOME })
    // A file the editor does not take is never the one opened.
    await worker.hooks.fire('editor.save.before', { workspaceId: `repo-1::${root}`, path: 'README.md', text: '# readme' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(await worker.command(OPEN_COMMAND), 'Opened home.isml in the SFCC editor.')
    assert.deepEqual(opened, [{ root, path: 'cartridges/app_one/cartridge/templates/default/home.isml', inEditor: true, focus: true }])
    await worker.deactivate()
    const none = await mount(root, { focused: null })
    assert.equal(await none.worker.command(OPEN_COMMAND), 'No workspace on this machine is focused.')
    await none.worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('editor.open opens a file of the frame’s workspace in the plugin’s editor at a line; never another host’s, an unknown one or an absolute path', async () => {
  const root = workspace()
  try {
    const opened: OpenFileRequest[] = []
    const { worker, SHOP, REMOTE } = await mount(root, { opened })
    const open = (input: Record<string, unknown>) => worker.request('editor.open', input as never)
    const path = 'cartridges/app_two/cartridge/templates/default/product/tile.isml'
    assert.deepEqual(await open({ workspaceId: SHOP.id, path, line: 12, column: 3 }), { opened: true })
    assert.deepEqual(opened, [{ root, path, line: 12, column: 3, inEditor: true, focus: true }])
    // A line that is not one is left out; a column without a line too.
    assert.deepEqual(await open({ workspaceId: SHOP.id, path, line: 0, column: 3 }), { opened: true })
    assert.deepEqual(opened[1], { root, path, line: undefined, column: undefined, inEditor: true, focus: true })
    assert.deepEqual(await open({ workspaceId: REMOTE.id, path }), { opened: false, reason: 'no_workspace' })
    assert.deepEqual(await open({ workspaceId: 'identity:wt2:gone', path }), { opened: false, reason: 'no_workspace' })
    assert.deepEqual(await open({ workspaceId: null, path }), { opened: false, reason: 'no_workspace' })
    for (const absolute of ['C:/elsewhere/a.isml', '/etc/a.isml', '\\\\server\\share\\a.isml', '']) {
      assert.deepEqual(await open({ workspaceId: SHOP.id, path: absolute }), { opened: false, reason: 'invalid_path' }, absolute)
    }
    assert.equal(opened.length, 2)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the focused workspace is indexed in the background once the worker has started', async () => {
  const root = workspace()
  try {
    const { worker, timers } = await mount(root)
    assert.equal(timers.length, 1)
    timers[0]()
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hashOf takes a 64-digit hash as given, else hashes the text; a save names its workspace by folder or id', () => {
  assert.equal(hashOf({ text: 'x' }), hashText('x'))
  assert.equal(hashOf({ hash: 'a'.repeat(64) }), 'a'.repeat(64))
  assert.throws(() => hashOf({}))
  const list = [
    { id: 'w1', name: 'a', path: 'C:\\work\\shop', branch: 'main', kind: 'worktree' as const, hostId: 'local' },
    { id: 'w2', name: 'b', path: 'C:\\work\\shop\\nested', branch: 'x', kind: 'worktree' as const, hostId: 'local' },
    { id: 'w3', name: 'c', path: '/srv/shop', branch: null, kind: 'folder' as const, hostId: 'ssh:x' }
  ]
  assert.equal(workspaceOfSave(list, 'repo::c:/work/shop/', 'a.isml', 'win32')?.id, 'w1')
  assert.equal(workspaceOfSave(list, 'w2', 'a.isml', 'win32')?.id, 'w2')
  assert.equal(workspaceOfSave(list, null, 'C:\\work\\shop\\nested\\a.isml', 'win32')?.id, 'w2', 'the deepest folder holding it')
  assert.equal(workspaceOfSave(list, null, 'a.isml', 'win32'), null)
  assert.equal(workspaceOfSave(list, 'repo::/srv/shop', 'a.isml', 'linux'), null, 'never a workspace on another host')
  assert.ok(MAX_CANDIDATES >= 2)
})
