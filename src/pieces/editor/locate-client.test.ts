// The frame's side of locating its file: it sends the text's hash (never the text when it can
// hash), turns each answer into the identity 7.2 reads, drops an answer that came back for an
// older text, and keeps a choice among identical files.
import { assert, test } from 'orca/testing'
import { IdentityStore, type Identity } from './identity'
import { LocateClient, OWN_SAVE_MS, sha256Hex, type LocateRequests } from './locate-client'
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

/** Two editors of identical files, as the worker leaves them: both ambiguous, on one clock. */
function twoEditors() {
  let now = 1_000
  const timers: (() => void)[] = []
  const options = { now: () => now, setTimer: (run: () => void) => void timers.push(run) }
  const both = ['base_cartridge/cartridge/templates/default/product/tile.isml', 'app_custom/cartridge/templates/default/product/tile.isml']
  const ambiguous: EditorLocated = { candidates: both, more: 0 }
  const make = () => {
    const identity = new IdentityStore()
    const asked: unknown[] = []
    const api: LocateRequests = {
      locate: async (input) => {
        asked.push(input)
        return ambiguous
      },
      choose: async () => ({ ok: true })
    }
    return { identity, asked, client: new LocateClient(api, 'w', identity, options) }
  }
  /** Runs the gathering timers, once the hashes they wait for are computed (asynchronously). */
  const settle = async () => {
    for (let round = 0; round < 5; round++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (const run of timers.splice(0)) run()
    }
  }
  return { a: make(), b: make(), both, tick: (ms: number) => (now += ms), settle }
}

test('two identical files saved in turn: each save names only the editor that was flushed for it', async () => {
  const text = '<div class="tile">${product.name}</div>\n'
  const { a, b, both, tick, settle } = twoEditors()
  await a.client.locate(text)
  await b.client.locate(text)
  assert.equal(a.identity.value.state, 'ambiguous')
  // The base copy's editor saves: Orca flushes it, then the worker posts the save to every editor.
  a.client.flushed(text)
  const event = { workspaceId: 'w', path: both[0], hash: hashText(text) }
  const fromA = a.client.saved(event, () => text)
  const fromB = b.client.saved(event, () => text)
  await settle()
  assert.equal(await fromA, 'own')
  assert.equal(await fromB, 'other')
  assert.deepEqual(a.identity.value, { state: 'identified', workspaceId: 'w', path: both[0] })
  assert.equal(b.identity.value.state, 'ambiguous', 'the identical copy is never named by another tab’s save')
  // Then the override's editor saves, a moment later.
  tick(1_000)
  b.client.flushed(text)
  const second = { workspaceId: 'w', path: both[1], hash: hashText(text) }
  const again = [a.client.saved(second, () => text), b.client.saved(second, () => text)]
  await settle()
  assert.deepEqual(await Promise.all(again), ['other', 'own'])
  assert.deepEqual(a.identity.value, { state: 'identified', workspaceId: 'w', path: both[0] }, 'the first keeps its own file')
  assert.deepEqual(b.identity.value, { state: 'identified', workspaceId: 'w', path: both[1] })
})

test('a save is not taken as an editor’s own: too long after its flush, another text, or two files at once', async () => {
  const text = 'cart.title=Basket\n'
  const { a, both, tick, settle } = twoEditors()
  await a.client.locate(text)
  a.client.flushed(text)
  tick(OWN_SAVE_MS + 1)
  assert.equal(await a.client.saved({ workspaceId: 'w', path: both[0], hash: hashText(text) }, () => text), 'other')
  a.client.flushed('cart.title=Changed\n')
  assert.equal(await a.client.saved({ workspaceId: 'w', path: both[0], hash: hashText(text) }, () => text), 'other')
  // Save all: two tabs of identical files flushed together; the saves name two files, so neither.
  a.client.flushed(text)
  const first = a.client.saved({ workspaceId: 'w', path: both[0], hash: hashText(text) }, () => text)
  const pending = await a.client.saved({ workspaceId: 'w', path: both[1], hash: hashText(text) }, () => text)
  await settle()
  assert.equal(pending, 'pending')
  assert.equal(await first, 'other')
  assert.equal(a.identity.value.state, 'ambiguous')
  // Another workspace's save is not this editor's.
  a.client.flushed(text)
  assert.equal(await a.client.saved({ workspaceId: 'other', path: both[0], hash: hashText(text) }, () => text), 'other')
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
