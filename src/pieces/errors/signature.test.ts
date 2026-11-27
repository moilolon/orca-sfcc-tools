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
    [noTrace('Cart-Show', 'custom.Basket', 'Basket could not be calculated'), noTrace('Account-Show', 'custom.Basket', 'Basket could not be calculated')],
    [
      noTrace('Cart-Show', 'system.core', "Error executing script 'app_x/cartridge/controllers/Cart.js': TypeError: x is undefined"),
      noTrace('Cart-Show', 'system.core', "Error executing script 'app_x/cartridge/controllers/Search.js': TypeError: x is undefined")
    ],
    [noTrace('Cart-Show', 'custom.Payment', 'Unknown payment processor PAYMENT_PROC_ADYEN_V2'), noTrace('Cart-Show', 'custom.Payment', 'Unknown payment processor PAYMENT_PROC_PAYPAL_V3')],
    // And more of the same kind.
    [noTrace('Cart-Show', 'custom.Service', 'HTTP/1.1 502 from upstream'), noTrace('Cart-Show', 'custom.Service', 'HTTP/1.1 504 from upstream')],
    [noTrace('Cart-Show', 'custom.Service', 'call failed with status code 401'), noTrace('Cart-Show', 'custom.Service', 'call failed with status code 403')],
    [noTrace('Cart-Show', 'custom.Service', 'Response 401 Unauthorized'), noTrace('Cart-Show', 'custom.Service', 'Response 403 Forbidden')],
    [noTrace('Cart-Show', 'custom.Service', 'Service responded with 401'), noTrace('Cart-Show', 'custom.Service', 'Service responded with 403')],
    [noTrace('Cart-Show', 'custom.Service', 'Bad response code: 500'), noTrace('Cart-Show', 'custom.Service', 'Bad response code: 502')],
    [noTrace('Cart-Show', 'system.core', 'ISH-CORE-2368 Error executing script'), noTrace('Cart-Show', 'system.core', 'ISH-CORE-2482 Error executing script')],
    [noTrace('Cart-Show', 'custom.Db', 'ORA-00001 unique constraint'), noTrace('Cart-Show', 'custom.Db', 'ORA-01400 unique constraint')],
    [noTrace('Cart-Show', 'custom.Service', 'rejected with statusCode=429'), noTrace('Cart-Show', 'custom.Service', 'rejected with statusCode=400')],
    [noTrace('Cart-Show', 'custom.Db', 'insert failed, errorCode=1400'), noTrace('Cart-Show', 'custom.Db', 'insert failed, errorCode=2291')],
    [noTrace('Cart-Show', 'custom.Codec', 'Base64Encoder failed'), noTrace('Cart-Show', 'custom.Codec', 'Base64Decoder failed')],
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

test('numbers of a customer or a business never survive: SKUs, orders, gift cards, postal and one-time codes', () => {
  const line = (text: string) => `PipelineCallServlet|1|Sites-A-Site|COPlaceOrder-Submit|PipelineCall|s custom.Order ${text}`
  const samples: [string, string, string][] = [
    ['Product SKU-123456 not found', 'Product SKU-987654 not found', 'Product <code> not found'],
    ['Payment failed for order GB-00012345', 'Payment failed for order GB-00067890', 'Payment failed for order <code>'],
    ['Gift card GC-40021 balance check failed', 'Gift card GC-77310 balance check failed', 'Gift card <code> balance check failed'],
    ['Password reset code: 5521 rejected', 'Password reset code: 9034 rejected', 'Password reset code: # rejected'],
    ['Invalid verification code 483920', 'Invalid verification code 120577', 'Invalid verification code #'],
    ['Unknown postal code 28013', 'Unknown postal code 08001', 'Unknown postal code #'],
    ['Search returned 250 hits over the limit', 'Search returned 312 hits over the limit', 'Search returned # hits over the limit'],
    ['Order 00012345 total 59.90 rejected', 'Order 77 total 1200.00 rejected', 'Order # total #.# rejected']
  ]
  for (const [a, b, expected] of samples) {
    assert.equal(normalize(a), expected, a)
    assert.ok(!/\d/.test(normalize(a)) && !/\d/.test(normalize(b)), `no digit of ${a} survives`)
    assert.equal(signatureOf(line(a)).signature, signatureOf(line(b)).signature, `${a} / ${b}`)
  }
})

test('a status right after response, and the platform’s own codes, keep their number; a customer’s still does not', () => {
  const cases: [string, string][] = [
    ['Response 401 Unauthorized', 'Response 401 Unauthorized'],
    ['Service responded with 403', 'Service responded with 403'],
    ['Bad response code: 500', 'Bad response code: 500'],
    ['Response time 503 ms', 'Response time # ms'],
    ['response 12345 received', 'response # received'],
    ['response for order 404', 'response for order #'],
    ['ISH-CORE-2368 Error executing script', 'ISH-CORE-2368 Error executing script'],
    ['ISH-ORM-12 failed', 'ISH-ORM-12 failed'],
    ['ORA-01400 cannot insert', 'ORA-01400 cannot insert'],
    ['Payment failed for order GB-00012345', 'Payment failed for order <code>'],
    ['Product SKU-123456 not found', 'Product <code> not found'],
    ['Order ORD-778899 not found', 'Order <code> not found'],
    ['Gift card ISH-40021 rejected', 'Gift card <code> rejected']
  ]
  for (const [input, expected] of cases) assert.equal(normalize(input), expected, input)
})

test('only an HTTP status after its label, or an error code after its label, keeps its number', () => {
  const kept: [string, string][] = [
    ['call failed with status 404', 'call failed with status 404'],
    ['call failed with status code 503', 'call failed with status code 503'],
    ['rejected, statusCode=429', 'rejected, statusCode=429'],
    ['HTTP 500 from upstream', 'HTTP 500 from upstream'],
    ['failed with error code 17', 'failed with error code 17'],
    ['failed, errorCode: 2048', 'failed, errorCode: 2048'],
    ['failed, error-code=7', 'failed, error-code=7']
  ]
  for (const [input, expected] of kept) assert.equal(normalize(input), expected, input)
  const dropped: [string, string][] = [
    ['status 42 of the job', 'status # of the job'],
    ['status 700 unknown', 'status # unknown'],
    ['status 4041 unknown', 'status # unknown'],
    ['code 404 sent', 'code # sent'],
    ['errorCode=E17', 'errorCode=E#'],
    ['status of order 404', 'status of order #']
  ]
  for (const [input, expected] of dropped) assert.equal(normalize(input), expected, input)
})

test('a host without a scheme becomes <host>; a file, a dw name or a Java package stays', () => {
  const hosts: [string, string][] = [
    ['Connection to shop.example.com refused', 'Connection to <host> refused'],
    ['Lookup of mailhost.example.com timed out', 'Lookup of <host> timed out'],
    ['Connecting to sftp.partner.example.org:22 failed', 'Connecting to <host> failed'],
    ['Feed from cdn-03.example.net is stale', 'Feed from <host> is stale'],
    ['Call to api.example.co.uk failed.', 'Call to <host> failed.'],
    ['Shop shop.example.fr is down', 'Shop <host> is down']
  ]
  for (const [input, expected] of hosts) assert.equal(normalize(input), expected, input)
  const line = (host: string) => `PipelineCallServlet|1|Sites-A-Site|Cart-Show|PipelineCall|s custom.Http Connection to ${host} refused`
  assert.equal(signatureOf(line('shop.example.com')).signature, signatureOf(line('shop.example.fr')).signature)
  assert.equal(signatureOf(line('cdn-03.example.net')).signature, signatureOf(line('cdn-17.example.net')).signature)

  const kept = [
    'java.lang.IllegalStateException thrown',
    'dw.order.Basket.getProductLineItems failed',
    'org.apache.commons.io failed',
    'java.io failed',
    'dw.io.File failed',
    'loading app.js failed',
    'loading jquery.min.js failed',
    'loading Cart.js failed',
    'reading dw.json failed',
    'reading site.xml failed',
    'reading messages.properties failed',
    'reading helper.ds failed',
    'reading product.isml failed',
    'reading data.csv failed',
    'value of basket.id is empty',
    'logger custom.Cart and system.core'
  ]
  for (const input of kept) assert.equal(normalize(input), input, input)
})

test('a script expression is never a host; a host of three labels on a word-like or country ending still is', () => {
  const expressions = [
    'logger.info is null',
    'request.site is null',
    'this.store is null',
    'config.local is null',
    'window.app is null',
    'basket.shop is null',
    'payment.gateway.ok is null',
    'de.example.ui is null',
    'session.custom.cart is null',
    'pdict.basket.total is null',
    'module.exports is null',
    'mailhost.internal is null'
  ]
  for (const input of expressions) assert.equal(normalize(input), input, input)
  const line = (text: string) => `PipelineCallServlet|1|Sites-A-Site|Cart-Show|PipelineCall|s custom.Cart ${text}`
  assert.notEqual(signatureOf(line('request.site is null')).signature, signatureOf(line('this.store is null')).signature)
  const hosts: [string, string][] = [
    ['Connection to shop.example.de refused', 'Connection to <host> refused'],
    ['Connection to storefront.example.shop refused', 'Connection to <host> refused'],
    ['Connection to cdn.example.io refused', 'Connection to <host> refused'],
    ['Connection to shop.example.com refused', 'Connection to <host> refused'],
    ['Connection to fr.shop.example.com refused', 'Connection to <host> refused']
  ]
  for (const [input, expected] of hosts) assert.equal(normalize(input), expected, input)
})

test('a domain of two labels becomes <host> inside brackets or quotes, or after a word that names a host', () => {
  const hosts: [string, string][] = [
    ['Cannot resolve domain [example.eu] with selector [default]', 'Cannot resolve domain [<host>] with selector [default]'],
    ['Lookup failed (example.de)', 'Lookup failed (<host>)'],
    ['Redirect to <example.fr> refused', 'Redirect to <<host>> refused'],
    ['Cookie for example.eu: rejected [example.nl]', 'Cookie for example.eu: rejected [<host>]'],
    ['Unknown host example.it', 'Unknown host <host>'],
    ['Unknown Host: Example.IT', 'Unknown Host: <host>'],
    ['hostname=example.app refused', 'hostname=<host> refused'],
    ['server example.store is down', 'server <host> is down'],
    ['domain: example.local', 'domain: <host>'],
    ['URL //example.shop/cart failed', 'URL //<host>/cart failed'],
    ['Loaded from //cdn.example.de/app.js', 'Loaded from //<host>/app.js'],
    ['Sent as @example.eu', 'Sent as @<host>'],
    ['Domain [shop.example.eu:443] refused', 'Domain [<host>] refused']
  ]
  for (const [input, expected] of hosts) assert.equal(normalize(input), expected, input)
  const line = (domain: string) => `PipelineCallServlet|1|Sites-A-Site|Cart-Show|PipelineCall|s custom.Http Cannot resolve domain [${domain}] with selector [default]`
  assert.equal(signatureOf(line('example.eu')).signature, signatureOf(line('example.de')).signature)
  assert.ok(!signatureOf(line('example.eu')).identity.message.includes('example'))

  // Script expressions and file names stay where they stood, inside brackets or after those words.
  const kept = [
    'value of [basket.id] is empty',
    'value of (this.store) is null',
    'value of [config.local] is null',
    'value of (obj.info) is null',
    'value of [request.site] is null',
    'loading (Cart.js) failed',
    'loading [app.min.js] failed',
    'reading (dw.json) failed',
    'host dw.system.Site is null',
    'server logger.info is null',
    'url this.store is null',
    'host Cart.js failed',
    'calling (de.ui) failed',
    'logger custom.Cart and system.core',
    'value of (item.id) is empty'
  ]
  for (const input of kept) assert.equal(normalize(input), input, input)
})

test('each brand domain the review found in brackets is a host: any country or common ending, any case, with a path', () => {
  const hosts: [string, string][] = [
    // Country endings that are also words, inside brackets.
    ['site [example.it]', 'site [<host>]'],
    ['site [example.at]', 'site [<host>]'],
    ['site [example.be]', 'site [<host>]'],
    ['site [example.no]', 'site [<host>]'],
    ['site [example.us]', 'site [<host>]'],
    ['site [example.me]', 'site [<host>]'],
    // Generic endings that are also words.
    ['site [example.shop]', 'site [<host>]'],
    ['site [example.store]', 'site [<host>]'],
    ['site [example.online]', 'site [<host>]'],
    ['site (example.app)', 'site (<host>)'],
    ["site 'example.fashion'", 'site <q>'],
    // Capitals.
    ['site [Example.eu]', 'site [<host>]'],
    ['site (MyExample.eu)', 'site (<host>)'],
    ['Connection to SHOP.EXAMPLE.DE refused', 'Connection to <host> refused'],
    // A path or a port after it, or a list.
    ['site [example.eu/de]', 'site [<host>/de]'],
    ['site [example.eu:8443]', 'site [<host>]'],
    ['site [example.eu, example.de]', 'site [<host>, <host>]'],
    ['sites (example.it; example.at) failed', 'sites (<host>; <host>) failed'],
    ['site [Example.IT/it-it/cart]', 'site [<host>/it-it/cart]'],
    ['url=example.eu/path', 'url=<host>/path'],
    ['server example.eu:8443 refused', 'server <host> refused'],
    ['HOST: SHOP.EXAMPLE.DE', 'HOST: <host>'],
    ['domain: example.it', 'domain: <host>'],
    ['host example.app', 'host <host>']
  ]
  for (const [input, expected] of hosts) assert.equal(normalize(input), expected, input)

  // Script expressions and file names stay, inside brackets too, in any case.
  const kept = [
    'request.site is null',
    'loading Cart.js failed',
    'dw.order.Basket failed',
    'x.length is null',
    'value of [basket.id] is empty',
    'value of (item.id) is empty',
    'value of [value.is] is empty',
    'value of (this.store) is null',
    'reading (java.io.File) failed',
    'value of (Math.PI) is NaN',
    'price [obj.de] is wrong',
    'label (resources.fr) is missing',
    'lang <messages.fr> is missing',
    'loading (Cart.js) and [app.min.js] and (helper.ds) failed',
    'reading (messages.properties) failed',
    'calling (de.ui) failed',
    'value of (Product.ID) is null',
    'Logger.info is null'
  ]
  for (const input of kept) assert.equal(normalize(input), input, input)
  assert.equal(normalize('version 1.2.3'), 'version #.#.#')
  assert.equal(normalize('from 10.0.0.1'), 'from <ip>')
  assert.equal(normalize('mail ops@example.eu'), 'mail <email>')
})

test('IPv6 addresses become <ip>; a time does not', () => {
  assert.equal(normalize('from 2001:db8::7a3f refused'), 'from <ip> refused')
  assert.equal(normalize('from fe80::1 refused'), 'from <ip> refused')
  assert.equal(normalize('from 2001:0db8:85a3:0000:0000:8a2e:0370:7334 refused'), 'from <ip> refused')
  assert.equal(normalize('at 10:15:02 done'), 'at #:#:# done')
})

test('a two-letter path segment is a locale only in a storefront path', () => {
  assert.equal(normalize('GET https://api.example.com/dw/shop/v1/baskets failed'), 'GET /dw/shop/v#/baskets failed')
  assert.notEqual(normalize('GET https://api.example.com/dw/shop/v1/baskets failed'), normalize('GET https://api.example.com/ws/shop/v1/baskets failed'))
  assert.equal(normalize('GET https://www.example.com/s/Shop/fr/cart failed'), 'GET /s/Shop/<locale>/cart failed')
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
    ['HTTP/1.1 503 from upstream', 'HTTP/#.# 503 from upstream'],
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
  for (const kept of ['TypeError: Cannot read property of undefined', 'deadbeef failed', 'Error executing script', 'calculateLineTotal failed', 'Base#Encoder failed']) assert.equal(normalize(kept), kept)
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
