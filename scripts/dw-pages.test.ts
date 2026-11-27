// The page parser on invented pages shaped like the Script API's (src/pieces/engine/fixtures/dw):
// each turns into the expected entry with no description, and a page of another shape fails
// with its class and section.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { PageShapeError, parseClassPage, versionOf } from './dw-pages'

const FIXTURES = new URL('../src/pieces/engine/fixtures/dw/', import.meta.url)
const page = (id: string) => readFileSync(new URL(`${id}.md`, FIXTURES), 'utf8')

const S = 'TopLevel.String'
const N = 'TopLevel.Number'

test('the root class: no superclass, a constructor and a method', () => {
  assert.deepEqual(parseClassPage('TopLevel.Object', page('TopLevel.Object')), {
    constructors: [{ name: 'Object', params: [] }],
    methods: [{ name: 'toString', params: [], returns: S }]
  })
})

test('a base class: constants with and without a value, properties, methods and subclasses', () => {
  assert.deepEqual(parseClassPage('dw.garden.Plant', page('dw.garden.Plant')), {
    super: 'TopLevel.Object',
    subclasses: ['dw.garden.Tree'],
    constants: [
      { name: 'COLOUR_GREEN', type: S, value: 'leaf_green' },
      { name: 'KIND', type: 'TopLevel.Object' },
      { name: 'STAGE_SEED', type: N, value: 0 },
      { name: 'STAGE_WILTED', type: N, value: -1, deprecated: true }
    ],
    properties: [
      { name: 'count', type: N, static: true, readOnly: true },
      { name: 'leaves', type: 'dw.util.Collection', readOnly: true },
      { name: 'name', type: S },
      { name: 'oldName', type: S, readOnly: true, deprecated: true }
    ],
    methods: [
      { name: 'getName', params: [], returns: S },
      { name: 'getOldName', params: [], returns: S, deprecated: true },
      { name: 'tag', params: [{ name: 'labels', type: 'TopLevel.String[]' }], returns: 'void' },
      { name: 'water', params: [{ name: 'litres', type: N }, { name: 'warm', type: 'TopLevel.Boolean' }], returns: 'TopLevel.Boolean' }
    ]
  })
})

test('a subclass: its chain, constructor overloads, a rest parameter and two variants of one method', () => {
  assert.deepEqual(parseClassPage('dw.garden.Tree', page('dw.garden.Tree')), {
    super: 'dw.garden.Plant',
    properties: [{ name: 'height', type: N }],
    constructors: [
      { name: 'Tree', params: [] },
      { name: 'Tree', params: [{ name: 'name', type: S }] },
      { name: 'Tree', params: [{ name: 'name', type: S }, { name: 'rings', type: N, rest: true }] }
    ],
    methods: [
      { name: 'getName', params: [], returns: S },
      { name: 'grow', key: 'grow(Number) - Variant 1', params: [{ name: 'metres', type: N }], returns: 'void' },
      { name: 'grow', key: 'grow(Number) - Variant 2', params: [{ name: 'centimetres', type: N }], returns: 'void', deprecated: true },
      { name: 'plantAll', params: [{ name: 'names', type: S, rest: true }], returns: 'dw.util.List', static: true }
    ]
  })
})

test('a deprecated class with no constructor, static methods and a type the documentation does not link', () => {
  assert.deepEqual(parseClassPage('dw.garden.GardenMgr', page('dw.garden.GardenMgr')), {
    super: 'TopLevel.Object',
    deprecated: true,
    constants: [{ name: 'MAX_BEDS', type: N, value: 12 }],
    methods: [
      { name: 'findPlant', params: [{ name: 'name', type: S }], returns: 'dw.garden.Plant', static: true },
      { name: 'harvest', params: [{ name: 'plant', type: 'dw.garden.Plant' }, { name: 'options', type: 'TopLevel.Object', rest: true }], returns: 'BasketWO', static: true }
    ]
  })
})

test('no text of a description reaches an entry', () => {
  for (const id of ['TopLevel.Object', 'dw.garden.Plant', 'dw.garden.Tree', 'dw.garden.GardenMgr']) {
    const markdown = page(id)
    const entry = JSON.stringify(parseClassPage(id, markdown))
    // Every description line of the page: the member's own (`  - : …`) and what follows it.
    const prose = markdown.split('\n').filter((line) => / [a-z]+ [a-z]+ /.test(line) && !line.startsWith('|') && !line.startsWith('#'))
    assert.ok(prose.length > 3, `${id} has descriptions to leave out`)
    for (const line of prose) {
      for (const words of line.match(/[A-Za-z]+(?: [A-Za-z]+){2,}/g) ?? []) assert.ok(!entry.includes(words), `${id}: "${words}" reached the entry`)
    }
    assert.ok(!/ [a-z]+ [a-z]+ /.test(entry), `${id}: no phrase at all`)
  }
})

test('Windows line ends read the same', () => {
  const plant = page('dw.garden.Plant')
  assert.deepEqual(parseClassPage('dw.garden.Plant', plant.replace(/\n/g, '\r\n')), parseClassPage('dw.garden.Plant', plant))
})

/** The page of `id` with `from` replaced by `to`; the fixture must hold `from`. */
function changed(id: string, from: string, to: string): string {
  const markdown = page(id)
  assert.ok(markdown.includes(from), `the fixture holds ${JSON.stringify(from)}`)
  return markdown.replace(from, to)
}

function fails(id: string, markdown: string, section: string | RegExp): void {
  assert.throws(
    () => parseClassPage(id, markdown),
    (error: unknown) => {
      assert.ok(error instanceof PageShapeError, String(error))
      assert.equal(error.page, id)
      if (typeof section === 'string') assert.equal(error.section, section)
      else assert.match(error.section, section)
      assert.ok(error.message.startsWith(`${id}, `), error.message)
      return true
    }
  )
}

test('a page of an unexpected shape fails with its class and its section', () => {
  const tree = 'dw.garden.Tree'
  // The title names another class.
  fails(tree, changed(tree, '# Class Tree', '# Class Shrub'), 'title')
  // No inheritance list, a list that does not end with the class, or a step of the wrong depth.
  fails(tree, changed(tree, '- [TopLevel.Object](/script-api/TopLevel.Object.md)\n  - [dw.garden.Plant](/script-api/dw.garden.Plant.md)\n    - [dw.garden.Tree](/script-api/dw.garden.Tree.md)\n', ''), 'inheritance')
  fails(tree, changed(tree, '    - [dw.garden.Tree](/script-api/dw.garden.Tree.md)\n', ''), 'inheritance')
  fails(tree, changed(tree, '    - [dw.garden.Tree]', '      - [dw.garden.Tree]'), 'inheritance')
  // A section the parser does not know, or one it needs that is missing.
  fails(tree, changed(tree, '## Property Summary', '## Event Summary'), 'Event Summary')
  fails(tree, changed(tree, '## Method Summary\n', ''), 'Method Summary')
  // A member line that is not one: a missing type, a value on a property, an unclosed list.
  fails(tree, changed(tree, '- height: [Number](/script-api/TopLevel.Number.md)', '- height'), 'Property Details > height')
  fails(tree, changed(tree, '- height: [Number](/script-api/TopLevel.Number.md)', '- height: [Number](/script-api/TopLevel.Number.md) = 3'), 'Property Details > height')
  fails(tree, changed(tree, '- getName(): [String](/script-api/TopLevel.String.md)\n  - : Returns the name carved', '- getName(: [String](/script-api/TopLevel.String.md)\n  - : Returns the name carved'), 'Method Details > getName()')
  // A method with no return type, a type whose link names another class, a heading that
  // disagrees with its line, and a constructor named after another class.
  fails(tree, changed(tree, '- getName(): [String](/script-api/TopLevel.String.md)\n  - : Returns the name carved', '- getName()\n  - : Returns the name carved'), 'Method Details > getName()')
  fails(tree, changed(tree, '- height: [Number](/script-api/TopLevel.Number.md)', '- height: [Number](/script-api/TopLevel.String.md)'), 'Property Details > height')
  fails(tree, changed(tree, '### plantAll(String...)', '### plantAll(Number...)'), 'Method Details > plantAll(Number...)')
  fails(tree, changed(tree, '- Tree()\n', '- Bush()\n'), 'Constructor Details > Tree()')
  // A heading with no member line under it, or a section no summary link reaches.
  fails(tree, changed(tree, '- height: [Number](/script-api/TopLevel.Number.md)\n', 'height, in metres\n'), 'Property Details > height')
  fails(tree, changed(tree, '[height](#height)', '[height](#tallness)'), 'Property Details > height')
  // A summary that lists another number of members than the details hold.
  fails(tree, changed(tree, '| [height](#height)', '| [width](#height): [Number](/script-api/TopLevel.Number.md) | The width. |\n| [height](#height)'), 'Property Details')
  // A constant whose value is neither a text nor a whole number.
  const plant = 'dw.garden.Plant'
  fails(plant, changed(plant, '- STAGE_SEED: [Number](/script-api/TopLevel.Number.md) = 0', '- STAGE_SEED: [Number](/script-api/TopLevel.Number.md) = 0.5'), 'Constant Details > STAGE_SEED')
  // A subclass list holding something other than links.
  fails(plant, changed(plant, '[Tree](/script-api/dw.garden.Tree.md)\n', 'Tree, and others\n'), 'All Known Subclasses')
})

test('the version is read from the title of the documentation’s index', () => {
  assert.equal(versionOf('B2C Commerce Script API 26.10'), '26.10')
  assert.equal(versionOf('B2C Commerce Script API 99.1.2'), '99.1.2')
  assert.throws(() => versionOf('Script API'), /unexpected title/)
  assert.throws(() => versionOf('B2C Commerce Script API latest'), /unexpected title/)
})
