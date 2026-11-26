// Code version names: how they are derived from a workspace's name and kept per workspace id.
import { assert, test } from 'orca/testing'
import { DEFAULT_PREFIX, deriveName, MAX_SLUG, prefixOf, slugOf, versionFor } from './code-version'

test('a slug is lower case letters, digits and single hyphens, bounded in length', () => {
  assert.equal(slugOf('Checkout Fix'), 'checkout-fix')
  assert.equal(slugOf('feature/PLP_filters'), 'feature-plp-filters')
  assert.equal(slugOf('Tienda Señor_2'), 'tienda-senor-2')
  assert.equal(slugOf('--Shop--'), 'shop')
  assert.equal(slugOf('a % & ^ | < > ! " b'), 'a-b', 'nothing cmd.exe reads survives')
  assert.equal(slugOf('***'), 'workspace')
  assert.equal(slugOf(''), 'workspace')
  const long = slugOf('x'.repeat(39) + ' tail of a very long workspace name')
  assert.ok(long.length <= MAX_SLUG)
  assert.ok(!long.endsWith('-'), 'a cut never leaves a trailing hyphen')
  assert.match(slugOf('Ünïcödé Wörkspace'), /^[a-z0-9-]+$/)
})

test('the prefix keeps only safe characters, and falls back to the default when not a text', () => {
  assert.equal(prefixOf('ws-'), 'ws-')
  assert.equal(prefixOf('dev_'), 'dev_')
  assert.equal(prefixOf('a b/c%'), 'abc')
  assert.equal(prefixOf(''), '')
  assert.equal(prefixOf(undefined), DEFAULT_PREFIX)
  assert.equal(prefixOf(7), DEFAULT_PREFIX)
  assert.equal(prefixOf('p'.repeat(40)).length, 16)
})

test('a name another workspace holds gets a number', () => {
  assert.equal(deriveName('ws-', 'Shop', []), 'ws-shop')
  assert.equal(deriveName('ws-', 'Shop', ['ws-shop']), 'ws-shop-2')
  assert.equal(deriveName('ws-', 'shop', ['WS-SHOP', 'ws-shop-2']), 'ws-shop-3')
  assert.equal(deriveName('', 'Shop', []), 'shop')
})

test('the name is stored per workspace id, so a rename keeps the version', () => {
  const first = versionFor({}, { id: 'w1', name: 'Checkout' }, 'ws-')
  assert.equal(first.name, 'ws-checkout')
  assert.deepEqual(first.names, { w1: 'ws-checkout' })

  const renamed = versionFor(first.names, { id: 'w1', name: 'Checkout, renamed' }, 'ws-')
  assert.equal(renamed.name, 'ws-checkout', 'the stored name wins over the new one')
  assert.equal(renamed.names, first.names, 'nothing new to store')

  const prefixChanged = versionFor(first.names, { id: 'w1', name: 'Checkout' }, 'other-')
  assert.equal(prefixChanged.name, 'ws-checkout', 'a new prefix applies to new workspaces only')

  const twin = versionFor(first.names, { id: 'w2', name: 'Checkout' }, 'ws-')
  assert.equal(twin.name, 'ws-checkout-2', 'two workspaces with one name never share a version')

  const afterPending = versionFor({}, { id: 'w3', name: 'Checkout' }, 'ws-', ['ws-checkout'])
  assert.equal(afterPending.name, 'ws-checkout-2', 'a version waiting to be deleted is not reused')
})
