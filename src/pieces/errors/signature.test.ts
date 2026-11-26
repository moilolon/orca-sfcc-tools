// The signature on invented entries: what varies between two occurrences of one error is removed,
// and two different errors stay apart, near misses included.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cartError, jobError, paymentError } from './fixtures/logs'
import { normalize, signatureOf, topFrames, TOP_FRAMES } from './signature'

const AT = '2026-11-26 10:15:02.123 GMT'

test('two occurrences that differ only in volatile parts share a signature', () => {
  const first = signatureOf(cartError({ at: AT }).message)
  // Another time, thread, site, session, product id, address, request id and other line numbers.
  const second = signatureOf(
    cartError({
      at: '2026-11-27 18:01:44.999 GMT',
      thread: '99',
      site: 'Sites-Other-Site',
      session: 'Pq7Wm2Zt9Xc4Vb1Nn8Lk3Hj',
      pid: '200871',
      email: 'john.roe@example.org',
      request: '9b2e7c1d-4a6f-4e3b-8c5d-1f0a2b3c4d5e',
      lines: [121, 66, 45]
    }).message
  )
  assert.equal(first.signature, second.signature)
  assert.match(first.signature, /^[0-9a-f]{20}$/)

  const payments = [
    paymentError(AT, '00012345', 'jane.doe@example.com', '59.90'),
    paymentError('2026-11-28 01:00:00.000 GMT', '99887766', 'sam.poe@example.net', '1200.00')
  ].map((entry) => signatureOf(entry.message).signature)
  assert.equal(payments[0], payments[1])

  assert.equal(signatureOf(jobError(AT, 'export_20261126_1015.xml').message).signature, signatureOf(jobError(AT, 'export_20261201_0700.xml').message).signature)
})

test('two different errors do not share a signature', () => {
  const signatures = [cartError({ at: AT }), jobError(AT), paymentError(AT, '1', 'jane.doe@example.com', '1')].map((entry) => signatureOf(entry.message).signature)
  assert.equal(new Set(signatures).size, 3)
})

test('near miss: the same message from another script is another error', () => {
  const cart = signatureOf(cartError({ at: AT }).message)
  const checkout = signatureOf(cartError({ at: AT, script: 'app_example/cartridge/scripts/helpers/checkoutHelper.js' }).message)
  assert.equal(cart.identity.message, checkout.identity.message, 'the first lines are the same')
  assert.notEqual(cart.signature, checkout.signature)
  // Only the function differs.
  const other = signatureOf(cartError({ at: AT, functions: ['calculateTax', 'addProductToCart', 'addProduct'] }).message)
  assert.notEqual(cart.signature, other.signature)
  // The location inside the text differs, the frames do not.
  const text = (script: string) => `Thread|1|Sites-A-Site|Cart-Show|PipelineCall|s system.core TypeError: x is undefined (${script}#10)`
  assert.notEqual(signatureOf(text('app_a/cartridge/scripts/a.js')).signature, signatureOf(text('app_a/cartridge/scripts/b.js')).signature)
})

test('near miss: the same script with another error class is another error', () => {
  const typeError = signatureOf(cartError({ at: AT }).message)
  const referenceError = signatureOf(cartError({ at: AT, errorClass: 'ReferenceError' }).message)
  assert.deepEqual(typeError.identity.frames, referenceError.identity.frames, 'the frames are the same')
  assert.notEqual(typeError.signature, referenceError.signature)
})

test('near miss: the same text under another logger is another error', () => {
  const line = (logger: string) => `Thread|1|Sites-A-Site|Cart-Show|PipelineCall|s ${logger} Cart total failed`
  assert.notEqual(signatureOf(line('custom.Cart')).signature, signatureOf(line('custom.Checkout')).signature)
})

test('the site, the pipeline fields and the session are not part of the signature', () => {
  const line = (fields: string) => `${fields} custom.Cart Cart total failed`
  assert.equal(
    signatureOf(line('PipelineCallServlet|1|Sites-Example-Site|Cart-Show|PipelineCall|abc')).signature,
    signatureOf(line('PipelineCallServlet|2|Sites-Other-Site|Cart-Show|PipelineCall|xyz')).signature
  )
})

test('normalize removes each volatile part, and keeps the words around it', () => {
  const cases: [string, string][] = [
    ['at 2026-11-26 10:15:02.123 GMT done', 'at <time> done'],
    ['at 2026-11-26T10:15:02Z done', 'at <time> done'],
    ['GET https://www.example.com/s/Home?q=shoes&page=2#top failed', 'GET https://www.example.com/s/Home failed'],
    ['GET /on/demandware.store/Cart-Show?pid=12&qty=1 failed', 'GET /on/demandware.store/Cart-Show failed'],
    ['request 3f6c2a9e-1b7d-4c5e-9a0f-2d8e6b4c1a37 failed', 'request <uuid> failed'],
    ['for jane.doe@example.com only', 'for <email> only'],
    ['property "price" and \'total\' missing', 'property <q> and <q> missing'],
    ["can't read 'x' here", "can't read <q> here"],
    ['in Sites-Example-Site today', 'in <site> today'],
    ['(app_x/cartridge/scripts/a.js#118) and a.js:12:7', '(app_x/cartridge/scripts/a.js) and a.js'],
    ['object 0x7f3a9c at 9f3a6c21e4 moved', 'object <hex> at <hex> moved'],
    ['session k3Jd8sLq0aZx2Vb7Nn4Mc1Pq expired', 'session <id> expired'],
    ['order 00012345 of 59.90 EUR', 'order # of #.# EUR'],
    ['  many   spaces\tand\nlines ', 'many spaces and lines']
  ]
  for (const [input, expected] of cases) assert.equal(normalize(input), expected, input)
  // Words that only look like ids stay whole.
  for (const kept of ['TypeError: Cannot read property of undefined', 'deadbeef failed', 'ISH-CORE-# Error executing script']) assert.equal(normalize(kept), kept)
  assert.equal(normalize('x'.repeat(1000)).length, 300)
})

test('topFrames prefers script frames, by file and function, and keeps at most three', () => {
  const frames = [
    { file: 'A.java', function: 'a.A.run', line: 1, script: false },
    { file: 'app/cartridge/scripts/a.js', function: 'one', line: 1, script: true },
    { file: 'app/cartridge/scripts/b.js', function: 'two', line: 2, script: true },
    { file: 'app/cartridge/scripts/c.js', function: 'three', line: 3, script: true },
    { file: 'app/cartridge/scripts/d.js', function: 'four', line: 4, script: true }
  ]
  assert.deepEqual(topFrames(frames).map((frame) => frame.function), ['one', 'two', 'three'])
  assert.equal(TOP_FRAMES, 3)
  assert.deepEqual(topFrames(frames.slice(0, 1)).map((frame) => frame.file), ['A.java'])
  assert.deepEqual(topFrames([]), [])
  // A fourth frame further down does not change the signature.
  const base = 'Thread|1|Sites-A-Site|Cart-Show|PipelineCall|s custom.Cart failed\n\tat a/cartridge/a.js:1 (a)\n\tat a/cartridge/b.js:1 (b)\n\tat a/cartridge/c.js:1 (c)'
  assert.equal(signatureOf(`${base}\n\tat a/cartridge/d.js:1 (d)`).signature, signatureOf(`${base}\n\tat a/cartridge/e.js:9 (e)`).signature)
})

test('signature.ts and seen.ts stay pure: no Orca import, and no Node import beyond hashing', () => {
  for (const file of ['signature.ts', 'seen.ts', 'reader.ts']) {
    const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')
    const imports = [...source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2])
    for (const spec of imports) assert.ok(spec === 'node:crypto' || spec === './reader', `${file} imports ${spec}`)
  }
})
