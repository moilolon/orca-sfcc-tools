// How the debugger opens a file: at its line through src/core/open-file.ts, and through
// `editor.open` only when Orca's command line cannot run.
import type { OrcaWorkerApi } from 'orca/worker'
import { assert, test } from 'orca/testing'
import type { OpenFileFailure, OpenFileRequest, OpenFileResult } from '../../core/open-file'
import type { Workspace } from '../../core/piece'
import { openFile } from './workspace'

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
