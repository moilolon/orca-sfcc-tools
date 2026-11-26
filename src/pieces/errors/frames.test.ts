// Which frames are files of the workspace: the cartridges found by their `.project` file, and a
// frame's script path matched to one of them, never out of it.
import { assert, test } from 'orca/testing'
import { createFrameResolver, findCartridges, localPathOf, type FrameFileSystem } from './frames'

/** A folder tree in memory: each path ends in `/` for a folder; `.project` marks a cartridge. */
function memoryFs(paths: string[]): FrameFileSystem & { listed: string[] } {
  const listed: string[] = []
  return {
    listed,
    async list(path) {
      listed.push(path)
      const prefix = path.endsWith('/') ? path : `${path}/`
      const children = new Set<string>()
      let isCartridge = false
      for (const entry of paths) {
        if (!entry.startsWith(prefix)) continue
        const rest = entry.slice(prefix.length)
        const [name, ...more] = rest.split('/')
        if (name === '.project' && more.length === 0) isCartridge = true
        else if (more.length > 0) children.add(name)
      }
      return { folders: [...children], isCartridge }
    },
    async isFile(path) {
      return paths.includes(path)
    }
  }
}

const TREE = [
  '/w/cartridges/app_example/.project',
  '/w/cartridges/app_example/cartridge/scripts/helpers/cartHelper.js',
  '/w/cartridges/app_example/cartridge/controllers/Cart.js',
  '/w/cartridges/int_example/.project',
  '/w/cartridges/int_example/cartridge/scripts/service.js',
  '/w/node_modules/app_example/.project',
  '/w/node_modules/app_example/cartridge/scripts/helpers/cartHelper.js',
  '/w/.git/x/.project',
  '/w/docs/readme.md'
]

test('findCartridges finds the folders holding a .project file, skipping node_modules and dot folders', async () => {
  const fs = memoryFs(TREE)
  const found = await findCartridges('/w', fs, 'linux')
  assert.deepEqual([...found].sort(), [
    ['app_example', '/w/cartridges/app_example'],
    ['int_example', '/w/cartridges/int_example']
  ])
  assert.ok(!fs.listed.some((path) => path.includes('node_modules') || path.includes('.git')))
  // The workspace's own root is never a cartridge, even with a .project.
  assert.deepEqual([...(await findCartridges('/w/cartridges/app_example', memoryFs(TREE), 'linux'))], [])
})

test('localPathOf maps a script path to its cartridge, and refuses anything else', () => {
  const cartridges = new Map([['app_example', '/w/cartridges/app_example']])
  assert.equal(localPathOf('app_example/cartridge/scripts/helpers/cartHelper.js', cartridges, 'linux'), '/w/cartridges/app_example/cartridge/scripts/helpers/cartHelper.js')
  assert.equal(localPathOf('/version_a/app_example/cartridge/controllers/Cart.js', cartridges, 'linux'), '/w/cartridges/app_example/cartridge/controllers/Cart.js')
  for (const outside of [
    'app_other/cartridge/scripts/a.js',
    'app_example/scripts/a.js',
    'app_example/cartridge/../../../../etc/passwd',
    '../app_example/cartridge/a.js',
    'ScriptRunner.java',
    ''
  ]) {
    assert.equal(localPathOf(outside, cartridges, 'linux'), null, outside)
  }
  const windows = new Map([['app_example', 'C:\\w\\cartridges\\app_example']])
  assert.equal(localPathOf('app_example/cartridge/scripts/a.js', windows, 'win32'), 'C:\\w\\cartridges\\app_example\\cartridge\\scripts\\a.js')
})

test('the resolver answers only files that exist, and looks the cartridges up once a while', async () => {
  const fs = memoryFs(TREE)
  let clock = 0
  const resolver = createFrameResolver({ fs, platform: 'linux', now: () => clock })
  assert.equal(await resolver.resolve('/w', 'app_example/cartridge/scripts/helpers/cartHelper.js'), '/w/cartridges/app_example/cartridge/scripts/helpers/cartHelper.js')
  assert.equal(await resolver.resolve('/w', 'app_example/cartridge/scripts/missing.js'), null)
  assert.equal(await resolver.resolve('/w', 'int_example/cartridge/scripts/service.js'), '/w/cartridges/int_example/cartridge/scripts/service.js')
  const walks = fs.listed.filter((path) => path === '/w').length
  assert.equal(walks, 1, 'the tree is walked once')
  clock = 60_000
  await resolver.resolve('/w', 'app_example/cartridge/controllers/Cart.js')
  assert.equal(fs.listed.filter((path) => path === '/w').length, 2, 'and again once the cache is old')
})
