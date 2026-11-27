// The workspace list over a stand-in host: what is kept of each workspace, and where dw.json is
// looked for.
import { assert, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { createStore } from './store'
import { activeWorkspace, createWorkspaces, hiddenProjects, isLocal, KEPT_KEY, listWorkspaces, type WorkspacesOptions } from './workspaces'

type Listed = { id: string; kind: 'worktree' | 'folder'; name: string; path: string; branch: string | null; hostId: string | null }

function workspacesOver(listed: Listed[], focusedId: string | null, uploadingId: string | null = null, options: WorkspacesOptions = {}, data = new Map<string, unknown>()) {
  if (uploadingId) data.set('core.uploading', uploadingId)
  const host = {
    call: async (method: string) => {
      if (method === 'workspace.list') return { workspaces: listed, truncated: false }
      if (method === 'workspace.readContext') return focusedId ? { workspaceId: focusedId, branch: '', displayName: '', terminals: [] } : null
      throw new Error(`unexpected host call: ${method}`)
    }
  } as unknown as OrcaWorkerApi['host']
  const store = createStore(
    {
      get: async (key) => (data.get(key) ?? null) as string | null,
      set: async (key, value) => void data.set(key, value),
      delete: async (key) => void data.delete(key),
      keys: async () => [...data.keys()]
    },
    'core'
  )
  return createWorkspaces(host, store, options)
}

const LOCAL: Listed = { id: 'w1', kind: 'worktree', name: 'shop', path: '/work/shop', branch: 'main', hostId: 'local' }
const REMOTE: Listed = { id: 'w2', kind: 'folder', name: 'shop on a server', path: '/srv/shop', branch: null, hostId: 'ssh:build-01' }

test('keeps the host of each workspace, so a remote path is never taken for a local one', async () => {
  const workspaces = workspacesOver([LOCAL, REMOTE, { ...LOCAL, id: 'w3', hostId: null }], 'w2')
  assert.deepEqual(await workspaces.list(), [LOCAL, REMOTE, { ...LOCAL, id: 'w3', hostId: null }])
  assert.deepEqual(await workspaces.focused(), REMOTE)
  assert.ok(isLocal(LOCAL))
  assert.ok(isLocal({ hostId: null }))
  assert.ok(!isLocal(REMOTE))
  assert.ok(!isLocal({ hostId: 'runtime:remote' }))
})

test('the uploading workspace comes with its code version, and both clear together', async () => {
  const workspaces = workspacesOver([LOCAL, REMOTE], 'w2')
  assert.equal(await workspaces.upload(), null)
  await workspaces.setUploading('w1', 'ws-shop')
  assert.deepEqual(await workspaces.upload(), { workspace: LOCAL, codeVersion: 'ws-shop' })
  assert.deepEqual(await workspaces.uploading(), LOCAL)
  await workspaces.setUploading('w1')
  assert.equal(await workspaces.upload(), null, 'no version named: none is reported')
  assert.deepEqual(await workspaces.uploading(), LOCAL)
  await workspaces.setUploading('w1', 'ws-shop')
  await workspaces.setUploading(null, 'ws-shop')
  assert.equal(await workspaces.upload(), null)
  assert.equal(await workspaces.uploading(), null)
  await workspaces.setUploading('gone', 'ws-gone')
  assert.equal(await workspaces.upload(), null, 'a workspace no longer listed uploads nothing')
})

test('dw.json is looked for in the uploading workspace, else the focused one when every folder has a file, and only on this machine', async () => {
  assert.equal(await workspacesOver([LOCAL, REMOTE], 'w1').configRoot(), '/work/shop')
  assert.equal(await workspacesOver([LOCAL, REMOTE], 'w2').configRoot(), null, 'the focused workspace is remote')
  assert.equal(await workspacesOver([LOCAL, REMOTE], 'w2', 'w1').configRoot(), '/work/shop', 'the uploading one wins')
  assert.equal(await workspacesOver([LOCAL, REMOTE], 'w1', 'w2').configRoot(), null, 'the uploading one is remote: never the focused one instead')
  assert.equal(await workspacesOver([LOCAL], null).configRoot(), null)
})

test('the list says whether it is whole, and each workspace’s project; a truncated one is never complete', async () => {
  const answering = (truncated: boolean | undefined) =>
    ({ call: async () => ({ workspaces: [{ ...LOCAL, projectId: 'p1' }], ...(truncated === undefined ? {} : { truncated }) }) }) as unknown as OrcaWorkerApi['host']
  assert.deepEqual(await listWorkspaces(answering(false)), { workspaces: [{ ...LOCAL, projectId: 'p1' }], complete: true })
  assert.deepEqual(await listWorkspaces(answering(true)), { workspaces: [{ ...LOCAL, projectId: 'p1' }], complete: false })
  assert.equal((await listWorkspaces(answering(undefined))).complete, true)
})

test('the list passes its signal on, so a caller can bound it', async () => {
  let seen: unknown
  const host = { call: async (_method: string, _params: unknown, options: unknown) => ((seen = options), { workspaces: [], truncated: false }) } as unknown as OrcaWorkerApi['host']
  const signal = AbortSignal.timeout(1000)
  await listWorkspaces(host, { signal })
  assert.deepEqual(seen, { signal })
})

test('hidden projects: their ids, or null when Orca cannot say', async () => {
  const projects = (answer: unknown, has = true) =>
    ({
      has: () => has,
      call: async () => {
        if (answer instanceof Error) throw answer
        return answer
      }
    }) as unknown as OrcaWorkerApi['host']
  const listed = { projects: [{ id: 'p1', hidden: true }, { id: 'p2' }, { id: 'p3', hidden: false }], truncated: false }
  assert.deepEqual(await hiddenProjects(projects(listed)), ['p1'])
  assert.equal(await hiddenProjects(projects({ ...listed, truncated: true })), null)
  assert.equal(await hiddenProjects(projects(new Error('down'))), null)
  assert.equal(await hiddenProjects(projects(listed, false)), null)
})

/**
 * A machine whose focus moves: `focus` moves it, `state.listed` is what Orca lists, `restart`
 * builds the workspaces again over the same storage (a worker restart). Only the folders in
 * `withFile` have a configuration file; `asked` is every folder asked about.
 */
function moving(listed: Listed[], withFile: string[] | Set<string>) {
  const files = withFile instanceof Set ? withFile : new Set(withFile)
  const state = { listed, focused: null as string | null, truncated: false }
  const data = new Map<string, unknown>()
  const asked: string[] = []
  const host = {
    call: async (method: string) => {
      if (method === 'workspace.list') return { workspaces: state.listed, truncated: state.truncated }
      if (method === 'workspace.readContext') return state.focused ? { workspaceId: state.focused, branch: '', displayName: '', terminals: [] } : null
      throw new Error(`unexpected host call: ${method}`)
    }
  } as unknown as OrcaWorkerApi['host']
  const storage = {
    get: async (key: string) => (data.get(key) ?? null) as string | null,
    set: async (key: string, value: unknown) => void data.set(key, value),
    delete: async (key: string) => void data.delete(key),
    keys: async () => [...data.keys()]
  }
  const hasConfig = async (root: string) => (asked.push(root), files.has(root))
  const build = () => createWorkspaces(host, createStore(storage, 'core'), { hasConfig })
  let workspaces = build()
  return {
    state,
    data,
    asked,
    get workspaces() {
      return workspaces
    },
    focus(id: string | null) {
      state.focused = id
    },
    /** The focus moves and Orca says so (`workspace.changed`), with nothing asking `active()`. */
    async move(id: string | null) {
      state.focused = id
      await workspaces.focusMoved(id)
    },
    restart() {
      workspaces = build()
    },
    /** Where dw.json is looked for, and which workspace the plugin is on and why. */
    async where() {
      const active = await activeWorkspace(workspaces)
      return { root: await workspaces.configRoot(), id: active?.workspace.id ?? null, reason: active?.reason ?? null }
    }
  }
}

const SHOP: Listed = { id: 'w-shop', kind: 'worktree', name: 'shop', path: '/work/shop', branch: 'main', hostId: 'local' }
const FIX: Listed = { id: 'w-fix', kind: 'worktree', name: 'shop fix', path: '/work/shop-fix', branch: 'fix', hostId: 'local' }
const NOTES: Listed = { id: 'w-notes', kind: 'folder', name: 'notes', path: '/home/notes', branch: null, hostId: 'local' }
const SERVER: Listed = { id: 'w-server', kind: 'folder', name: 'on a server', path: '/srv/shop', branch: null, hostId: 'ssh:build-01' }
const KEPT = `core.${KEPT_KEY}`

test('focus moves: a workspace with a file is used and kept; one without keeps the last that had one', async () => {
  const machine = moving([SHOP, FIX, NOTES, SERVER], ['/work/shop', '/work/shop-fix'])
  assert.deepEqual(await machine.where(), { root: null, id: null, reason: null }, 'nothing focused, nothing kept')
  machine.focus('w-notes')
  assert.deepEqual(await machine.where(), { root: '/home/notes', id: 'w-notes', reason: 'focused' }, 'nothing kept yet: the focused one, with no file')
  machine.focus('w-shop')
  assert.deepEqual(await machine.where(), { root: '/work/shop', id: 'w-shop', reason: 'focused' })
  assert.equal(machine.data.get(KEPT), 'w-shop', 'kept by id in core’s storage')
  machine.focus('w-notes')
  assert.deepEqual(await machine.where(), { root: '/work/shop', id: 'w-shop', reason: 'kept' }, 'a workspace with no file keeps the last SFCC one')
  machine.focus(null)
  assert.deepEqual(await machine.where(), { root: '/work/shop', id: 'w-shop', reason: 'kept' }, 'no focus at all keeps it too')
  machine.focus('w-fix')
  assert.deepEqual(await machine.where(), { root: '/work/shop-fix', id: 'w-fix', reason: 'focused' }, 'another workspace with a file replaces it')
  machine.focus('w-notes')
  assert.deepEqual(await machine.where(), { root: '/work/shop-fix', id: 'w-fix', reason: 'kept' })
})

test('a remote workspace is never asked for a file nor kept: the last local one stays', async () => {
  const machine = moving([SHOP, SERVER], ['/work/shop', '/srv/shop'])
  machine.focus('w-server')
  assert.deepEqual(await machine.where(), { root: null, id: 'w-server', reason: 'focused' }, 'nothing kept: the remote one, whose folder is never read')
  machine.focus('w-shop')
  await machine.where()
  machine.focus('w-server')
  assert.deepEqual(await machine.where(), { root: '/work/shop', id: 'w-shop', reason: 'kept' })
  assert.ok(!machine.asked.includes('/srv/shop'), 'a remote path is never looked at as a local folder')
  // The kept workspace now lives on another host: it is let go, never read as a local folder.
  machine.state.listed = [{ ...SHOP, hostId: 'ssh:build-01' }, SERVER]
  assert.deepEqual(await machine.where(), { root: null, id: 'w-server', reason: 'focused' })
  assert.equal(machine.data.has(KEPT), false)
})

test('a kept workspace removed is let go, but never on a list Orca cut short', async () => {
  const machine = moving([SHOP, NOTES], ['/work/shop'])
  machine.focus('w-shop')
  await machine.where()
  machine.focus('w-notes')
  machine.state.listed = [NOTES]
  machine.state.truncated = true
  assert.deepEqual(await machine.where(), { root: '/home/notes', id: 'w-notes', reason: 'focused' }, 'missing from a cut list: not used')
  assert.equal(machine.data.get(KEPT), 'w-shop', 'nor forgotten')
  machine.state.listed = [SHOP, NOTES]
  machine.state.truncated = false
  assert.deepEqual(await machine.where(), { root: '/work/shop', id: 'w-shop', reason: 'kept' })
  machine.state.listed = [NOTES]
  assert.deepEqual(await machine.where(), { root: '/home/notes', id: 'w-notes', reason: 'focused' })
  assert.equal(machine.data.has(KEPT), false, 'removed: let go')
  machine.state.listed = [SHOP, NOTES]
  assert.deepEqual(await machine.where(), { root: '/home/notes', id: 'w-notes', reason: 'focused' }, 'and not taken back on its own')
})

test('a worker restart keeps the workspace kept', async () => {
  const machine = moving([SHOP, NOTES], ['/work/shop'])
  machine.focus('w-shop')
  await machine.where()
  machine.focus('w-notes')
  machine.restart()
  assert.deepEqual(await machine.where(), { root: '/work/shop', id: 'w-shop', reason: 'kept' })
})

test('the uploading workspace comes first; once released, it is the one kept', async () => {
  const machine = moving([SHOP, FIX, NOTES], ['/work/shop', '/work/shop-fix'])
  machine.focus('w-shop')
  await machine.where()
  await machine.workspaces.setUploading('w-fix', 'ws-fix')
  machine.focus('w-notes')
  assert.deepEqual(await machine.where(), { root: '/work/shop-fix', id: 'w-fix', reason: 'uploading' })
  machine.focus('w-shop')
  assert.deepEqual(await machine.where(), { root: '/work/shop-fix', id: 'w-fix', reason: 'uploading' }, 'never the focused one while one uploads')
  machine.focus('w-notes')
  await machine.workspaces.setUploading(null)
  assert.deepEqual(await machine.where(), { root: '/work/shop-fix', id: 'w-fix', reason: 'kept' }, 'the released one stays while the focus has no file')
  machine.focus('w-shop')
  assert.deepEqual(await machine.where(), { root: '/work/shop', id: 'w-shop', reason: 'focused' })
})

test('a folder that cannot say whether it has a file counts as having none', async () => {
  const data = new Map<string, unknown>([[KEPT, 'w-shop']])
  const failing = workspacesOver([SHOP, NOTES], 'w-notes', null, { hasConfig: async () => Promise.reject(new Error('gone')) }, data)
  assert.equal(await failing.configRoot(), '/home/notes', 'the kept one cannot say either: let go, the focused one instead')
  assert.equal((await failing.active?.())?.reason, 'focused')
  assert.equal(data.has(KEPT), false)
})

test('with nothing uploading, focused or kept, Orca is not asked for the list', async () => {
  const methods: string[] = []
  const host = {
    call: async (method: string) => {
      methods.push(method)
      if (method === 'workspace.readContext') return null
      throw new Error(`not answered here: ${method}`)
    }
  } as unknown as OrcaWorkerApi['host']
  const data = new Map<string, unknown>()
  const storage = { get: async (key: string) => (data.get(key) ?? null) as string | null, set: async () => {}, delete: async () => {}, keys: async () => [] }
  const workspaces = createWorkspaces(host, createStore(storage, 'core'), { hasConfig: async () => true })
  assert.equal(await workspaces.configRoot(), null)
  assert.equal(await workspaces.active?.(), null)
  assert.deepEqual([...new Set(methods)], ['workspace.readContext'])
})

test('activeWorkspace: a stand-in without active() is read by the rule it replaced', async () => {
  const stand = { list: async () => [], focused: async () => SHOP, uploading: async () => null, upload: async () => null, setUploading: async () => {}, configRoot: async () => null }
  assert.deepEqual(await activeWorkspace(stand), { workspace: SHOP, reason: 'focused' })
  assert.deepEqual(await activeWorkspace({ ...stand, uploading: async () => FIX }), { workspace: FIX, reason: 'uploading' })
  assert.equal(await activeWorkspace({ ...stand, focused: async () => null }), null)
})

test('the focus moving is enough: A (with a file), then B (with one), then notes keeps B, with nothing asked between', async () => {
  const machine = moving([SHOP, FIX, NOTES], ['/work/shop', '/work/shop-fix'])
  machine.focus('w-shop')
  assert.deepEqual(await machine.where(), { root: '/work/shop', id: 'w-shop', reason: 'focused' })
  await machine.move('w-fix')
  await machine.move('w-notes')
  assert.deepEqual(await machine.where(), { root: '/work/shop-fix', id: 'w-fix', reason: 'kept' })
  // A workspace with no file, a remote one, one Orca does not list, or none: nothing changes.
  for (const id of ['w-notes', 'w-gone', null]) await machine.move(id)
  assert.equal(machine.data.get(KEPT), 'w-fix')
})

test('focus changes are taken in order: a slow check never keeps an older workspace over a newer one', async () => {
  const machine = moving([SHOP, FIX, NOTES], ['/work/shop', '/work/shop-fix'])
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const slow = createWorkspaces(
    { call: async (method: string) => (method === 'workspace.list' ? { workspaces: [SHOP, FIX, NOTES], truncated: false } : null) } as unknown as OrcaWorkerApi['host'],
    createStore({ get: async (key) => (machine.data.get(key) ?? null) as string | null, set: async (key, value) => void machine.data.set(key, value), delete: async (key) => void machine.data.delete(key), keys: async () => [] }, 'core'),
    { hasConfig: async (root) => (root === '/work/shop' ? (await held, true) : root === '/work/shop-fix') }
  )
  const first = slow.focusMoved('w-shop')
  const second = slow.focusMoved('w-fix')
  release()
  await Promise.all([first, second])
  assert.equal(machine.data.get(KEPT), 'w-fix')
})

test('a kept workspace whose file is gone is let go: the focused one, labelled as such, instead', async () => {
  const files = new Set(['/work/shop'])
  const machine = moving([SHOP, NOTES], files)
  machine.focus('w-shop')
  await machine.where()
  machine.focus('w-notes')
  assert.deepEqual(await machine.where(), { root: '/work/shop', id: 'w-shop', reason: 'kept' })
  files.delete('/work/shop')
  assert.deepEqual(await machine.where(), { root: '/home/notes', id: 'w-notes', reason: 'focused' })
  assert.equal(machine.data.has(KEPT), false, 'let go')
  files.add('/work/shop')
  assert.deepEqual(await machine.where(), { root: '/home/notes', id: 'w-notes', reason: 'focused' }, 'not taken back until focused again')
})
