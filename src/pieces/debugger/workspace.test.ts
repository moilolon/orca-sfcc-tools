// Which workspace the debugger works on (the one whose dw.json b2c reads, so credentials and
// cartridges come from one folder), and how it opens a file: at its line through
// src/core/open-file.ts, and through `editor.open` only when Orca's command line cannot run.
import type { OrcaWorkerApi } from 'orca/worker'
import { assert, test } from 'orca/testing'
import type { OpenFileFailure, OpenFileRequest, OpenFileResult } from '../../core/open-file'
import type { Workspace } from '../../core/piece'
import { createStore } from '../../core/store'
import { createWorkspaces } from '../../core/workspaces'
import { debugWorkspace, openFile } from './workspace'

const WORKSPACE: Workspace = { id: 'w1', name: 'shop', path: '/home/someone/work/shop', branch: 'main', kind: 'worktree', hostId: 'local' }
const PAGE = 'cartridges/app_example/cartridge/controllers/Page.js'

function fakes(answer: OpenFileResult, editorFails = false) {
  const requests: OpenFileRequest[] = []
  const editor: unknown[] = []
  const open = async (request: OpenFileRequest) => {
    requests.push(request)
    return answer
  }
  const host = {
    call: async (method: string, params: unknown) => {
      editor.push({ method, params })
      if (editorFails) throw new Error('refused')
      return { opened: true }
    }
  } as unknown as OrcaWorkerApi['host']
  return { open, host, requests, editor }
}

test('opens at the line and column, with the workspace’s folder as the root, bringing the person to it', async () => {
  const { open, host, requests, editor } = fakes({ opened: true })
  assert.equal(await openFile(open, host, WORKSPACE, { path: PAGE, line: 24, column: 7 }), true)
  assert.deepEqual(requests, [{ root: WORKSPACE.path, path: PAGE, line: 24, column: 7, focus: true, inEditor: true }])
  assert.deepEqual(editor, [])
  // No line, or a line of 0: no line and no column are passed.
  await openFile(open, host, WORKSPACE, { path: PAGE, line: null, column: 7 })
  await openFile(open, host, WORKSPACE, { path: PAGE, line: 0 })
  assert.deepEqual(requests.slice(1).map(({ line, column }) => [line, column]), [
    [undefined, undefined],
    [undefined, undefined]
  ])
})

test('falls back to editor.open only when Orca’s command line cannot run', async () => {
  const cannotRun: OpenFileFailure[] = ['orca_not_found', 'orca_shim_refused', 'orca_failed']
  for (const reason of cannotRun) {
    const { open, host, editor } = fakes({ opened: false, reason })
    assert.equal(await openFile(open, host, WORKSPACE, { path: PAGE, line: 3 }), true, reason)
    assert.deepEqual(editor, [{ method: 'editor.open', params: { workspaceId: 'w1', path: PAGE } }], reason)
  }
  // A file that is not there or leaves the workspace opens neither way; after a timeout the first
  // call may still land, so nothing opens it a second time.
  const noFallback: OpenFileFailure[] = ['not_found', 'outside_workspace', 'orca_timeout']
  for (const reason of noFallback) {
    const { open, host, editor } = fakes({ opened: false, reason })
    assert.equal(await openFile(open, host, WORKSPACE, { path: PAGE, line: 3 }), false, reason)
    assert.deepEqual(editor, [], reason)
  }
  // The fallback refused too: not opened, and nothing thrown.
  const { open, host } = fakes({ opened: false, reason: 'orca_not_found' }, true)
  assert.equal(await openFile(open, host, WORKSPACE, { path: PAGE, line: 3 }), false)
})

test('kept workspace A with a dw.json, focus on B without one: A is debugged, its folder giving both the dw.json and the cartridges', async () => {
  const shop = { id: 'w-shop', kind: 'worktree', name: 'shop', path: '/home/someone/work/shop', branch: 'main', hostId: 'local' }
  const notes = { id: 'w-notes', kind: 'folder', name: 'notes', path: '/home/someone/notes', branch: null, hostId: 'local' }
  let focused = 'w-shop'
  const host = {
    call: async (method: string) => {
      if (method === 'workspace.list') return { workspaces: [shop, notes], truncated: false }
      if (method === 'workspace.readContext') return { workspaceId: focused, branch: '', displayName: '', terminals: [] }
      throw new Error(`unexpected host call: ${method}`)
    }
  } as unknown as OrcaWorkerApi['host']
  const data = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => (data.get(key) ?? null) as string | null,
    set: async (key: string, value: unknown) => void data.set(key, value),
    delete: async (key: string) => void data.delete(key),
    keys: async () => [...data.keys()]
  }
  // Only the shop's folder has a configuration file.
  const workspaces = createWorkspaces(host, createStore(storage, 'core'), { hasConfig: async (root) => root === shop.path })
  // Focused once, A is kept; then the focus moves to B, which has no dw.json.
  assert.equal((await debugWorkspace(workspaces))?.id, 'w-shop')
  focused = 'w-notes'
  const debugged = await debugWorkspace(workspaces)
  // The session runs in the debugged workspace's folder and reads its cartridges there, and b2c
  // reads the dw.json of the folder `configRoot()` names: both are A's.
  assert.equal(debugged?.id, 'w-shop')
  assert.equal(debugged?.path, shop.path)
  assert.equal(await workspaces.configRoot(), shop.path)
  assert.equal(await workspaces.configRoot(), debugged?.path, 'credentials and cartridges from one folder')
})

test('a stand-in with no active() keeps the old rule: the uploading workspace, else the focused one', async () => {
  const other: Workspace = { ...WORKSPACE, id: 'w2', path: '/home/someone/work/fix' }
  const stand = { list: async () => [], focused: async () => WORKSPACE, uploading: async () => null, upload: async () => null, setUploading: async () => {}, configRoot: async () => null }
  assert.equal((await debugWorkspace(stand))?.id, 'w1')
  assert.equal((await debugWorkspace({ ...stand, uploading: async () => other }))?.id, 'w2')
  assert.equal(await debugWorkspace({ ...stand, focused: async () => null }), null)
})
