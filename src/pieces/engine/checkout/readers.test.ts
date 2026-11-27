// The small readers of the checkout index on their own: XML, properties, site archives, metadata,
// the per-file facts, the file helpers, the disk adapter, and that the index's modules stay pure.
import { assert, test } from 'orca/testing'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diskFiles } from './disk'
import { lineAt, lineStarts, normalizePath, skippedPath, walkFiles } from './files'
import { MemoryFiles } from './memory'
import { parseMetadata } from './metadata'
import { parseProperties } from './properties'
import { scanScript, scanTemplate } from './scan'
import { parseSiteArchive, splitCartridgePath } from './sites'
import { decodeXml, scanXml } from './xml'

test('scanXml reads tags, attributes with their ranges, text, and steps over comments and CDATA; never throws', () => {
  const text = `<?xml version="1.0"?><!-- <a x="no"/> --><a b='1' c="&amp;x"><d/>text<![CDATA[<raw>]]></a>`
  const opened: string[] = []
  const texts: string[] = []
  scanXml(text, {
    open: (tag) => opened.push(`${tag.name}${tag.attributes.map((a) => ` ${a.name}=${a.value}@${text.slice(a.valueStart, a.valueEnd)}`).join('')}${tag.selfClosing ? '/' : ''}`),
    text: (start, end) => texts.push(text.slice(start, end))
  })
  assert.deepEqual(opened, ['a b=1@1 c=&x@&amp;x', 'd/'])
  assert.deepEqual(texts, ['text', '<raw>'])
  assert.equal(decodeXml('&lt;&#65;&#x42;&unknown;'), '<AB&unknown;')
  for (const broken of ['<', '<a', '<a b="', '<a b=', '</', '<!--', '<![CDATA[', '<a <b>', '<<<>>>', '<a b c d>']) scanXml(broken, { open() {}, close() {}, text() {} })
})

test('parseProperties: separators, comments, continuations, escapes, keys with their range and line', () => {
  const text = '# comment\n! comment too\nplain=value\n  spaced : value two\nwhite space\nescaped\\=key=v\ncontinued=a \\\n    b\n\nlast\\u0041=\\u00e9\r\ncr=1\rend=2'
  const keys = parseProperties(text)
  assert.deepEqual(
    keys.map(({ key, value, line }) => [key, value, line]),
    [
      ['plain', 'value', 3],
      ['spaced', 'value two', 4],
      ['white', 'space', 5],
      ['escaped=key', 'v', 6],
      ['continued', 'a b', 7],
      ['lastA', 'é', 10],
      ['cr', '1', 11],
      ['end', '2', 12]
    ]
  )
  const spaced = keys[1]
  assert.equal(text.slice(spaced.start, spaced.end), 'spaced')
})

test('parseSiteArchive: the site id and its custom cartridges, with their range; none without them', () => {
  const text = '<site site-id="Shop"><custom-cartridges> a : b::c </custom-cartridges></site>'
  const site = parseSiteArchive(text, 'sites/x/sites/Shop/site.xml')
  assert.deepEqual(site && { siteId: site.siteId, cartridges: site.cartridges, text: text.slice(site.start, site.end), line: site.line }, { siteId: 'Shop', cartridges: ['a', 'b', 'c'], text: ' a : b::c ', line: 1 })
  assert.equal(parseSiteArchive('<site site-id="Shop"><currency>EUR</currency></site>', 'x/sites/Shop/site.xml'), null)
  // No site-id: the folder's name.
  assert.equal(parseSiteArchive('<site><custom-cartridges>a</custom-cartridges></site>', 'x/sites/Folder/site.xml')?.siteId, 'Folder')
  assert.deepEqual(splitCartridgePath(''), [])
})

test('parseMetadata: only custom attribute definitions count, with their type; a broken file keeps what it read', () => {
  const text = [
    '<metadata>',
    '<type-extension type-id="Order">',
    '<system-attribute-definitions><attribute-definition attribute-id="status"><type>int</type></attribute-definition></system-attribute-definitions>',
    '<custom-attribute-definitions>',
    '<attribute-definition attribute-id="a"><type> string </type><value-definitions><value-definition><display xml:lang="x-default">x</display></value-definition></value-definitions></attribute-definition>',
    '<attribute-definition attribute-id="b"/>',
    '</custom-attribute-definitions>',
    '</type-extension>',
    '<type-extension type-id="Broken"><custom-attribute-definitions><attribute-definition attribute-id="c"><type>bool'
  ].join('\n')
  const types = parseMetadata(text, 'meta/x.xml')
  assert.deepEqual(
    types.map((type) => [type.typeId, type.attributes.map((a) => [a.id, a.type, a.line])]),
    [
      [
        'Order',
        [
          ['a', 'string', 5],
          ['b', null, 6]
        ]
      ],
      ['Broken', [['c', null, 9]]]
    ]
  )
})

test('scanScript and scanTemplate never throw and keep only what is literal', () => {
  const script = scanScript("var x = require(name); res.render(view); Resource.msg(key, 'b'); require('ok'); new Template('t/x');")
  assert.deepEqual(script.requires.map((r) => r.module), ['ok'])
  assert.deepEqual(script.templates.map((t) => [t.name, t.via]), [['t/x', 'Template']])
  assert.deepEqual(script.resources, [])
  const isml = scanTemplate('<isinclude template="${dynamic}"/><isinclude template="a/b"/><ismodule template="c/d" name="x"/>${ISML.renderTemplate("e/f")}')
  assert.deepEqual(isml.templates.map((t) => [t.name, t.via]), [['a/b', 'isinclude'], ['c/d', 'ismodule'], ['e/f', 'renderTemplate']])
  const huge = scanScript('x'.repeat(2_000_001))
  assert.ok(huge.skipped)
  const brokenInputs = ['server.get(', "server.append('x'", 'module.exports = server.exports(', '}}}{{{', 'require(`']
  for (const broken of brokenInputs) scanScript(broken, { controller: true })
})

test('a controller’s routes are read only off a name bound to require(“server”)', () => {
  const facts = scanScript(
    [
      "var srv = require('server');",
      "var other = { get: function () {} };",
      "other.get('NotARoute', function () {});",
      "srv.get('Show', a, b, function () {});",
      'srv.extend(module.superModule);',
      'module.exports = srv.exports();'
    ].join('\n'),
    { controller: true }
  )
  assert.deepEqual(
    facts.controller?.operations.map((o) => [o.method, o.name, o.middleware, o.line]),
    [['get', 'Show', 3, 4]]
  )
  assert.deepEqual(facts.controller?.extends, { kind: 'superModule' })
  assert.equal(facts.controller?.exported, true)
  const explicit = scanScript("var server = require('server');\nvar base = require('app_x/cartridge/controllers/Page');\nserver.extend(base);\n", { controller: true })
  assert.deepEqual(explicit.controller?.extends, { kind: 'require', module: 'app_x/cartridge/controllers/Page' })
  assert.equal(explicit.controller?.exported, false)
})

test('the file helpers: plain paths, skipped folders, lines', async () => {
  assert.equal(normalizePath('a\\b/./c/../d'), 'a/b/d')
  assert.equal(normalizePath('../x'), null)
  assert.equal(normalizePath('/x'), null)
  assert.equal(normalizePath('C:/x'), null)
  assert.ok(skippedPath('node_modules/x.js'))
  assert.ok(skippedPath('a/.git/HEAD'))
  assert.ok(skippedPath('.orca/shots/x.png'))
  assert.ok(!skippedPath('cartridges/a/.project'))
  const starts = lineStarts('a\r\nb\rc\nd')
  assert.deepEqual([0, 3, 5, 7].map((offset) => lineAt(starts, offset)), [1, 2, 3, 4])
  const memory = new MemoryFiles({ 'a/b.txt': '', 'node_modules/x/y.js': '', '.git/HEAD': '', 'c.txt': '' })
  assert.deepEqual((await walkFiles(memory)).files, ['a/b.txt', 'c.txt'])
})

test('the disk adapter reads inside the workspace only and follows no link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-checkout-'))
  try {
    mkdirSync(join(root, 'cartridges', 'a', 'cartridge'), { recursive: true })
    writeFileSync(join(root, 'cartridges', 'a', '.project'), '<projectDescription/>')
    writeFileSync(join(root, 'cartridges', 'a', 'cartridge', 'x.js'), "require('y');")
    writeFileSync(join(root, 'outside.txt'), 'outside')
    let linked = false
    try {
      symlinkSync(join(root, 'cartridges'), join(root, 'loop'), 'junction')
      linked = true
    } catch {
      // Links may need rights the test machine lacks.
    }
    const files = diskFiles(join(root, 'cartridges'))
    assert.deepEqual((await walkFiles(files)).files, ['a/.project', 'a/cartridge/x.js'])
    assert.equal(await files.read('a/cartridge/x.js'), "require('y');")
    assert.ok(typeof (await files.time('a/cartridge/x.js')) === 'number')
    assert.equal(await files.read('../outside.txt'), null)
    assert.equal(await files.time('a/cartridge'), null)
    assert.equal(await files.list('a/cartridge/x.js'), null)
    if (linked) assert.ok(!(await diskFiles(root).list(''))?.some((entry) => entry.name === 'loop'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the checkout modules that the editor may load import nothing but each other and the syntax layer: no Node, no Orca', () => {
  const here = fileURLToPath(new URL('./', import.meta.url))
  const workerOnly = new Set(['disk.ts', 'git.ts', 'testing.ts'])
  const modules = readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !workerOnly.has(name))
  assert.ok(modules.length >= 7, modules.join(', '))
  for (const module of modules) {
    const source = readFileSync(join(here, module), 'utf8')
    const imports = [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const specifier of imports) {
      assert.ok(specifier.startsWith('./') || /^\.\.\/(js|isml)\//.test(specifier), `${module} imports ${specifier}`)
    }
    assert.ok(!/\brequire\(|process\.|globalThis\.orca/.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")), `${module} uses a runtime global`)
  }
})

test('scan: what a script exports, each member with its place, parameters and JSDoc; what it builds on and re-exports', () => {
  const text = [
    "'use strict';",
    "var base = require('*/cartridge/scripts/helpers/base');",
    '/**',
    ' * Waters a plant.',
    ' * @param {number} litres - how much',
    ' */',
    'function water(litres, warm) {}',
    'var rest = function (first, ...others) {};',
    'module.exports = Object.assign({}, base, {',
    '    water: water,',
    '    rest: rest,',
    '    /** A count. */',
    '    count: 3',
    '});'
  ].join('\n')
  const exports = scanScript(text).exports
  assert.deepEqual(
    exports.members.map((member) => [member.name, member.kind, member.params, member.line, member.definition?.line ?? null, member.doc]),
    [
      ['water', 'function', ['litres', 'warm'], 10, 7, 'Waters a plant.\n@param {number} litres - how much'],
      ['rest', 'function', ['first', '...others'], 11, 8, null],
      ['count', 'value', null, 13, null, 'A count.']
    ]
  )
  assert.deepEqual([exports.value, exports.place?.line, exports.extendsSuper, exports.reexports], ['assign', 9, false, ['*/cartridge/scripts/helpers/base']])
  // A model's constructor, a module re-exported whole, a member read off one (not a re-export).
  const model = scanScript('/** A garden model. */\nfunction Garden(apiGarden, options) {}\nmodule.exports = Garden;').exports
  assert.deepEqual([model.value, model.params, model.doc], ['function', ['apiGarden', 'options'], 'A garden model.'])
  assert.deepEqual(scanScript("module.exports = require('*/cartridge/scripts/x');").exports.reexports, ['*/cartridge/scripts/x'])
  assert.deepEqual(scanScript("module.exports = require('*/cartridge/scripts/x').y;").exports.reexports, [])
  // A copy that extends module.superModule.
  const extended = scanScript('var base = module.superModule;\nbase.first = function (list) {};\nmodule.exports = base;').exports
  assert.deepEqual([extended.extendsSuper, extended.members.map((member) => member.name)], [true, ['first']])
  // A name exported twice keeps its last.
  assert.deepEqual(scanScript('exports.a = 1;\nexports.a = function (x) {};').exports.members.map((member) => [member.name, member.kind, member.line]), [['a', 'function', 2]])
  assert.deepEqual(scanScript('var x = 1;').exports, { members: [], value: null, place: null, params: null, doc: null, extendsSuper: false, reexports: [] })
})

test('scan: the custom tags a template’s <ismodule> declares, with their attributes and line', () => {
  const facts = scanTemplate('<iscomment>tags</iscomment>\n<ismodule template="components/badge" name="badge" attribute="label" attribute="tone" />\n')
  assert.deepEqual(facts.modules.map(({ name, template, attributes, line }) => ({ name, template, attributes, line })), [{ name: 'badge', template: 'components/badge', attributes: ['label', 'tone'], line: 2 }])
  assert.deepEqual(scanTemplate('<div></div>').modules, [])
})

test('scan: the members of modules a file reads, through a name, a require, a pattern and module.superModule', () => {
  const text = [
    "var helper = require('*/cartridge/scripts/helper');",
    "var { price, label: name } = require('*/cartridge/scripts/prices');",
    'var base = module.superModule;',
    'helper.total(price(1), name);',
    "require('~/cartridge/scripts/x').run();",
    'base.extra = module.superModule.first;',
    'var other = {};',
    'other.total();',
    "helper['computed']();"
  ].join('\n')
  const uses = scanScript(text).members
  assert.deepEqual(
    uses.map((use) => [use.module, use.member, text.slice(use.start, use.end), use.line]),
    [
      ['*/cartridge/scripts/helper', 'total', 'total', 4],
      ['*/cartridge/scripts/prices', 'price', 'price', 4],
      ['*/cartridge/scripts/prices', 'label', 'name', 4],
      ['~/cartridge/scripts/x', 'run', 'run', 5],
      ['module.superModule', 'extra', 'extra', 6],
      ['module.superModule', 'first', 'first', 6]
    ]
  )
  // In a template's JavaScript too.
  const template = "<isscript>var helper = require('*/cartridge/scripts/helper');</isscript>\n<span>${helper.total()}</span>"
  assert.deepEqual(scanTemplate(template).members.map((use) => [use.member, use.line]), [['total', 2]])
})
