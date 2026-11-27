// The frame's side of locating its file: it sends the text's hash (never the text when it can
// hash), turns each answer into the identity 7.2 reads, drops an answer that came back for an
// older text, and keeps a choice among identical files.
import { assert, test } from 'orca/testing'
import { IdentityStore, type Identity } from './identity'
import { LocateClient, sha256Hex, type LocateRequests } from './locate-client'
import { hashText } from './locate'
import type { EditorLocated } from './protocol'

function requests(answers: EditorLocated[], chooseOk = true) {
  const sent: unknown[] = []
  const api: LocateRequests = {
    locate: async (input) => {
      sent.push(input)
      return answers.shift() ?? null
    },
    choose: async (input) => {
      sent.push(input)
      return { ok: chooseOk }
    }
  }
  return { api, sent }
}

test('the hash the frame computes is the one the worker computes', async () => {
  for (const text of ['', 'ñandú ${x}', '﻿<isif>\r\n</isif>', '日本 😀']) assert.equal(await sha256Hex(text), hashText(text))
})

test('each answer becomes an identity; the line comes with a path; no workspace is unknown', async () => {
  const { api, sent } = requests([{ path: 'a/b.isml', line: 7, column: 2 }, { candidates: ['x/t.isml', 'y/t.isml'], more: 0 }, null])
  const identity = new IdentityStore()
  const seen: Identity[] = []
  identity.subscribe((value) => seen.push(value))
  const client = new LocateClient(api, 'identity:wt2:shop', identity)
  assert.deepEqual(await client.locate('<div/>'), { identity: { state: 'identified', workspaceId: 'identity:wt2:shop', path: 'a/b.isml' }, line: 7, column: 2 })
  assert.equal(identity.crossFile, true)
  assert.equal((await client.locate('<div/>')).identity.state, 'ambiguous')
  assert.equal(identity.crossFile, false)
  assert.equal((await client.locate('<div/>')).identity.state, 'unknown')
  assert.deepEqual(sent[0], { workspaceId: 'identity:wt2:shop', hash: hashText('<div/>') }, 'the hash, not the text')
  assert.equal(seen.length, 3)
  const none = new LocateClient(api, null, identity)
  assert.deepEqual((await none.locate('x')).identity, { state: 'unknown' })
})

test('an answer for an older text is dropped; a failing request is unknown', async () => {
  let release: (value: EditorLocated) => void = () => {}
  const slow: LocateRequests = {
    locate: () => new Promise<EditorLocated>((resolve) => (release = resolve)),
    choose: async () => ({ ok: true })
  }
  const identity = new IdentityStore()
  const client = new LocateClient(slow, 'w', identity)
  const first = client.locate('old')
  // The text changed and was asked again before the first answer.
  const fast: LocateRequests = { locate: async () => ({ path: 'new.isml' }), choose: async () => ({ ok: true }) }
  Object.assign(slow, fast)
  await client.locate('new')
  release({ path: 'old.isml' })
  await first
  assert.deepEqual(identity.value, { state: 'identified', workspaceId: 'w', path: 'new.isml' })
  const failing = new LocateClient({ locate: async () => Promise.reject(new Error('timeout')), choose: async () => ({ ok: false }) }, 'w', identity)
  assert.deepEqual((await failing.locate('x')).identity, { state: 'unknown' })
})

test('a choice among identical files names the file when the worker kept it', async () => {
  const { api, sent } = requests([])
  const identity = new IdentityStore()
  const client = new LocateClient(api, 'w', identity)
  assert.equal(await client.choose('<div/>', 'y/t.isml'), true)
  assert.deepEqual(identity.value, { state: 'identified', workspaceId: 'w', path: 'y/t.isml' })
  assert.deepEqual(sent, [{ workspaceId: 'w', path: 'y/t.isml', hash: hashText('<div/>') }])
  const refused = new LocateClient(requests([], false).api, 'w', new IdentityStore())
  assert.equal(await refused.choose('<div/>', 'y/t.isml'), false)
})
