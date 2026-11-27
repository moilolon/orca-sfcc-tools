// The findings of the review of the checkout index, each with the sample that showed it: metadata
// merged from the checkout and the ref, queries during a rebuild, a cartridge whose `.project`
// comes in an earlier batch than its files, bundle names, SFRA's refusals, and the git reader on a
// workspace below its repository's root and on a file the commit lacks.
import { assert, test } from 'orca/testing'
import { EventEmitter } from 'node:events'
import { CheckoutIndex, GitError, type CheckoutOptions } from './checkout'
import type { CheckoutFiles } from './files'
import { createGitReader, type GitChild, type GitSpawnOptions } from './git'
import { MemoryFiles } from './memory'
import { fixtureFiles, FakeRef } from './testing'

const CORE = 'cartridges/app_garden_core'
const BASE = 'cartridges/app_garden_base'
const COMMIT = 'd'.repeat(40)

async function built(files: CheckoutFiles, options: CheckoutOptions = {}): Promise<CheckoutIndex> {
  const index = new CheckoutIndex(files, options)
  await index.build()
  return index
}

const attribute = (id: string, type: string) => `<attribute-definition attribute-id="${id}"><type>${type}</type></attribute-definition>`
const extension = (typeId: string, ...attributes: string[]) => `<type-extension type-id="${typeId}"><custom-attribute-definitions>${attributes.join('')}</custom-attribute-definitions></type-extension>`
const metadata = (...extensions: string[]) => `<metadata>${extensions.join('')}</metadata>\n`

test('1. metadata: one file in the checkout no longer hides the ref’s; the checkout wins per attribute, each says its source', async () => {
  const files = new MemoryFiles({
    'cartridges/app_a/.project': '<projectDescription/>',
    'cartridges/app_a/cartridge/scripts/a.js': 'module.exports = {};',
    // A delta of one ticket: one new attribute, and one the ref also defines, with another type.
    'metadata/TICKET-1/meta/system-objecttype-extensions.xml': metadata(extension('Product', attribute('newOne', 'string'), attribute('color', 'enum-of-string')))
  })
  const ref = new FakeRef(
    { main: COMMIT },
    {
      [COMMIT]: {
        'sites/site_template/meta/system-objecttype-extensions.xml': metadata(
          extension('Product', attribute('color', 'string'), attribute('size', 'string'), attribute('season', 'string')),
          extension('SitePreferences', attribute('gardenCurrency', 'string'))
        ),
        'sites/site_template/meta/custom-objecttype-definitions.xml': '<metadata><custom-type type-id="Wish"><attribute-definitions>' + attribute('items', 'set-of-string') + '</attribute-definitions></custom-type></metadata>'
      }
    }
  )
  const index = await built(files, { metadataRef: 'main', git: ref })
  assert.deepEqual(
    index.attributes('Product').map(({ id, type, source }) => [id, type, source]),
    [
      ['newOne', 'string', 'checkout'],
      ['color', 'enum-of-string', 'checkout'],
      ['size', 'string', 'git-ref'],
      ['season', 'string', 'git-ref']
    ]
  )
  assert.deepEqual(
    index.sitePreferences().map(({ id, source }) => [id, source]),
    [['gardenCurrency', 'git-ref']]
  )
  assert.deepEqual(index.attributes('Wish').map((a) => a.id), ['items'])
  assert.equal(index.status().metadataSource, 'both')
  // Without the ref, only the checkout's.
  const alone = await built(files)
  assert.equal(alone.status().metadataSource, 'checkout')
  assert.deepEqual(alone.attributes('Product').map((a) => a.id), ['newOne', 'color'])
})

/** A disk whose time() waits for the test to let it go, so a query can land mid-rebuild. */
function gated(inner: CheckoutFiles) {
  let gate: Promise<void> | null = null
  let open: () => void = () => {}
  let waiting = 0
  return {
    close() {
      gate = new Promise((resolve) => (open = resolve))
    },
    open: () => open(),
    waiting: () => waiting,
    files: {
      list: (dir: string) => inner.list(dir),
      read: (path: string) => inner.read(path),
      async time(path: string) {
        if (gate) {
          waiting++
          await gate
        }
        return inner.time(path)
      }
    } satisfies CheckoutFiles
  }
}

test('2. a query during a rebuild answers from the last complete index; the new one is swapped in whole', async () => {
  const disk = gated(fixtureFiles())
  const index = await built(disk.files)
  const model = `${CORE}/cartridge/models/product.js`
  const before = JSON.stringify(index.superModule(model))
  assert.ok(index.superModule(model).copies.every((copy) => copy.onPath && copy.path === `${BASE}/cartridge/models/product.js`))
  const statusBefore = JSON.stringify(index.status())
  disk.close()
  const rebuild = index.build()
  // Let the rebuild run until it waits on the disk.
  for (let i = 0; i < 50 && disk.waiting() === 0; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(disk.waiting() > 0, 'the rebuild is in flight')
  assert.equal(JSON.stringify(index.superModule(model)), before)
  assert.equal(index.cartridges().length, 4)
  assert.equal(index.route('Product-Show')?.storefronts[0].steps.length, 4)
  assert.equal(JSON.stringify(index.status()), statusBefore)
  disk.open()
  await rebuild
  assert.equal(JSON.stringify(index.superModule(model)), before)
})

test('2. an update in flight leaves the queries on the last complete index too', async () => {
  const files = fixtureFiles()
  const disk = gated(files)
  const index = await built(disk.files)
  files.delete(`${CORE}/cartridge/scripts/helpers/priceHelper.js`)
  disk.close()
  const update = index.update([`${CORE}/cartridge/scripts/helpers/priceHelper.js`])
  for (let i = 0; i < 50 && disk.waiting() === 0; i++) await new Promise((resolve) => setImmediate(resolve))
  const star = () => {
    const resolved = index.resolveModule(`${BASE}/cartridge/controllers/Product.js`, '*/cartridge/scripts/helpers/priceHelper')
    return resolved.kind === 'path' ? resolved.copies.map((copy) => copy.path) : []
  }
  assert.deepEqual(star(), [`${CORE}/cartridge/scripts/helpers/priceHelper.js`, `${CORE}/cartridge/scripts/helpers/priceHelper.js`])
  disk.open()
  await update
  assert.deepEqual(star(), [`${BASE}/cartridge/scripts/helpers/priceHelper.js`, `${BASE}/cartridge/scripts/helpers/priceHelper.js`])
})

test('3. a cartridge whose .project comes in an earlier batch than its files is recognised, as a fresh build would', async () => {
  const files = new MemoryFiles({
    'c/app_a/.project': '<projectDescription/>',
    'c/app_a/cartridge/scripts/x.js': "require('*/cartridge/scripts/y');",
    'sites/s/sites/Site/site.xml': '<site site-id="Site"><custom-cartridges>app_a:app_new</custom-cartridges></site>'
  })
  const index = await built(files)
  assert.deepEqual(index.storefronts()[0].missing, ['app_new'])
  // Batch 1: the .project alone (a wizard writes it first).
  files.set('c/app_new/.project', '<projectDescription/>', 2)
  await index.update(['c/app_new/.project'])
  // Batch 2: the cartridge's files.
  files.set('c/app_new/cartridge/scripts/y.js', 'module.exports = {};', 3)
  await index.update(['c/app_new/cartridge/scripts/y.js'])
  assert.deepEqual(index.cartridges().map((c) => c.name), ['app_a', 'app_new'])
  assert.deepEqual(index.storefronts()[0].missing, [])
  const resolved = index.resolveModule('c/app_a/cartridge/scripts/x.js', '*/cartridge/scripts/y')
  assert.ok(resolved.kind === 'path')
  assert.deepEqual(resolved.copies, [{ storefront: 'Site', path: 'c/app_new/cartridge/scripts/y.js' }])
  assert.equal(index.status().counts.requiresUnresolved, 0)
  // The same as a fresh build of the same files.
  const fresh = await built(files)
  assert.deepEqual(fresh.cartridges(), index.cartridges())
  assert.deepEqual(fresh.status().counts, index.status().counts)
  // And the other way: the cartridge/ folder first, the .project later.
  const other = new MemoryFiles({ 'c/app_a/.project': '<projectDescription/>', 'c/app_a/cartridge/scripts/x.js': '' })
  const late = await built(other)
  other.set('c/app_b/cartridge/scripts/z.js', '', 2)
  await late.update(['c/app_b/cartridge/scripts/z.js'])
  assert.deepEqual(late.cartridges().map((c) => c.name), ['app_a'])
  other.set('c/app_b/.project', '<projectDescription/>', 3)
  await late.update(['c/app_b/.project'])
  assert.deepEqual(late.cartridges().map((c) => c.name), ['app_a', 'app_b'])
  assert.ok(late.fileFacts('c/app_b/cartridge/scripts/z.js'))
})

test('4. a bundle whose name extends another’s is another bundle, not one of its locales', async () => {
  const files = new MemoryFiles({
    'c/app_a/.project': '<projectDescription/>',
    'c/app_a/cartridge/templates/resources/garden.properties': 'title=Garden\n',
    'c/app_a/cartridge/templates/resources/garden_fr.properties': 'title=Jardin\n',
    'c/app_a/cartridge/templates/resources/garden_fr_BE.properties': 'title=Jardin belge\n',
    'c/app_a/cartridge/templates/resources/garden_tile.properties': 'tile.only=Tile\n',
    'c/app_a/cartridge/templates/resources/garden_xx_yy.properties': 'odd=1\n'
  })
  const index = await built(files, { cartridgePath: 'app_a' })
  assert.deepEqual(
    index
      .resourceKeys('garden')
      .map((key) => `${key.bundle}:${key.key}`)
      .sort(),
    ['garden:title', 'garden_fr:title', 'garden_fr_BE:title']
  )
  assert.deepEqual(index.resolveResource('tile.only', 'garden').candidates, [])
  assert.equal(index.resolveResource('tile.only', 'garden').copies[0].key, null)
  assert.equal(index.resolveResource('tile.only', 'garden_tile').copies[0].key?.value, 'Tile')
  assert.equal(index.resolveResource('title', 'garden', 'fr_BE').copies[0].key?.value, 'Jardin belge')
})

test('4. SFRA refuses replace on a missing route and a second declaration of a name: problems, not applied', async () => {
  const files = fixtureFiles()
  files.set(
    `${CORE}/cartridge/controllers/Product.js`,
    [
      "var server = require('server');",
      'server.extend(module.superModule);',
      "server.replace('Nope', function () {});",
      "server.get('Tile', function () {});",
      "server.replace('Show', function () {});",
      'module.exports = server.exports();'
    ].join('\n'),
    2
  )
  const index = await built(files)
  const shop = (id: string) => index.route(id)?.storefronts.find((chain) => chain.storefront === 'GardenShop')
  const nope = shop('Product-Nope')
  assert.deepEqual(nope?.steps, [])
  assert.deepEqual(nope?.problems.map((p) => p.code), ['route_missing'])
  assert.ok(!index.routeIds('GardenShop').includes('Product-Nope'))
  const tile = shop('Product-Tile')
  assert.deepEqual(tile?.problems.map((p) => p.code), ['route_redefined'])
  assert.deepEqual(tile?.steps.map((step) => `${step.method}@${step.cartridge}`), ['get@app_garden_base'])
  // A replace of a route that exists is applied.
  assert.deepEqual(shop('Product-Show')?.steps.map((step) => `${step.method}@${step.cartridge}`), ['replace@app_garden_core'])
})

class FakeGitChild extends EventEmitter implements GitChild {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  kill(): boolean {
    return true
  }
  finish(code: number, stdout = ''): void {
    queueMicrotask(() => {
      if (stdout) this.stdout.emit('data', new TextEncoder().encode(stdout))
      this.emit('close', code)
    })
  }
}

function git(answer: (args: readonly string[]) => { code: number; stdout?: string }) {
  const calls: { args: readonly string[]; options: GitSpawnOptions }[] = []
  const reader = createGitReader('C:\\repo\\shop', {
    platform: 'win32',
    env: { PATH: 'C:\\git' },
    isFile: async (path) => path === 'C:\\git\\git.exe',
    spawn: (_file, args, options) => {
      calls.push({ args, options })
      const child = new FakeGitChild()
      const { code, stdout } = answer(args)
      child.finish(code, stdout)
      return child
    }
  })
  return { reader, calls }
}

test('4. the git reader lists from the repository’s root, as show takes paths, whatever folder of it the workspace is', async () => {
  const { reader, calls } = git(() => ({ code: 0, stdout: 'sites/x/sites/Shop/site.xml\n' }))
  assert.deepEqual(await reader.list(COMMIT, ''), ['sites/x/sites/Shop/site.xml'])
  assert.deepEqual(calls[0].args, ['ls-tree', '--full-tree', '-r', '--name-only', COMMIT, '--', '.'])
  assert.equal(calls[0].options.env.GIT_NO_LAZY_FETCH, '1')
})

test('4. read() answers null for a file the commit does not have, and fails only when git does', async () => {
  const { reader, calls } = git((args) => {
    if (args[0] === 'show') return { code: 128 }
    if (args[0] === 'ls-tree' && args[6] === 'listed/but/broken.xml') return { code: 0, stdout: 'listed/but/broken.xml\n' }
    return { code: 0, stdout: '' }
  })
  assert.equal(await reader.read(COMMIT, 'no/such.xml'), null)
  assert.deepEqual(calls.map((call) => call.args[0]), ['show', 'ls-tree'])
  await assert.rejects(reader.read(COMMIT, 'listed/but/broken.xml'), (error: unknown) => (error as { code?: string }).code === 'git_failed')
})

test('4. a file listed and gone before it is read no longer fails the whole ref', async () => {
  const files = new MemoryFiles({ 'c/app_a/.project': '<projectDescription/>', 'c/app_a/cartridge/scripts/a.js': '' })
  const ref = new FakeRef({ main: COMMIT }, { [COMMIT]: { 'sites/x/sites/Shop/site.xml': '<site site-id="Shop"><custom-cartridges>app_a</custom-cartridges></site>' } })
  // list() names a file read() then does not find.
  const listing = ref.list.bind(ref)
  ref.list = async (commit: string, path: string) => [...(await listing(commit, path)), 'sites/x/meta/gone.xml']
  const index = await built(files, { metadataRef: 'main', git: ref })
  assert.equal(index.status().gitError, null)
  assert.deepEqual(index.storefronts().map((s) => [s.id, s.source]), [['Shop', 'git-ref']])
})

test('4. refreshRef asks only which commit the ref names, and reads again only when it moved', async () => {
  const files = new MemoryFiles({ 'c/app_a/.project': '<projectDescription/>', 'c/app_a/cartridge/scripts/a.js': '' })
  const ref = new FakeRef({ main: COMMIT }, { [COMMIT]: { 'sites/x/sites/Shop/site.xml': '<site site-id="Shop"><custom-cartridges>app_a</custom-cartridges></site>' } })
  const index = await built(files, { metadataRef: 'main', git: ref })
  const reads = ref.calls.length
  await index.refreshRef()
  assert.deepEqual(ref.calls.slice(reads), ['commit main'])
  const moved = 'e'.repeat(40)
  ref.commits.main = moved
  ref.trees[moved] = { 'sites/x/sites/Shop/site.xml': '<site site-id="Shop"><custom-cartridges>app_a:app_b</custom-cartridges></site>' }
  await index.refreshRef()
  assert.deepEqual(index.storefronts()[0].cartridges, ['app_a', 'app_b'])
  // Without the setting, git is never asked.
  const quiet = new FakeRef({}, {})
  const none = await built(files, { git: quiet })
  await none.refreshRef()
  assert.deepEqual(quiet.calls, [])
})

test('5. a failed check of the ref keeps the last good paths and metadata; only a successful read replaces them', async () => {
  const files = new MemoryFiles({ 'c/app_a/.project': '<projectDescription/>', 'c/app_a/cartridge/scripts/a.js': '' })
  const tree = {
    'sites/x/sites/Shop/site.xml': '<site site-id="Shop"><custom-cartridges>app_a</custom-cartridges></site>',
    'sites/x/meta/system-objecttype-extensions.xml': metadata(extension('Product', attribute('gardenColour', 'string')))
  }
  const ref = new FakeRef({ main: COMMIT }, { [COMMIT]: tree })
  const index = await built(files, { metadataRef: 'main', git: ref })
  const good = () => {
    assert.deepEqual(index.storefronts().map((s) => [s.id, s.cartridges, s.source]), [['Shop', ['app_a'], 'git-ref']])
    assert.deepEqual(index.attributes('Product').map((a) => [a.id, a.source]), [['gardenColour', 'git-ref']])
  }
  good()
  // One check fails (git busy, a timeout): the paths and the metadata stay, the code says why.
  ref.failure = new GitError('git_timeout')
  await index.refreshRef()
  good()
  assert.equal(index.status().gitError, 'git_timeout')
  assert.equal(index.status().pathSource, 'git-ref')
  assert.equal(index.status().metadataSource, 'git-ref')
  // A rebuild of the paths while git still fails (a saved site archive, a setting) keeps them too.
  await index.configure({ cartridgePath: '' })
  good()
  // The ref no longer names a commit: a failed read as well, the last good state stays.
  ref.failure = null
  ref.commits = {}
  await index.refreshRef()
  good()
  assert.equal(index.status().gitError, 'ref_not_found')
  // A successful read replaces them, and clears the code.
  const moved = 'e'.repeat(40)
  ref.commits = { main: moved }
  ref.trees[moved] = { 'sites/x/sites/Shop/site.xml': '<site site-id="Shop"><custom-cartridges>app_a:app_b</custom-cartridges></site>' }
  await index.refreshRef()
  assert.deepEqual(index.storefronts()[0].cartridges, ['app_a', 'app_b'])
  assert.deepEqual(index.attributes('Product'), [])
  assert.equal(index.status().gitError, null)
  // Another ref that fails gives nothing of the old one.
  ref.failure = new GitError('git_failed')
  await index.configure({ metadataRef: 'other' })
  assert.deepEqual(index.storefronts(), [])
  assert.equal(index.status().gitError, 'git_failed')
})
