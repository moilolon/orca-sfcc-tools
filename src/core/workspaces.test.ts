// The workspace list over a stand-in host: what is kept of each workspace, and where dw.json is
// looked for.
import { assert, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { createStore } from './store'
import { createWorkspaces, isLocal } from './workspaces'

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

test('dw.json is looked for in the uploading workspace, else the focused one, and only on this machine', async () => {
  assert.equal(await workspacesOver([LOCAL, REMOTE], 'w1').configRoot(), '/work/shop')
  assert.equal(await workspacesOver([LOCAL, REMOTE], 'w2').configRoot(), null, 'the focused workspace is remote')
  assert.equal(await workspacesOver([LOCAL, REMOTE], 'w2', 'w1').configRoot(), '/work/shop', 'the uploading one wins')
  assert.equal(await workspacesOver([LOCAL, REMOTE], 'w1', 'w2').configRoot(), null, 'the uploading one is remote: never the focused one instead')
  assert.equal(await workspacesOver([LOCAL], null).configRoot(), null)
})
