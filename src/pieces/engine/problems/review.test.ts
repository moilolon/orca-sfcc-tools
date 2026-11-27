// What the review of 6.5 found warned where nothing is wrong, each now silent, with what must
// still be warned beside it: a controller that reads `module.superModule` without
// `server.extend`, the attributes of the official form schema, the bundle each form of
// `Resource.msg` reads, accesses guarded for absence, and a bundle whose name ends like a locale.
import { assert, test } from 'orca/testing'
import { bundleBase, isBundleOf, isLocaleSuffix } from '../checkout/locales'
import { brief, BASE, checked, CORE } from './testing'
import { formUses } from './forms'

const HOME_BASE = "'use strict';\nvar server = require('server');\nserver.get('Show', function (req, res, next) { next(); });\nmodule.exports = server.exports();\n"

test('a controller that reads module.superModule at its top, without server.extend, appends to its base’s routes: SFRA shares one server', async () => {
  const home = `${CORE}/cartridge/controllers/Home.js`
  const sample = "var base = module.superModule;\nvar server = require('server');\nserver.append('Show', function (req, res, next) { next(); });\nmodule.exports = server.exports();\n"
  const check = await checked({ [home]: sample })
  assert.deepEqual(check.problems.problemsOf(home), [])
  // A route the base does not have is still refused, and no base is said to be missing.
  const wrong = await checked({ [home]: sample.replace("append('Show'", "append('Nope'") })
  assert.deepEqual(
    wrong.problems.problemsOf(home).map((each) => [each.code, each.args.route]),
    [['route_missing', 'Nope']]
  )
  const noBase = await checked({ [home]: sample.replace("append('Show'", "get('Other'"), [`${BASE}/cartridge/controllers/Home.js`]: null })
  assert.deepEqual(noBase.problems.problemsOf(home), [])
  // The base unchanged: the one the fixture has.
  assert.ok((await checked({ [`${BASE}/cartridge/controllers/Home.js`]: HOME_BASE })).problems.problemsOf(`${BASE}/cartridge/controllers/Home.js`).length === 0)
})

test('when the base cannot be told (read inside a function, another controller required), no route problem', async () => {
  const home = `${CORE}/cartridge/controllers/Home.js`
  const nested = "var server = require('server');\nfunction base() { return module.superModule; }\nserver.append('Nope', function (req, res, next) { next(); });\nmodule.exports = server.exports();\n"
  assert.deepEqual((await checked({ [home]: nested })).problems.problemsOf(home), [])
  const required = "var server = require('server');\nrequire('*/cartridge/controllers/Product');\nserver.append('Show', function (req, res, next) { next(); });\nmodule.exports = server.exports();\n"
  assert.deepEqual((await checked({ [home]: required })).problems.problemsOf(home), [])
})

test('the form rules are the official schema’s: the twelve attributes it allows pass, `checked` on a field passes, `secure` only on the form', () => {
  const allowed =
    '<form xmlns="http://www.demandware.com/xml/form/2008-04-19" binding="b" object-def="Profile" description="d" form-error="e" secure="true">\n' +
    '  <group formid="g" object-def="Address" description="d"><field formid="x" type="string"/></group>\n' +
    '  <list formid="l" selectone-fieldid="s" object-def="ProductLineItem" description="d"><field formid="s" type="boolean"/></list>\n' +
    '  <field formid="f" type="string" attribute-def="name" masked="4"/>\n' +
    '  <field formid="c" type="boolean" checked="true"/>\n' +
    '  <action formid="a" binding="b"/>\n' +
    '</form>\n'
  assert.deepEqual(formUses(allowed).own, [])
  const outside =
    '<form xmlns="http://www.demandware.com/xml/form/2008-04-19">\n' +
    '  <group formid="g" secure="true"/>\n' +
    '  <field formid="f" type="string" secure="true" default="x"/>\n' +
    '  <option optionid="o"/>\n' +
    '  <field formid="h" type="string"><option optionid="o"/></field>\n' +
    '</form>\n'
  assert.deepEqual(
    formUses(outside).own.map((each) => [each.code, each.args.element, each.args.attribute ?? null]),
    [
      ['form_unknown_attribute', 'group', 'secure'],
      ['form_unknown_attribute', 'field', 'secure'],
      ['form_unknown_attribute', 'field', 'default'],
      ['form_unknown_element', 'option', null],
      ['form_unknown_element', 'option', null]
    ]
  )
})

test('each form of Resource.msg reads the bundle the documentation says: message for one or two arguments and a null bundle', async () => {
  const path = `${BASE}/cartridge/scripts/checks/messages.js`
  const check = await checked({ [`${BASE}/cartridge/templates/resources/message.properties`]: 'probe.inmessage=In the default bundle\n' })
  const text = [
    "var Resource = require('dw/web/Resource');",
    "Resource.msg('probe.inmessage');",
    "Resource.msg('probe.inmessage', 'Hello there');",
    "Resource.msg('probe.inmessage', null, 'Hello');",
    "Resource.msg('label.price', 'product', null);",
    "Resource.msgf('label.stock', 'product', null, 3);",
    "Resource.msgf('probe.inmessage', null, null);",
    "Resource.msg('probe.gone');",
    "Resource.msg('probe.gone', 'Hello there');",
    "Resource.msg('probe.gone', 'product', null);",
    "Resource.msgf('probe.gone', null, null, 1);",
    ''
  ].join('\n')
  assert.deepEqual(
    check.problems.analyseText(path, text).map((each) => [brief(text, each).line, each.code, each.args.key, each.args.bundle]),
    [
      [8, 'resource_missing', 'probe.gone', 'message'],
      [9, 'resource_missing', 'probe.gone', 'message'],
      [10, 'resource_missing', 'probe.gone', 'product'],
      [11, 'resource_missing', 'probe.gone', 'message']
    ]
  )
  // With no `message` bundle at all, the default one is the bundle missing.
  const none = await checked()
  assert.deepEqual(
    none.problems.analyseText(path, "Resource.msg('probe.x');\n").map((each) => [each.code, each.args.bundle]),
    [['bundle_missing', 'message']]
  )
})

test('an access the file guards for absence is not warned (in, hasOwnProperty, a comparison with nothing, a condition); a fallback or a use before the test is', async () => {
  const check = await checked()
  const path = `${BASE}/cartridge/scripts/checks/guarded.js`
  const header = "var ProductMgr = require('dw/catalog/ProductMgr');\nvar Site = require('dw/system/Site');\nvar product = ProductMgr.getProduct('1');\n"
  const guarded = [
    "var a = 'gardenSize' in product.custom ? product.custom.gardenSize : null;",
    "var b = product.custom.hasOwnProperty('gardenWidth') ? product.custom.gardenWidth : 0;",
    "var c = Object.prototype.hasOwnProperty.call(product.custom, 'gardenDepth') ? product.custom.gardenDepth : 0;",
    'var d = product.custom.gardenHeight !== undefined ? product.custom.gardenHeight : 0;',
    'if (product.custom.gardenWeight) { var e = product.custom.gardenWeight; }',
    "var f = 'gardenFlag' in Site.current.preferences.custom ? Site.current.preferences.custom.gardenFlag : false;",
    "if (Site.getCurrent().getCustomPreferenceValue('gardenLimit')) { var g = Site.getCurrent().getCustomPreferenceValue('gardenLimit'); }",
    'var k = product.custom.gardenNote && product.custom.gardenNote.length;',
    'if (product.custom.gardenNull == null) { var l = 0; } else { var m = product.custom.gardenNull; }',
    "if (typeof product.custom.gardenTag === 'undefined') { var h = null; } else { var i = product.custom.gardenTag; }"
  ]
  for (const line of guarded) assert.deepEqual(check.problems.analyseText(path, `${header}${line}\n`), [], line)
  // Unguarded, each is warned: a plain read, a fallback (which hides the absence), a comparison
  // with a value, and a use before the test.
  const plain = [
    'var x = product.custom.gardenSize;',
    "var y = Site.getCurrent().getCustomPreferenceValue('gardenLimit') || 10;",
    "if (product.ID != Site.current.getCustomPreferenceValue('gardenBox')) { var z = 1; }",
    'var w = product.custom.gardenLate;',
    "if ('gardenLate' in product.custom) { var v = product.custom.gardenLate; }"
  ].join('\n')
  assert.deepEqual(
    check.problems.analyseText(path, `${header}${plain}\n`).map((each) => [each.code, each.args.name, each.line]),
    [
      ['unknown_attribute', 'gardenSize', 4],
      ['unknown_preference', 'gardenLimit', 5],
      ['unknown_preference', 'gardenBox', 6],
      ['unknown_attribute', 'gardenLate', 7]
    ]
  )
})

test('a bundle whose name ends like a locale but is not one (garden_ui) is a bundle of its own; product_fr is still a locale of product', async () => {
  assert.ok(isLocaleSuffix('fr') && isLocaleSuffix('fr_FR') && isLocaleSuffix('pt_BR'))
  assert.ok(!isLocaleSuffix('ui') && !isLocaleSuffix('xx') && !isLocaleSuffix('fr_fr'))
  assert.equal(bundleBase('garden_ui'), 'garden_ui')
  assert.equal(bundleBase('product_fr'), 'product')
  assert.equal(bundleBase('product_fr_FR'), 'product')
  assert.ok(isBundleOf('product_fr', 'product') && !isBundleOf('garden_ui', 'garden'))
  const check = await checked({ [`${BASE}/cartridge/templates/resources/garden_ui.properties`]: 'probe.ui=A text\n' })
  assert.ok(check.index.bundleNames().includes('garden_ui'))
  const text = "var Resource = require('dw/web/Resource');\nResource.msg('probe.ui', 'garden_ui', null);\nResource.msg('label.price', 'product', null);\n"
  assert.deepEqual(check.problems.analyseText(`${BASE}/cartridge/scripts/checks/ui.js`, text), [])
})
