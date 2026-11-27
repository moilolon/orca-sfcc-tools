// The scripts a breakpoint can go in: inside a cartridge (a folder with a .project file), found
// by name.
import { assert, test } from 'orca/testing'
import { byCartridge, isScriptPath, scriptFiles, type ReadDir } from './files'

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

test('scripts are grouped by the cartridge that holds them, the longest cartridge path winning', () => {
  const files = ['c/one/cartridge/a.js', 'c/one/cartridge/b.js', 'c/one-more/cartridge/x.js', 'loose.js']
  assert.deepEqual(byCartridge(files, ['c/one', 'c/one-more', 'c/empty']), [
    { path: 'c/one', files: ['c/one/cartridge/a.js', 'c/one/cartridge/b.js'] },
    { path: 'c/one-more', files: ['c/one-more/cartridge/x.js'] }
  ])
  // A workspace that is itself a cartridge holds every file.
  assert.deepEqual(byCartridge(['a.js', 'x/b.js'], ['']), [{ path: '', files: ['a.js', 'x/b.js'] }])
})

test('a path is a script a breakpoint can go in when it is a .js or .ds inside a cartridge and outside a skipped folder', () => {
  const cartridges = ['cartridges/app_example', 'cartridges/plugin_example']
  for (const path of ['cartridges/app_example/cartridge/controllers/Page.js', 'cartridges/plugin_example/cartridge/scripts/job.ds', 'cartridges/app_example/cartridge/scripts/NEW.JS']) {
    assert.equal(isScriptPath(path, cartridges), true, path)
  }
  for (const path of [
    'cartridges/app_example/cartridge/templates/default/page.isml',
    'cartridges/app_example/cartridge/forms/default/profile.xml',
    'scripts/build.js',
    'cartridges/other/cartridge/x.js',
    'cartridges/app_example/node_modules/lib/index.js',
    'cartridges/app_example/cartridge/.git/hook.js',
    'cartridges/app_example/../app_other/x.js',
    'cartridges/app_example//x.js',
    `cartridges/app_example/${'d/'.repeat(12)}deep.js`
  ]) {
    assert.equal(isScriptPath(path, cartridges), false, path)
  }
  // A workspace that is itself a cartridge.
  assert.equal(isScriptPath('cartridge/controllers/Page.js', ['']), true)
})
