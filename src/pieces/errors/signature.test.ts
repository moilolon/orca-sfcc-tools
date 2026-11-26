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

test('one error on two storefront hosts and two locales is one signature, and no host is kept', () => {
  const english = signatureOf(cartError({ at: AT, host: 'www.example.com', locale: 'en_GB' }).message)
  const french = signatureOf(cartError({ at: AT, host: 'www.example.fr', locale: 'fr_FR', site: 'Sites-Other-Site' }).message)
  assert.equal(english.signature, french.signature)
  for (const identity of [english.identity, french.identity]) {
    assert.ok(!/example\.(?:com|fr)|https?:|en_GB|fr_FR/.test(identity.message), identity.message)
    assert.match(identity.message, /\/on\/demandware\.store\/<site>\/<locale>\/Cart-AddProduct for <email>/)
  }
})

test('the reviewer’s collisions: each pair is two errors', () => {
  const noTrace = (pipeline: string, logger: string, text: string) => `PipelineCallServlet|1|Sites-A-Site|${pipeline}|PipelineCall|s ${logger} ${text}`
  const pairs: [string, string][] = [
    [noTrace('Cart-Show', 'custom.Service', 'call failed with status 404'), noTrace('Cart-Show', 'custom.Service', 'call failed with status 500')],
    [noTrace('Cart-Show', 'system.core', 'ISH-CORE-2368 Error executing script'), noTrace('Cart-Show', 'system.core', 'ISH-CORE-2482 Error executing script')],
    [noTrace('Cart-Show', 'custom.Basket', 'Basket could not be calculated'), noTrace('Account-Show', 'custom.Basket', 'Basket could not be calculated')],
    [
      noTrace('Cart-Show', 'system.core', "Error executing script 'app_x/cartridge/controllers/Cart.js': TypeError: x is undefined"),
      noTrace('Cart-Show', 'system.core', "Error executing script 'app_x/cartridge/controllers/Search.js': TypeError: x is undefined")
    ],
    [noTrace('Cart-Show', 'custom.Payment', 'Unknown payment processor PAYMENT_PROC_ADYEN_V2'), noTrace('Cart-Show', 'custom.Payment', 'Unknown payment processor PAYMENT_PROC_PAYPAL_V3')],
    // And more of the same kind.
    [noTrace('Cart-Show', 'custom.Service', 'HTTP/1.1 502 from upstream'), noTrace('Cart-Show', 'custom.Service', 'HTTP/1.1 504 from upstream')],
    [noTrace('Cart-Show', 'custom.Service', 'Response 401 Unauthorized'), noTrace('Cart-Show', 'custom.Service', 'Response 403 Forbidden')],
    [noTrace('Cart-Show', 'custom.Service', 'rejected with statusCode=429'), noTrace('Cart-Show', 'custom.Service', 'rejected with statusCode=400')],
    [noTrace('Cart-Show', 'custom.Db', 'ORA-00001 unique constraint'), noTrace('Cart-Show', 'custom.Db', 'ORA-01400 unique constraint')],
    [noTrace('Cart-Show', 'custom.Tax', 'tax failed with error code 17'), noTrace('Cart-Show', 'custom.Tax', 'tax failed with error code 18')]
  ]
  for (const [a, b] of pairs) assert.notEqual(signatureOf(a).signature, signatureOf(b).signature, `${a} / ${b}`)
})

test('what the collision rules keep apart is still one error when only its values vary', () => {
  const line = (pipeline: string, text: string) => `PipelineCallServlet|9|Sites-B-Site|${pipeline}|PipelineCall|t custom.Order ${text}`
  const pairs: [string, string][] = [
    [line('COPlaceOrder-Submit', 'Order orderNo=00012345 failed for customerNo: 77'), line('COPlaceOrder-Submit', 'Order orderNo=99 failed for customerNo: 12345')],
    [line('COPlaceOrder-Submit', 'status 500 after 3 retries'), line('COPlaceOrder-Submit', 'status 500 after 7 retries')],
    [line('COPlaceOrder-Submit', 'basket bcK8oiaagMVZ expired'), line('COPlaceOrder-Submit', 'basket Qw7ErtyuIop1 expired')],
    [line('COPlaceOrder-Submit', 'created at Tue Nov 26 10:15:02 GMT 2026'), line('COPlaceOrder-Submit', 'created at Wed Nov 27 08:00:59 GMT 2026')]
  ]
  for (const [a, b] of pairs) assert.equal(signatureOf(a).signature, signatureOf(b).signature, `${a} / ${b}`)
  // With frames, the pipeline is not part of it: the frames say where.
  const traced = (pipeline: string) => `${line(pipeline, 'failed')}\n\tat app_x/cartridge/scripts/a.js:1 (run)`
  assert.equal(signatureOf(traced('Cart-Show')).signature, signatureOf(traced('Account-Show')).signature)
  assert.equal(signatureOf(traced('Cart-Show')).identity.pipeline, null)
  assert.equal(signatureOf(line('Cart-Show', 'failed')).identity.pipeline, 'Cart-Show')
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
    ['GET https://www.example.com/s/Home?q=shoes&page=2#top failed', 'GET /s/Home failed'],
    ['call to https://api.example.com failed', 'call to / failed'],
    ['GET https://shop.example.co.uk/on/demandware.store/Sites-A-Site/en_GB/Cart-Show?pid=1 failed', 'GET /on/demandware.store/<site>/<locale>/Cart-Show failed'],
    ['GET https://www.example.fr/s/Shop/fr/cart failed', 'GET /s/Shop/<locale>/cart failed'],
    ['GET http://www.example.com/s/Shop/default/cart failed', 'GET /s/Shop/<locale>/cart failed'],
    ['GET https://www.example.com/s/Shop/home-en-gb.html failed', 'GET /s/Shop/home-<locale>.html failed'],
    ['GET /on/demandware.store/Sites-A-Site/de_DE/Cart-Show failed', 'GET /on/demandware.store/<site>/<locale>/Cart-Show failed'],
    ['from 192.0.2.17 refused', 'from <ip> refused'],
    ['at Tue Nov 26 10:15:02 GMT 2026 done', 'at <time> done'],
    ['order orderNo=00012345 and customerNo: 77 for basketId="abc12" UUID 1f2e3d4c', 'order orderNo=# and customerNo:# for basketId=# UUID #'],
    ['valid: true', 'valid: true'],
    ['basket bcK8oiaagMVZ not found', 'basket <id> not found'],
    ['processor PAYMENT_PROC_ADYEN_V2 unknown', 'processor PAYMENT_PROC_ADYEN_V# unknown'],
    ['call failed with status 404', 'call failed with status 404'],
    ['HTTP/1.1 503 from upstream', 'HTTP/1.1 503 from upstream'],
    ['statusCode=429 after 3 tries', 'statusCode=429 after # tries'],
    ['failed with error code 17', 'failed with error code 17'],
    ['Response 502 Bad Gateway after 1200 ms', 'Response 502 Bad Gateway after # ms'],
    ['ISH-CORE-2368 and ORA-00001 raised', 'ISH-CORE-2368 and ORA-00001 raised'],
    ["Error executing script 'app_x/cartridge/controllers/Cart.js#42': boom", "Error executing script 'app_x/cartridge/controllers/Cart.js': boom"],
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
  for (const kept of ['TypeError: Cannot read property of undefined', 'deadbeef failed', 'ISH-CORE-2368 Error executing script', 'calculateLineTotal failed']) assert.equal(normalize(kept), kept)
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
