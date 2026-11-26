// Invented log entries in the shape `b2c logs get --json` prints them: every site, session, id,
// address, host and script below is made up, hosts under example.com. One entry is one error,
// its stack trace inside `message`; `raw` is `[timestamp] LEVEL ` and the message.

export type FixtureEntry = { file: string; timestamp: string; level: string; message: string; raw: string }

function entry(file: string, timestamp: string, level: string, message: string): FixtureEntry {
  return { file, timestamp, level, message, raw: `[${timestamp}] ${level} ${message}` }
}

const ERROR_FILE = 'error-blade0-1-appserver-20261126.log'
const CUSTOM_FILE = 'customerror-blade0-1-appserver-20261126.log'

/** A script error in the cart, as the instance writes it: fields, logger, text, then the trace. */
export function cartError(options: {
  at: string
  thread?: string
  site?: string
  session?: string
  pid?: string
  email?: string
  request?: string
  lines?: [number, number, number]
  errorClass?: string
  script?: string
  functions?: [string, string, string]
  /** The storefront's host and locale in the URL of the first line. */
  host?: string
  locale?: string
}): FixtureEntry {
  const {
    at,
    thread = '1186012345',
    site = 'Sites-Example-Site',
    session = 'k3Jd8sLq0aZx2Vb7Nn4Mc1Pq',
    pid = '100234',
    email = 'jane.doe@example.com',
    request = '3f6c2a9e-1b7d-4c5e-9a0f-2d8e6b4c1a37',
    lines = [118, 64, 42],
    errorClass = 'TypeError',
    script = 'app_example/cartridge/scripts/helpers/cartHelper.js',
    functions = ['calculateLineTotal', 'addProductToCart', 'addProduct'],
    host = 'www.example.com',
    locale = 'en_US'
  } = options
  const message = [
    `PipelineCallServlet|${thread}|${site}|Cart-AddProduct|PipelineCall|${session} system.core ISH-CORE-2368 Error executing script 'app_example/cartridge/controllers/Cart.js': ${errorClass}: Cannot read property "price" of undefined (app_example/cartridge/scripts/helpers/cartHelper.js#${lines[0]}) at https://${host}/on/demandware.store/${site}/${locale}/Cart-AddProduct?pid=${pid}&qty=2 for ${email} request ${request} on ${at}`,
    'System Information',
    '------------------',
    `Log Time: ${at}`,
    'Instance Type: sandbox',
    'Request Information',
    '-------------------',
    `URI: /on/demandware.store/${site}/en_US/Cart-AddProduct`,
    'Stack trace',
    `\tat ${script}:${lines[0]} (${functions[0]})`,
    `\tat ${script}:${lines[1]} (${functions[1]})`,
    `\tat app_example/cartridge/controllers/Cart.js:${lines[2]} (${functions[2]})`,
    '\tat example.engine.ScriptRunner.call(ScriptRunner.java:210)',
    '\tat example.engine.RequestHandler.handle(RequestHandler.java:57)'
  ].join('\n')
  return entry(ERROR_FILE, at, 'ERROR', message)
}

/** A job error with Java frames only. */
export function jobError(at: string, file = 'export_20261126_1015.xml'): FixtureEntry {
  const message = [
    `JobThread|2201|Sites-Example-Site|ExportOrders|JobExecutor|  system.job Job step failed: java.lang.IllegalStateException: Export file /remote/IMPEX/src/${file} is locked`,
    'Stack trace',
    '\tat example.jobs.ExportStep.run(ExportStep.java:88)',
    '\tat example.jobs.JobExecutor.execute(JobExecutor.java:120)',
    '\tat example.jobs.Scheduler.fire(Scheduler.java:31)'
  ].join('\n')
  return entry(ERROR_FILE, at, 'ERROR', message)
}

/** A custom logger's error with no trace. */
export function paymentError(at: string, order: string, email: string, amount: string): FixtureEntry {
  const message = `PipelineCallServlet|1186099871|Sites-Example-Site|COPlaceOrder-Submit|PipelineCall|Zq81mPw0Lr5Tn2Yc custom.PaymentService ERROR - Payment authorization failed for order ${order}, customer ${email}, amount ${amount} EUR, reference 0x7f3a9c`
  return entry(CUSTOM_FILE, at, 'ERROR', message)
}

/**
 * A whole answer: two occurrences of the cart error that differ only in what varies, two of the
 * payment error, a job error, the cart's message from another script and the cart's script with
 * another error class. Out of order, as b2c gives them.
 */
export const LOGS_GET = (() => {
  const entries = [
    cartError({ at: '2026-11-26 10:15:02.123 GMT' }),
    jobError('2026-11-25 23:59:58.001 GMT'),
    paymentError('2026-11-26 09:00:00.500 GMT', '00012345', 'jane.doe@example.com', '59.90'),
    cartError({
      at: '2026-11-26 11:40:19.877 GMT',
      thread: '1186077777',
      site: 'Sites-Other-Site',
      session: 'Pq7Wm2Zt9Xc4Vb1Nn8Lk3Hj',
      pid: '200871',
      email: 'john.roe@example.org',
      request: '9b2e7c1d-4a6f-4e3b-8c5d-1f0a2b3c4d5e',
      lines: [121, 66, 45]
    }),
    paymentError('2026-11-26 08:30:12.004 GMT', '00067890', 'sam.poe@example.net', '120.00'),
    cartError({ at: '2026-11-26 07:05:44.310 GMT', script: 'app_example/cartridge/scripts/helpers/checkoutHelper.js', functions: ['calculateLineTotal', 'addProductToCart', 'addProduct'] }),
    cartError({ at: '2026-11-26 06:12:00.000 GMT', errorClass: 'ReferenceError' })
  ]
  return { count: entries.length, entries }
})()
