// The workspace list over a stand-in host: what is kept of each workspace, and where dw.json is
// looked for.
import { assert, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { createStore } from './store'
import { createWorkspaces, hiddenProjects, isLocal, listWorkspaces } from './workspaces'

type Listed = { id: string; kind: 'worktree' | 'folder'; name: string; path: string; branch: string | null; hostId: string | null }

function workspacesOver(listed: Listed[], focusedId: string | null, uploadingId: string | null = null) {
  const data = new Map<string, unknown>(uploadingId ? [['core.uploading', uploadingId]] : [])
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
  return createWorkspaces(host, store)
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

test('dw.json is looked for in the uploading workspace, else the focused one, and only on this machine', async () => {
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
