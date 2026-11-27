// Routes of controllers written before SFRA's `server`, on an invented checkout: `exports.Name =
// …` (wrapped in a guard, a function, a name of one) is a route declaration of that controller,
// with the function that handles it when it can be found; read with a storefront path and
// without one, by hover, completion and definition.
import { assert, test } from 'orca/testing'
import { CheckoutIndex } from '../checkout/checkout'
import { MemoryFiles } from '../checkout/memory'
import { scanScript } from '../checkout/scan'
import { complete } from './complete'
import { definition } from './definition'
import { hover, type Hover } from './hover'
import type { QueryContext } from './modules'
import { at, committedDw, dwLookup } from './testing'

const LEGACY = 'cartridges/app_legacy_garden'
const ACCOUNT = `${LEGACY}/cartridge/controllers/Account.js`
const ACCOUNT_TEXT = [
  "'use strict';",
  "var guard = require('~/cartridge/scripts/guard');",
  '',
  '/** Shows the account page. */',
  'function show() {',
  "    return 'account';",
  '}',
  '',
  'function start() {}',
  '',
  "exports.Show = guard.ensure(['get', 'https', 'loggedIn'], show);",
  "exports.Start = guard.ensure(['https'], start);",
  'exports.Login = function login() {};',
  'exports.Helper = show;',
  'exports.Version = 2;',
  "exports.Wrapped = guard.ensure(['get'], 'notAFunction');",
  ''
].join('\n')

function files(withSite: boolean): MemoryFiles {
  const entries: Record<string, string> = {
    [`${LEGACY}/.project`]: '<projectDescription><name>app_legacy_garden</name></projectDescription>',
    [ACCOUNT]: ACCOUNT_TEXT,
    [`${LEGACY}/cartridge/scripts/guard.js`]: 'exports.ensure = function (filters, action) { return action; };\n',
    'cartridges/app_new_garden/.project': '<projectDescription><name>app_new_garden</name></projectDescription>',
    'cartridges/app_new_garden/cartridge/controllers/Cart.js': "var server = require('server');\nserver.get('Show', function (req, res, next) { next(); });\nexports.Helper = function () {};\nmodule.exports = server.exports();\n",
    'modules/.project': '<projectDescription><name>modules</name></projectDescription>',
    'modules/server.js': 'module.exports = {};\n'
  }
  if (withSite) entries['sites/site_template/sites/LegacyShop/site.xml'] = '<site site-id="LegacyShop"><custom-cartridges>app_new_garden:app_legacy_garden</custom-cartridges></site>'
  return new MemoryFiles(entries)
}

async function context(withSite: boolean): Promise<QueryContext> {
  const index = new CheckoutIndex(files(withSite), { dw: dwLookup })
  await index.build()
  return { index, dw: committedDw() }
}

const lineOf = (snippet: string) => ACCOUNT_TEXT.slice(0, ACCOUNT_TEXT.indexOf(snippet)).split('\n').length

test('routes: exports.Name of a controller without server is a route, with the function a guard wraps as its handler', () => {
  const facts = scanScript(ACCOUNT_TEXT, { controller: true }).controller
  assert.ok(facts)
  assert.equal(facts?.exported, true)
  assert.deepEqual(
    facts?.operations.map((operation) => [operation.method, operation.name, operation.line, operation.handler?.line ?? null, ACCOUNT_TEXT.slice(operation.nameStart, operation.nameEnd)]),
    [
      ['export', 'Show', lineOf('exports.Show'), lineOf('function show'), 'Show'],
      ['export', 'Start', lineOf('exports.Start'), lineOf('function start'), 'Start'],
      ['export', 'Login', lineOf('exports.Login'), lineOf('exports.Login'), 'Login'],
      ['export', 'Helper', lineOf('exports.Helper'), lineOf('function show'), 'Helper'],
      // A wrapper given no function: a route, its handler unknown. A number is no route.
      ['export', 'Wrapped', lineOf('exports.Wrapped'), null, 'Wrapped']
    ]
  )
  // The handler's place is its name.
  const show = facts?.operations[0].handler
  assert.equal(show && ACCOUNT_TEXT.slice(show.start, show.end), 'show')
  // `module.exports = { Name: … }` too.
  assert.deepEqual(scanScript('function a() {}\nmodule.exports = { Show: a, Start: function () {} };', { controller: true }).controller?.operations.map((operation) => operation.name), ['Show', 'Start'])
  // A controller with `server` declares its routes through it only: its other exports are not routes.
  const sfra = scanScript("var server = require('server');\nserver.get('Show', function () {});\nexports.Helper = function () {};\nmodule.exports = server.exports();", { controller: true }).controller
  assert.deepEqual(sfra?.operations.map((operation) => [operation.method, operation.name]), [['get', 'Show']])
})

test('routes: with a storefront path, an exports.Name route serves the request; completion and definition find it', async () => {
  const ctx = await context(true)
  assert.deepEqual(ctx.index.routeIds('LegacyShop'), ['Account-Helper', 'Account-Login', 'Account-Show', 'Account-Start', 'Account-Wrapped', 'Cart-Show'])
  const asked = at('cartridges/app_new_garden/cartridge/scripts/x.js', "URLUtils.url('Account-Sh‸ow');")
  const route = hover(ctx, asked.analysis, asked.offset) as Extract<Hover, { kind: 'route' }>
  assert.equal(route.kind, 'route')
  const shop = route.storefronts[0]
  assert.deepEqual([shop.storefront, shop.controller, shop.problems], ['LegacyShop', ACCOUNT, []])
  assert.deepEqual(shop.serves && [shop.serves.method, shop.serves.line, shop.serves.handler?.line], ['export', lineOf('exports.Show'), lineOf('function show')])
  const listed = at('cartridges/app_new_garden/cartridge/scripts/x.js', "URLUtils.url('Account-‸');")
  assert.deepEqual(complete(ctx, listed.analysis, listed.offset).items.map((item) => item.label), ['Account-Helper', 'Account-Login', 'Account-Show', 'Account-Start', 'Account-Wrapped'])
  const found = definition(ctx, asked.analysis, asked.offset)
  assert.deepEqual(found?.targets, [{ path: ACCOUNT, start: ACCOUNT_TEXT.indexOf('Show ='), end: ACCOUNT_TEXT.indexOf('Show =') + 4, line: lineOf('exports.Show'), storefronts: ['LegacyShop'] }])
})

test('routes: without a storefront path, exports.Name routes are offered and hovered per cartridge', async () => {
  const ctx = await context(false)
  const listed = at('cartridges/app_new_garden/cartridge/scripts/x.js', "URLUtils.url('‸');")
  assert.deepEqual(
    complete(ctx, listed.analysis, listed.offset).items.map((item) => [item.label, item.detail]),
    [
      ['Account-Helper', 'app_legacy_garden'],
      ['Account-Login', 'app_legacy_garden'],
      ['Account-Show', 'app_legacy_garden'],
      ['Account-Start', 'app_legacy_garden'],
      ['Account-Wrapped', 'app_legacy_garden'],
      ['Cart-Show', 'app_new_garden']
    ]
  )
  const asked = at('cartridges/app_new_garden/cartridge/scripts/x.js', "URLUtils.url('Account-Sta‸rt');")
  const route = hover(ctx, asked.analysis, asked.offset) as Extract<Hover, { kind: 'route' }>
  assert.deepEqual(route.cartridges.map((each) => [each.cartridge, each.steps.map((step) => [step.method, step.handler?.line])]), [['app_legacy_garden', [['export', lineOf('function start')]]]])
})
