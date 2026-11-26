// The scripts a breakpoint can go in: inside a cartridge (a folder with a .project file), found
// by name.
import { assert, test } from 'orca/testing'
import { byCartridge, matchFiles, MAX_MATCHES, scriptFiles, type ReadDir } from './files'

type Tree = { [name: string]: Tree | string }

/** A folder tree in memory, as `readdir` with file types would list it. */
function fakeDir(tree: Tree): ReadDir {
  return async (path) => {
    const parts = path.replace(/\\/g, '/').replace(/^\/root/, '').split('/').filter(Boolean)
    let node: Tree | string = tree
    for (const part of parts) {
      if (typeof node === 'string' || !(part in node)) throw new Error('ENOENT')
      node = node[part]
    }
    if (typeof node === 'string') throw new Error('ENOTDIR')
    return Object.entries(node).map(([name, child]) => ({ name, isDirectory: () => typeof child !== 'string', isFile: () => typeof child === 'string' }))
  }
}

const WORKSPACE: Tree = {
  'package.json': '',
  'dw.json': '',
  cartridges: {
    app_one: {
      '.project': '',
      cartridge: { controllers: { 'Page.js': '', 'Home.js': '' }, scripts: { 'helper.ds': '', 'notes.txt': '' }, templates: { 'page.isml': '' } }
    },
    app_two: { '.project': '', cartridge: { controllers: { 'Page.js': '' } } },
    not_a_cartridge: { 'loose.js': '' }
  },
  node_modules: { dep: { '.project': '', 'index.js': '' } },
  build: { app: { '.project': '', 'x.js': '' } }
}

test('lists the .js and .ds files of every cartridge, relative to the workspace, skipping what b2c skips', async () => {
  const { files, truncated, cartridges } = await scriptFiles('/root', fakeDir(WORKSPACE))
  // The cartridges found, outermost only; not the ones in folders b2c skips.
  assert.deepEqual(cartridges, ['cartridges/app_one', 'cartridges/app_two'])
  assert.deepEqual(files, [
    'cartridges/app_one/cartridge/controllers/Home.js',
    'cartridges/app_one/cartridge/controllers/Page.js',
    'cartridges/app_one/cartridge/scripts/helper.ds',
    'cartridges/app_two/cartridge/controllers/Page.js'
  ])
  assert.equal(truncated, false)
})

test('finds files by every word typed, ignoring case, the file’s own name first; an empty query finds nothing', () => {
  const files = ['a/very/long/path/to/controllers/Page.js', 'b/Page.js', 'c/pages/other.js', 'd/scripts/helper.ds']
  assert.deepEqual(matchFiles(files, 'page').files, ['b/Page.js', 'a/very/long/path/to/controllers/Page.js', 'c/pages/other.js'])
  assert.deepEqual(matchFiles(files, 'CONTROLLERS page').files, ['a/very/long/path/to/controllers/Page.js'])
  assert.deepEqual(matchFiles(files, '   ').files, [])
  const many = Array.from({ length: 80 }, (_, i) => `x/f${i}.js`)
  const found = matchFiles(many, 'f')
  assert.equal(found.files.length, MAX_MATCHES)
  assert.equal(found.truncated, true)
})

test('scripts are grouped by the cartridge that holds them, the longest cartridge path winning', () => {
  const files = ['c/one/cartridge/a.js', 'c/one/cartridge/b.js', 'c/one-more/cartridge/x.js', 'loose.js']
  assert.deepEqual(byCartridge(files, ['c/one', 'c/one-more', 'c/empty']), [
    { path: 'c/one', files: ['c/one/cartridge/a.js', 'c/one/cartridge/b.js'] },
    { path: 'c/one-more', files: ['c/one-more/cartridge/x.js'] }
  ])
  // A workspace that is itself a cartridge holds every file.
  assert.deepEqual(byCartridge(['a.js', 'x/b.js'], ['']), [{ path: '', files: ['a.js', 'x/b.js'] }])
})
