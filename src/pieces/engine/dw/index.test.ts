// The `dw.*` index: the loader and its queries on the invented garden (fixtures/dw), then on the
// committed data/dw-api.json: it loads, answers a known class, a method with its parameters and
// return type, an inherited member, a constant and deprecated ones, and holds no description.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { anchorOf, loadDwIndex, signature, type DwClass, type DwIndex, type DwIndexData } from './index'

const GARDEN = JSON.parse(readFileSync(new URL('../fixtures/dw/expected-index.json', import.meta.url), 'utf8')) as DwIndexData
const COMMITTED = JSON.parse(readFileSync(new URL('../../../../data/dw-api.json', import.meta.url), 'utf8')) as DwIndexData

function find(index: DwIndex, name: string): DwClass {
  const cls = index.findClass(name)
  assert.ok(cls, `${name} is in the index`)
  return cls
}

test('finds a class by its id, its module path or a bare name', () => {
  const index = loadDwIndex(GARDEN)
  assert.equal(index.version, '99.1')
  assert.equal(index.generated, '2026-01-01')
  const tree = find(index, 'dw.garden.Tree')
  assert.equal(index.findClass('dw/garden/Tree'), tree)
  assert.equal(index.findClass('Tree'), tree)
  assert.equal(index.findClass('Object')?.id, 'TopLevel.Object')
  assert.deepEqual([tree.package, tree.name, tree.super], ['dw.garden', 'Tree', 'dw.garden.Plant'])
  assert.deepEqual(find(index, 'Plant').subclasses, ['dw.garden.Tree'])
  assert.equal(index.findClass('dw.garden.Shrub'), null)
  assert.equal(index.findClass('dw/garden'), null)
  assert.deepEqual(index.packageClasses('dw/garden').map((cls) => cls.name), ['GardenMgr', 'Plant', 'Tree'])
  assert.deepEqual(index.packageClasses('dw.garden'), index.packageClasses('dw/garden'))
  assert.deepEqual(index.classes().map((cls) => cls.id), ['TopLevel.Object', 'dw.garden.GardenMgr', 'dw.garden.Plant', 'dw.garden.Tree'])
})

test('members resolve inheritance: own first, a redeclared one hides the farther, constructors stay home', () => {
  const index = loadDwIndex(GARDEN)
  const tree = find(index, 'dw.garden.Tree')
  const names = index.members(tree).map((member) => `${member.owner.slice(member.owner.lastIndexOf('.') + 1)}.${member.key}`)
  assert.deepEqual(names, [
    'Tree.height',
    'Tree.Tree()',
    'Tree.Tree(String)',
    'Tree.Tree(String, Number...)',
    'Tree.getName()',
    'Tree.grow(Number) - Variant 1',
    'Tree.grow(Number) - Variant 2',
    'Tree.plantAll(String...)',
    'Plant.COLOUR_GREEN',
    'Plant.KIND',
    'Plant.STAGE_SEED',
    'Plant.STAGE_WILTED',
    'Plant.count',
    'Plant.leaves',
    'Plant.name',
    'Plant.oldName',
    'Plant.getOldName()',
    'Plant.tag(String[])',
    'Plant.water(Number, Boolean)',
    'Object.toString()'
  ])
  assert.deepEqual(index.member(tree, 'getName').map((member) => member.owner), ['dw.garden.Tree'])
  assert.equal(index.member(tree, 'grow').length, 2)
  assert.equal(index.member(tree, 'water')[0].owner, 'dw.garden.Plant')
  assert.deepEqual(index.member(tree, 'nothing'), [])
})

test('a member’s signature, a constant’s value and deprecation', () => {
  const index = loadDwIndex(GARDEN)
  const tree = find(index, 'dw.garden.Tree')
  const plant = find(index, 'dw.garden.Plant')
  const one = (cls: DwClass, name: string) => signature(index.member(cls, name)[0])
  assert.equal(one(tree, 'water'), 'water(litres: Number, warm: Boolean): Boolean')
  assert.equal(one(tree, 'plantAll'), 'static plantAll(...names: String): List')
  assert.equal(one(tree, 'tag'), 'tag(labels: String[]): void')
  assert.equal(one(tree, 'count'), 'static count: Number (read-only)')
  assert.equal(one(tree, 'name'), 'name: String')
  assert.equal(one(tree, 'STAGE_SEED'), 'STAGE_SEED: Number = 0')
  assert.equal(one(tree, 'COLOUR_GREEN'), 'COLOUR_GREEN: String = "leaf_green"')
  assert.equal(one(tree, 'KIND'), 'KIND: Object')
  assert.equal(signature(index.member(tree, 'Tree')[2]), 'Tree(name: String, ...rings: Number)')
  assert.equal(one(find(index, 'GardenMgr'), 'harvest'), 'static harvest(plant: Plant, ...options: Object): BasketWO')

  assert.equal(index.constantValue(tree, 'COLOUR_GREEN'), 'leaf_green')
  assert.equal(index.constantValue(plant, 'STAGE_WILTED'), -1)
  assert.equal(index.constantValue(plant, 'KIND'), undefined)
  assert.equal(index.constantValue(plant, 'name'), undefined)

  assert.equal(index.isDeprecated(find(index, 'GardenMgr')), true)
  assert.equal(index.isDeprecated(plant), false)
  assert.equal(index.isDeprecated(tree, 'oldName'), true)
  assert.equal(index.isDeprecated(tree, 'STAGE_WILTED'), true)
  assert.equal(index.isDeprecated(tree, 'name'), false)
  // One variant of grow is deprecated, the other is not: the name as a whole is not.
  assert.equal(index.isDeprecated(tree, 'grow'), false)
  assert.equal(index.isDeprecated(tree, 'nothing'), false)
})

test('links go to the class page, at the member’s section', () => {
  const index = loadDwIndex(GARDEN)
  const tree = find(index, 'dw.garden.Tree')
  assert.equal(index.link(tree), 'https://docs.example.com/script-api/dw.garden.Tree.html')
  assert.equal(index.link(tree, index.member(tree, 'grow')[0]), 'https://docs.example.com/script-api/dw.garden.Tree.html#grownumber---variant-1')
  // An inherited member is on its owner's page.
  const water = index.member(tree, 'water')[0]
  assert.equal(index.link(find(index, water.owner), water), 'https://docs.example.com/script-api/dw.garden.Plant.html#waternumber-boolean')
  assert.equal(anchorOf('tag(String\\[])'), 'tagstring')
  assert.equal(anchorOf('COLOUR_GREEN'), 'colour_green')
})

test('the loader refuses what is not an index', () => {
  const broken = (change: (data: Record<string, any>) => void) => {
    const data = JSON.parse(JSON.stringify(GARDEN))
    change(data)
    return () => loadDwIndex(data)
  }
  assert.throws(() => loadDwIndex(null), /not an object/)
  assert.throws(() => loadDwIndex([]), /not an object/)
  assert.throws(broken((data) => (data.format = 2)), /format 2/)
  assert.throws(broken((data) => delete data.version), /version/)
  assert.throws(broken((data) => (data.classes['dw.garden.Tree'].super = 'dw.garden.Shrub')), /dw\.garden\.Tree\.super names dw\.garden\.Shrub/)
  assert.throws(broken((data) => (data.classes['dw.garden.Tree'].methods[0] = { params: [] })), /dw\.garden\.Tree\.methods\[0\]\.name/)
  assert.throws(broken((data) => (data.classes['dw.garden.Tree'].methods[0].params = 'none')), /params is not a list/)
  assert.throws(broken((data) => (data.classes.Tree = {})), /Tree is not a class id/)
})

test('a loop in the inheritance never hangs a query', () => {
  const data = JSON.parse(JSON.stringify(GARDEN))
  data.classes['dw.garden.Plant'].super = 'dw.garden.Tree'
  const index = loadDwIndex(data)
  const tree = find(index, 'dw.garden.Tree')
  assert.ok(index.members(tree).length > 0)
})

test('the committed index loads and answers a known class, method, inherited member and constant', () => {
  const index = loadDwIndex(COMMITTED)
  assert.match(index.version, /^\d+\.\d+$/)
  assert.match(index.generated, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(index.classes().length > 400, `${index.classes().length} classes`)

  const productMgr = find(index, 'dw/catalog/ProductMgr')
  assert.equal(index.findClass('dw.catalog.ProductMgr'), productMgr)
  const [getProduct] = index.member(productMgr, 'getProduct')
  assert.deepEqual(getProduct.params, [{ name: 'productID', type: 'TopLevel.String' }])
  assert.equal(getProduct.returns, 'dw.catalog.Product')
  assert.equal(signature(getProduct), 'static getProduct(productID: String): Product')
  assert.equal(index.link(productMgr, getProduct), 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/b2c-script-api/dw.catalog.ProductMgr.html#getproductstring')

  const order = find(index, 'dw.order.Order')
  assert.equal(order.super, 'dw.order.LineItemCtnr')
  assert.equal(index.member(order, 'getCustomerEmail')[0]?.owner, 'dw.order.LineItemCtnr')
  assert.equal(index.member(order, 'custom').find((member) => member.kind === 'property')?.owner, 'dw.object.ExtensibleObject')
  assert.equal(index.constantValue(order, 'ORDER_STATUS_NEW'), 3)
  assert.equal(index.isDeprecated(order, 'paymentTransaction'), true)
  assert.equal(index.isDeprecated(order, 'orderNo'), false)
  assert.equal(index.isDeprecated(find(index, 'dw.campaign.CampaignMgr')), true)
  assert.equal(find(index, 'String').id, 'TopLevel.String')
})

test('the committed index holds no description: only names, types, keys and constant values', () => {
  const identifier = /^[A-Za-z_$][\w$]*$/
  const type = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\[\])?$/
  const key = /^[A-Za-z_$][\w$]*\((?:[\w$]+(?:\[\]|\.\.\.)?(?:, [\w$]+(?:\[\]|\.\.\.)?)*)?\)(?: - Variant \d+)?$/
  let values = 0
  for (const [id, cls] of Object.entries(COMMITTED.classes)) {
    assert.match(id, type)
    for (const each of [cls.super, ...(cls.subclasses ?? [])]) if (each !== undefined) assert.match(each, type, id)
    for (const member of [...(cls.constants ?? []), ...(cls.properties ?? []), ...(cls.constructors ?? []), ...(cls.methods ?? [])]) {
      const where = `${id}.${member.name}`
      const allowed = new Set(['name', 'key', 'type', 'value', 'params', 'returns', 'static', 'readOnly', 'deprecated'])
      for (const field of Object.keys(member)) assert.ok(allowed.has(field), `${where}: ${field}`)
      assert.match(member.name, identifier, where)
      if ('type' in member) assert.match(member.type, type, where)
      if ('key' in member && member.key !== undefined) assert.match(member.key, key, where)
      if ('returns' in member && member.returns !== undefined) assert.match(member.returns, type, where)
      for (const param of ('params' in member ? member.params : []) ?? []) {
        assert.deepEqual(Object.keys(param).filter((field) => !['name', 'type', 'rest'].includes(field)), [], where)
        assert.match(param.name, identifier, where)
        assert.match(param.type, type, where)
      }
      if ('value' in member && typeof member.value === 'string') {
        values++
        // A constant's value is a fact of the interface (`RSA/ECB/PKCS1Padding`, `in stock`),
        // never a sentence.
        assert.ok(member.value.length <= 100 && member.value.split(' ').length <= 3, `${where}: ${member.value}`)
      }
    }
  }
  assert.ok(values > 100)
  // Nothing else in the file is text: the whole of it, read as words, has no sentence in it.
  assert.ok(!/[A-Za-z]+ [a-z]+ [a-z]+ [a-z]+/.test(JSON.stringify(COMMITTED)))
})
