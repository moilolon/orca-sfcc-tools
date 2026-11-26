import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { coerceSettings, createSettings, DEFAULT_SETTINGS } from './settings'

test('the defaults are the manifest’s', () => {
  const base = JSON.parse(readFileSync(new URL('../manifest.base.json', import.meta.url), 'utf8'))
  const declared = Object.fromEntries(base.contributes.settings.map((setting: { key: string; default: unknown }) => [setting.key, setting.default]))
  assert.deepEqual(declared, { ...DEFAULT_SETTINGS })
})

test('keeps strings, falls back to the default for anything else or an empty path', () => {
  assert.deepEqual(coerceSettings({ b2cPath: 'C:\\tools\\b2c.cmd', stagingSuffix: '_stg', productionSuffix: 7 }), {
    ...DEFAULT_SETTINGS,
    b2cPath: 'C:\\tools\\b2c.cmd',
    stagingSuffix: '_stg'
  })
  assert.equal(coerceSettings({ b2cPath: '  ' }).b2cPath, 'b2c')
  assert.deepEqual(coerceSettings(null), { ...DEFAULT_SETTINGS })
  // An empty suffix is kept as set: the role then counts as not configured (src/core/instances.ts).
  assert.equal(coerceSettings({ developmentSuffix: '' }).developmentSuffix, '')
})

test('suffixes and change notifications', async () => {
  let listener: (change: { key: string }) => void = () => {}
  const settings = createSettings({
    get: async () => ({ developmentSuffix: '.d' }),
    onDidChange: (fn) => {
      listener = fn
      return { dispose() {} }
    }
  })
  assert.deepEqual(await settings.suffixes(), { development: '.d', staging: '-stg', production: '-prd' })
  const heard: string[] = []
  settings.onDidChange((key) => heard.push(key))
  listener({ key: 'b2cPath' })
  assert.deepEqual(heard, ['b2cPath'])
})
