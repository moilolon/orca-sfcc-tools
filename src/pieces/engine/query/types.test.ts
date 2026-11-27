// The type of an expression (phase 6.4), on the invented checkout and the committed `dw.*` index:
// from the initialiser, JSDoc, the globals and the previous call in a chain; one variable, one
// type; a cartridge module and its members; and, when in doubt, nothing.
import { assert, test } from 'orca/testing'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as AST from '../js/ast'
import { pathAt, rootAt } from './analysis'
import { at, BASE, committedDw, fixtureContext } from './testing'
import { docTag, guessedClass, isExtensible, jsdocType, metadataTypeOf, Types, type QType } from './types'

const SCRIPT = `${BASE}/cartridge/scripts/helpers/garden.js`
const TEMPLATE = `${BASE}/cartridge/templates/default/garden.isml`

/** The type of the innermost expression ending at the cursor (`a.b‸` is `a.b`). */
async function typeAt(marked: string, path = SCRIPT): Promise<QType | null> {
  const ctx = await fixtureContext()
  const { analysis, offset } = at(path, marked)
  const root = rootAt(analysis, offset)
  assert.ok(root, 'the cursor is in JavaScript')
  const nodes = pathAt((root as NonNullable<typeof root>).node, offset)
  // The outermost expression that ends at the cursor: `a.b.c‸` is the whole chain.
  const node = nodes.find((each) => each.end === offset && each.type !== 'Program' && !/Statement|Declaration$/.test(each.type) && each.type !== 'VariableDeclarator') as AST.Expression | undefined
  assert.ok(node, 'an expression ends at the cursor')
  return new Types({ ...ctx, analysis }).of(node as AST.Expression)
}

const instance = (id: string): QType => ({ kind: 'instance', id })

test('types 1. the initialiser: new, require of a dw class or package, a Mgr call’s return type', async () => {
  assert.deepEqual(await typeAt("var list = new dw.util.ArrayList();\nlist‸"), instance('dw.util.ArrayList'))
  assert.deepEqual(await typeAt("var ArrayList = require('dw/util/ArrayList');\nvar list = new ArrayList();\nlist‸"), instance('dw.util.ArrayList'))
  assert.deepEqual(await typeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr‸"), { kind: 'class', id: 'dw.catalog.ProductMgr' })
  assert.deepEqual(await typeAt("var catalog = require('dw/catalog');\ncatalog‸"), { kind: 'package', name: 'dw.catalog' })
  assert.deepEqual(await typeAt("var catalog = require('dw/catalog');\ncatalog.ProductMgr‸"), { kind: 'class', id: 'dw.catalog.ProductMgr' })
  assert.deepEqual(await typeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nvar product = ProductMgr.getProduct('p1');\nproduct‸"), instance('dw.catalog.Product'))
  assert.deepEqual(await typeAt("var product = dw.catalog.ProductMgr.getProduct('p1');\nproduct‸"), instance('dw.catalog.Product'))
  // A static property read off the class: the index marks none static, its getter is.
  assert.deepEqual(await typeAt("var Site = require('dw/system/Site');\nvar site = Site.current;\nsite‸"), instance('dw.system.Site'))
  assert.deepEqual(await typeAt("var Site = require('dw/system/Site');\nSite.getCurrent().preferences‸"), instance('dw.system.SitePreferences'))
  // Literals.
  assert.deepEqual(await typeAt("var label = 'a';\nlabel‸"), instance('TopLevel.String'))
  assert.deepEqual(await typeAt('var count = 3;\ncount‸'), instance('TopLevel.Number'))
})

test('types 2. JSDoc: @type on a declaration, @param on its function, generics and nullable read as their type', async () => {
  assert.deepEqual(await typeAt('/** @type {dw.order.Basket} */\nvar basket = helpers.current();\nbasket‸'), instance('dw.order.Basket'))
  assert.deepEqual(await typeAt('/**\n * @param {dw.catalog.Product} product - the product\n * @param {string} [label] - a label\n */\nfunction show(product, label) {\n    return product‸;\n}'), instance('dw.catalog.Product'))
  assert.deepEqual(await typeAt('/**\n * @param {dw.catalog.Product} product - the product\n * @param {string} [label] - a label\n */\nfunction show(product, label) {\n    return label‸;\n}'), instance('TopLevel.String'))
  // Through an object's property and an assignment.
  assert.deepEqual(await typeAt('module.exports = {\n    /** @param {dw.order.Order} order - the order */\n    total: function (order) { return order‸; }\n};'), instance('dw.order.Order'))
  assert.deepEqual(await typeAt('/** @param {dw.order.Order} order - the order */\nexports.total = function (order) { return order‸; };'), instance('dw.order.Order'))
  assert.deepEqual(await typeAt('/** @type {dw.util.Collection<dw.catalog.Product>} */\nvar list = x();\nlist‸'), instance('dw.util.Collection'))
  assert.deepEqual(await typeAt('/** @type {?dw.catalog.Product} */\nvar p = x();\np‸'), instance('dw.catalog.Product'))
  assert.deepEqual(await typeAt('/** @type {dw.catalog.Product|null} */\nvar p = x();\np‸'), instance('dw.catalog.Product'))
  assert.equal(docTag('@param {dw.order.Order} [order=null] - the order', 'param', 'order'), 'dw.order.Order')
  assert.equal(docTag('@return {String} the text', 'returns'), 'String')
})

test('types 3. the platform’s globals: request, session, customer, global functions; pdict is unknown', async () => {
  assert.deepEqual(await typeAt('request‸'), instance('dw.system.Request'))
  assert.deepEqual(await typeAt('session‸'), instance('dw.system.Session'))
  assert.deepEqual(await typeAt('customer‸'), instance('dw.customer.Customer'))
  assert.deepEqual(await typeAt('customer.profile‸'), instance('dw.customer.Profile'))
  assert.deepEqual(await typeAt('request.httpParameterMap‸'), instance('dw.web.HttpParameterMap'))
  assert.deepEqual(await typeAt('empty‸'), { kind: 'method', owner: 'TopLevel.global', name: 'empty', static: true })
  assert.deepEqual(await typeAt('empty(x)‸'), instance('TopLevel.Boolean'))
  assert.deepEqual(await typeAt('dw‸'), { kind: 'package', name: 'dw' })
  assert.deepEqual(await typeAt('dw.catalog‸'), { kind: 'package', name: 'dw.catalog' })
  assert.equal(await typeAt('pdict‸', TEMPLATE.replace('.isml', '.js')), null)
  // A template sees the classes ISML imports for it; a script does not.
  assert.deepEqual(await typeAt('<div>${URLUtils‸}</div>', TEMPLATE), { kind: 'class', id: 'dw.web.URLUtils' })
  assert.equal(await typeAt('URLUtils‸'), null)
  assert.equal(await typeAt('<div>${pdict.product‸}</div>', TEMPLATE), null)
  // A local name hides a global.
  assert.equal(await typeAt('function f(request) { return request‸; }'), null)
})

test('types 4. the previous call’s return type in a chain; overloads chosen by the number of arguments', async () => {
  assert.deepEqual(await typeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id).getVariationModel()‸"), instance('dw.catalog.ProductVariationModel'))
  assert.deepEqual(await typeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id).getVariationModel().getDefaultVariant()‸"), instance('dw.catalog.Variant'))
  assert.deepEqual(await typeAt('session.getCustomer().getProfile()‸'), instance('dw.customer.Profile'))
  // `void` is no type.
  assert.equal(await typeAt('var ArrayList = require(\'dw/util/ArrayList\');\nnew ArrayList().clear()‸'), null)
  // A custom object read by its type id: that type's attributes.
  assert.deepEqual(await typeAt("var CustomObjectMgr = require('dw/object/CustomObjectMgr');\nCustomObjectMgr.getCustomObject('GardenWishlist', 'w1')‸"), { kind: 'instance', id: 'dw.object.CustomObject', objectType: 'GardenWishlist' })
  assert.deepEqual(await typeAt("var CustomObjectMgr = require('dw/object/CustomObjectMgr');\nCustomObjectMgr.getCustomObject('GardenWishlist', 'w1').custom‸"), { kind: 'custom', typeId: 'GardenWishlist' })
  assert.deepEqual(await typeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.getProduct(id).custom‸"), { kind: 'custom', typeId: 'Product' })
})

test('types 5. one variable, one type: two types, or an unknown value, make it unknown; the same type twice, or null, does not', async () => {
  assert.equal(await typeAt("var ArrayList = require('dw/util/ArrayList');\nvar HashMap = require('dw/util/HashMap');\nvar items = new ArrayList();\nitems = new HashMap();\nitems‸"), null)
  assert.deepEqual(await typeAt("var ArrayList = require('dw/util/ArrayList');\nvar items = new ArrayList();\nif (x) { items = new ArrayList(); }\nitems‸"), instance('dw.util.ArrayList'))
  assert.equal(await typeAt("var ArrayList = require('dw/util/ArrayList');\nvar items = new ArrayList();\nitems = helpers.list();\nitems‸"), null)
  assert.deepEqual(await typeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nvar product = null;\nif (id) { product = ProductMgr.getProduct(id); }\nproduct‸"), instance('dw.catalog.Product'))
  // A JSDoc tag that agrees with every known value settles the unknown ones; one that disagrees does not.
  assert.deepEqual(await typeAt("/** @type {dw.util.ArrayList} */\nvar items = helpers.list();\nitems = new dw.util.ArrayList();\nitems‸"), instance('dw.util.ArrayList'))
  assert.equal(await typeAt("/** @type {dw.util.HashMap} */\nvar items = new dw.util.ArrayList();\nitems‸"), null)
  // Another kind of write: `+=`, `++`, a for…in target.
  assert.equal(await typeAt("var label = 'a';\nlabel += 1;\nlabel‸"), null)
  assert.equal(await typeAt('var key = 0;\nfor (key in map) {}\nkey‸'), null)
  // A name inside a pattern is not its initialiser.
  assert.equal(await typeAt("var { name } = require('dw/catalog/ProductMgr').getProduct(id);\nname‸"), null)
  // A parameter reassigned to a default keeps its JSDoc type only when the default agrees.
  assert.deepEqual(await typeAt('/** @param {string} label - x */\nfunction f(label) {\n    label = label || \'none\';\n    return label‸;\n}'), instance('TopLevel.String'))
})

test('types 5. one binding: a var declared twice in a function, or a var of a parameter’s name, counts every declaration', async () => {
  // Two declarations of different types: unknown, wherever the name is read.
  assert.equal(await typeAt('function f(a) {\n    if (a) {\n        var result = new dw.util.ArrayList();\n    } else {\n        var result = new dw.util.HashMap();\n    }\n    return result‸;\n}'), null)
  assert.equal(await typeAt('var x = new dw.util.ArrayList();\nvar x = new dw.util.HashMap();\nx‸'), null)
  assert.equal(await typeAt('function f(a) {\n    var x = new dw.util.ArrayList();\n    if (a) { var x = 5; }\n    return x‸;\n}'), null)
  // An unknown value in one of them: unknown too.
  assert.equal(await typeAt('var x = new dw.util.ArrayList();\nvar x = helpers.list();\nx‸'), null)
  // The same type twice: that type.
  assert.deepEqual(await typeAt('var x = new dw.util.ArrayList();\nif (a) { var x = new dw.util.ArrayList(); }\nx‸'), instance('dw.util.ArrayList'))
  // A var of a parameter's name is the parameter: its @param and the value disagree.
  assert.equal(await typeAt('/** @param {dw.order.Order} order - the order */\nfunction f(order) {\n    var order = 5;\n    return order‸;\n}'), null)
  // In separate functions, two names are two bindings.
  assert.deepEqual(await typeAt('function a() { var x = new dw.util.HashMap(); }\nfunction b() {\n    var x = new dw.util.ArrayList();\n    return x‸;\n}'), instance('dw.util.ArrayList'))
})

test('types 5. a parameter is typed by its @param only: without one it is unknown, whatever the body assigns', async () => {
  assert.equal(await typeAt('function f(list) {\n    if (!list) {\n        list = new dw.util.ArrayList();\n    }\n    return list‸;\n}'), null)
  assert.equal(await typeAt('function f(list) {\n    list = list || new dw.util.ArrayList();\n    return list‸;\n}'), null)
  assert.equal(await typeAt('function f(list) {\n    return list‸;\n}'), null)
  // With a @param, an assignment that agrees keeps it; one that disagrees makes it unknown.
  assert.deepEqual(await typeAt('/** @param {dw.util.ArrayList} list - the list */\nfunction f(list) {\n    list = list || new dw.util.ArrayList();\n    return list‸;\n}'), instance('dw.util.ArrayList'))
  assert.equal(await typeAt('/** @param {dw.util.ArrayList} list - the list */\nfunction f(list) {\n    list = new dw.util.HashMap();\n    return list‸;\n}'), null)
})

test('types 7. inside with (o) { … } a name may be a property of o: unknown', async () => {
  assert.equal(await typeAt('var list = new dw.util.ArrayList();\nwith (o) {\n    list‸;\n}'), null)
  assert.deepEqual(await typeAt('var list = new dw.util.ArrayList();\nwith (o) {}\nlist‸'), instance('dw.util.ArrayList'))
})

test('types 6. a cartridge module and its members; a member’s @returns; what project code builds is never a dw type', async () => {
  assert.deepEqual(await typeAt("var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\npriceHelper‸"), { kind: 'module', module: '*/cartridge/scripts/helpers/priceHelper', from: SCRIPT })
  assert.deepEqual(await typeAt("var priceHelper = require('*/cartridge/scripts/helpers/priceHelper');\npriceHelper.price‸"), { kind: 'member', module: '*/cartridge/scripts/helpers/priceHelper', from: SCRIPT, name: 'price' })
  assert.deepEqual(await typeAt("var price = require('*/cartridge/scripts/helpers/priceHelper').price;\nprice‸"), { kind: 'member', module: '*/cartridge/scripts/helpers/priceHelper', from: SCRIPT, name: 'price' })
  assert.deepEqual(await typeAt("var { price } = require('*/cartridge/scripts/helpers/priceHelper');\nprice‸"), { kind: 'member', module: '*/cartridge/scripts/helpers/priceHelper', from: SCRIPT, name: 'price' })
  // The core collections add `first`, documented to return a product, to the base ones.
  assert.deepEqual(await typeAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.first(list)‸"), instance('dw.catalog.Product'))
  // `map` has no @returns: a value of the project's.
  assert.deepEqual(await typeAt("var collections = require('*/cartridge/scripts/util/collections');\ncollections.map(list, f)‸"), { kind: 'project' })
  assert.deepEqual(await typeAt("var Product = require('*/cartridge/models/product');\nnew Product(apiProduct)‸"), { kind: 'project' })
})

test('types 7. when in doubt, nothing: unknown globals, members of unknown values, JSDoc naming a project type or a union', async () => {
  assert.equal(await typeAt('garden‸'), null)
  assert.equal(await typeAt('garden.product‸'), null)
  assert.equal(await typeAt('helpers.getProduct(id)‸'), null)
  assert.equal(await typeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nProductMgr.noSuchThing‸"), null)
  assert.equal(await typeAt('/** @type {Product} */\nvar p = x();\np‸'), null)
  assert.equal(await typeAt('/** @type {dw.catalog.Product|dw.order.Order} */\nvar p = x();\np‸'), null)
  assert.equal(await typeAt('/** @type {dw.garden.Nothing} */\nvar p = x();\np‸'), null)
  assert.equal(await typeAt('this‸'), null)
  // `a && b` may be a falsy `a`.
  assert.equal(await typeAt("var ProductMgr = require('dw/catalog/ProductMgr');\nvar p = id && ProductMgr.getProduct(id);\np‸"), null)
})

test('types 8. the metadata type of a class, and the short list of guessed names', () => {
  const dw = committedDw()
  assert.equal(isExtensible(dw, 'dw.catalog.Product'), true)
  assert.equal(isExtensible(dw, 'dw.customer.Customer'), false)
  assert.equal(metadataTypeOf(dw, 'dw.catalog.Product'), 'Product')
  assert.equal(metadataTypeOf(dw, 'dw.catalog.Variant'), 'Product')
  assert.equal(metadataTypeOf(dw, 'dw.system.SitePreferences'), 'SitePreferences')
  assert.equal(metadataTypeOf(dw, 'dw.object.CustomObject'), null)
  assert.equal(metadataTypeOf(dw, 'dw.object.CustomObject', 'GardenWishlist'), 'GardenWishlist')
  assert.equal(metadataTypeOf(dw, 'dw.customer.Customer'), null)
  assert.equal(guessedClass('apiProduct'), 'dw.catalog.Product')
  assert.equal(guessedClass('lineItem'), 'dw.order.ProductLineItem')
  assert.equal(guessedClass('item'), null)
  assert.equal(guessedClass('productModel'), null)
  assert.deepEqual(jsdocType(dw, 'String'), { kind: 'instance', id: 'TopLevel.String' })
  assert.equal(jsdocType(dw, 'Object'), null)
  assert.equal(jsdocType(null, 'dw.catalog.Product'), null)
})

test('the query modules import nothing but each other and the engine’s pure modules: no Node, no Orca', () => {
  const here = fileURLToPath(new URL('./', import.meta.url))
  const modules = readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'testing.ts')
  assert.ok(modules.length >= 6, modules.join(', '))
  for (const module of modules) {
    const source = readFileSync(join(here, module), 'utf8')
    const imports = [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const specifier of imports) {
      const pure = specifier.startsWith('./') || /^\.\.\/(js|isml)\//.test(specifier) || specifier === '../dw/index' || (/^\.\.\/checkout\//.test(specifier) && !/\/(disk|git|testing)$/.test(specifier))
      assert.ok(pure, `${module} imports ${specifier}`)
    }
    assert.ok(!/\brequire\(|process\.|globalThis\.orca/.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")), `${module} uses a runtime global`)
  }
})
