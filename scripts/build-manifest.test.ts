// The manifest merge, and that the committed orca-plugin.json is exactly the merge.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest, mergeManifest, readSources, serialize } from './build-manifest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const BASE = {
  manifestVersion: 2,
  id: 'x',
  contributes: { panels: [{ id: 'p', title: 'P' }], settings: [{ key: 'a', type: 'string' }] },
  capabilities: [{ kind: 'storage:own' }]
}

test('the committed orca-plugin.json equals the merge of its fragments', () => {
  const committed = readFileSync(join(ROOT, 'orca-plugin.json'), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(committed, buildManifest(ROOT), 'run npm run manifest')
})

test('appends each fragment’s contributions after the base’s, in the order given', () => {
  const merged = mergeManifest(BASE, [
    { piece: 'errors', manifest: { contributes: { settings: [{ key: 'b' }], commands: [{ id: 'errors.refresh' }] } } },
    { piece: 'sandbox', manifest: { contributes: { commands: [{ id: 'sandbox.pick' }], statusBarItems: [{ id: 'sandbox' }] } } },
    { piece: 'isml', manifest: {} }
  ])
  assert.deepEqual(merged.contributes, {
    panels: [{ id: 'p', title: 'P' }],
    settings: [{ key: 'a', type: 'string' }, { key: 'b' }],
    commands: [{ id: 'errors.refresh' }, { id: 'sandbox.pick' }],
    statusBarItems: [{ id: 'sandbox' }]
  })
  assert.deepEqual(merged.capabilities, BASE.capabilities)
  assert.deepEqual(BASE.contributes.settings, [{ key: 'a', type: 'string' }], 'the base is not changed')
})

test('refuses a fragment that reaches outside contributes, or repeats an id', () => {
  assert.throws(() => mergeManifest(BASE, [{ piece: 'evil', manifest: { capabilities: [{ kind: 'terminal:send' }] } }]), /may only hold "contributes"/)
  assert.throws(() => mergeManifest(BASE, [{ piece: 'evil', manifest: { id: 'other' } }]), /may only hold "contributes"/)
  assert.throws(() => mergeManifest(BASE, [{ piece: 'dup', manifest: { contributes: { settings: [{ key: 'a' }] } } }]), /already has key "a"/)
  assert.throws(
    () =>
      mergeManifest(BASE, [
        { piece: 'one', manifest: { contributes: { commands: [{ id: 'c' }] } } },
        { piece: 'two', manifest: { contributes: { commands: [{ id: 'c' }] } } }
      ]),
    /two: contributes.commands already has id "c"/
  )
  assert.throws(() => mergeManifest(BASE, [{ piece: 'bad', manifest: { contributes: { commands: {} } } }]), /must be a list/)
})

test('two pieces may declare the same hook or event: it is emitted once, where the first one put it', () => {
  const save = { event: 'editor.save.before', onError: 'pass' }
  const merged = mergeManifest(BASE, [
    { piece: 'editor', manifest: { contributes: { hooks: [save, { event: 'agent.tool.after' }], events: [{ on: 'workspace.removed' }] } } },
    // The same entries, with their keys in another order.
    { piece: 'engine', manifest: { contributes: { hooks: [{ onError: 'pass', event: 'editor.save.before' }], events: [{ on: 'workspace.removed' }, { on: 'workspace.created' }] } } },
    { piece: 'sandbox', manifest: { contributes: { events: [{ on: 'workspace.removed' }] } } }
  ])
  const contributes = merged.contributes as Record<string, unknown>
  assert.deepEqual(contributes.hooks, [save, { event: 'agent.tool.after' }])
  assert.deepEqual(contributes.events, [{ on: 'workspace.removed' }, { on: 'workspace.created' }])
  // One the base already declares is shared the same way.
  const withBase = mergeManifest({ ...BASE, contributes: { hooks: [save] } }, [{ piece: 'engine', manifest: { contributes: { hooks: [save] } } }])
  assert.deepEqual((withBase.contributes as Record<string, unknown>).hooks, [save])
})

test('the same hook or event with different options fails, naming both pieces', () => {
  assert.throws(
    () =>
      mergeManifest(BASE, [
        { piece: 'editor', manifest: { contributes: { hooks: [{ event: 'editor.save.before', onError: 'deny' }] } } },
        { piece: 'engine', manifest: { contributes: { hooks: [{ event: 'editor.save.before', onError: 'pass' }] } } }
      ]),
    /engine: contributes\.hooks "editor\.save\.before" differs from the one editor declares/
  )
  assert.throws(
    () =>
      mergeManifest(BASE, [
        { piece: 'editor', manifest: { contributes: { hooks: [{ event: 'editor.save.before' }] } } },
        { piece: 'engine', manifest: { contributes: { hooks: [{ event: 'editor.save.before', onError: 'pass' }] } } }
      ]),
    /engine: contributes\.hooks "editor\.save\.before" differs from the one editor declares/
  )
  assert.throws(
    () => mergeManifest({ ...BASE, contributes: { events: [{ on: 'workspace.removed' }] } }, [{ piece: 'sandbox', manifest: { contributes: { events: [{ on: 'workspace.removed', extra: true }] } } }]),
    /sandbox: contributes\.events "workspace\.removed" differs from the one the base declares/
  )
  // Sharing is for hooks and events only: a command or a setting still belongs to one piece.
  assert.throws(
    () =>
      mergeManifest(BASE, [
        { piece: 'one', manifest: { contributes: { statusBarItems: [{ id: 's' }] } } },
        { piece: 'two', manifest: { contributes: { statusBarItems: [{ id: 's' }] } } }
      ]),
    /two: contributes\.statusBarItems already has id "s"/
  )
})

test('typecheck writes Orca’s typings itself, so it passes on a clean clone after npm install', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  // tsconfig.json extends a file that only `orca plugin types` writes, and .orca/ is not committed.
  const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'))
  assert.equal(tsconfig.extends, './.orca/types/tsconfig.json')
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^\.orca\/$/m)
  assert.match(pkg.scripts.typecheck, /^orca plugin types \. && tsc -p \. --noEmit$/)
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies')
})

test('the same pieces give the same file, whatever order the disk lists them in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfcc-tools-manifest-'))
  try {
    mkdirSync(join(dir, 'src', 'pieces'), { recursive: true })
    writeFileSync(join(dir, 'src', 'manifest.base.json'), JSON.stringify(BASE))
    // Created out of order on purpose.
    for (const piece of ['zeta', 'alpha', 'mid']) {
      mkdirSync(join(dir, 'src', 'pieces', piece))
      writeFileSync(join(dir, 'src', 'pieces', piece, 'manifest.json'), JSON.stringify({ contributes: { commands: [{ id: `${piece}.run` }] } }))
    }
    assert.deepEqual(readSources(dir).fragments.map((fragment) => fragment.piece), ['alpha', 'mid', 'zeta'])
    const built = buildManifest(dir)
    assert.equal(built, buildManifest(dir))
    assert.deepEqual(JSON.parse(built).contributes.commands, [{ id: 'alpha.run' }, { id: 'mid.run' }, { id: 'zeta.run' }])
    assert.ok(built.endsWith('}\n'))
    assert.equal(serialize({ a: 1 }), '{\n  "a": 1\n}\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the access list is exactly the one phase 0 fixed', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'orca-plugin.json'), 'utf8'))
  assert.deepEqual(
    manifest.capabilities.map((capability: { kind: string }) => capability.kind),
    ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show']
  )
  assert.equal(manifest.publisher, undefined)
  assert.equal(manifest.id, 'sfcc-tools')
})
