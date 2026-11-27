// What the editor piece declares and what its frame may load: the editors and their file types
// (the same list src/core/open-file.ts opens there), the command and its shortcut, the hook; the
// frame's imports stay relative and reach no Node or worker module; every text fits a notice.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from 'orca/testing'
import { LANGUAGES } from '../../core/i18n'
import { EDITOR_EXTENSIONS, PLUGIN_ID } from '../../core/open-file'
import { NOTICE_MAX_CHARS } from '../../panel/ui'
import { messages } from './i18n'
import { section } from './section'
import { OPEN_COMMAND } from './worker'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

type Manifest = {
  id: string
  contributes: {
    customEditors?: { id: string; extensions: string[]; priority: string; entry: string; frame: string }[]
    commands?: { id: string; title: string; when?: string }[]
    keybindings?: { command: string; key: string; when?: string }[]
    hooks?: { event: string; onError?: string }[]
  }
}
const manifest = JSON.parse(readFileSync(join(ROOT, 'orca-plugin.json'), 'utf8')) as Manifest

test('.isml opens in the editor by default; .js, .xml and .properties offer it; isolated frames only', () => {
  const editors = manifest.contributes.customEditors ?? []
  const byExtension = new Map(editors.flatMap((editor) => editor.extensions.map((extension) => [extension, editor] as const)))
  assert.equal(byExtension.get('.isml')?.priority, 'default')
  for (const extension of ['.js', '.xml', '.properties']) assert.equal(byExtension.get(extension)?.priority, 'option', extension)
  for (const editor of editors) assert.equal(editor.frame, 'isolated')
  // Each editor has its own entry: the `.isml` one knows its files are templates without guessing.
  assert.equal(byExtension.get('.isml')?.entry, 'src/pieces/editor/main.ts')
  for (const extension of ['.js', '.xml', '.properties']) assert.equal(byExtension.get(extension)?.entry, 'src/pieces/editor/main-view.ts', extension)
  assert.deepEqual([...byExtension.keys()].sort(), [...EDITOR_EXTENSIONS].sort(), 'open-file.ts opens there exactly the types the editor takes')
  assert.equal(manifest.id, PLUGIN_ID)
})

test('the command, its shortcut and the save hook are declared; the hook observes only', () => {
  const command = manifest.contributes.commands?.find((entry) => entry.id === OPEN_COMMAND)
  assert.equal(command?.title, 'SFCC: Open in SFCC editor')
  const binding = manifest.contributes.keybindings?.find((entry) => entry.command === OPEN_COMMAND)
  // Ctrl+Alt+letter is AltGr text on Windows and Linux (Ctrl+Alt+E types € on a Spanish layout), so
  // Orca never matches it as a shortcut there.
  assert.equal(binding?.key, 'Alt+Shift+E')
  assert.equal(binding?.when, command?.when)
  const hook = manifest.contributes.hooks?.find((entry) => entry.event === 'editor.save.before')
  assert.ok(hook)
  assert.notEqual(hook.onError, 'deny', 'a failure never blocks a save')
})

/** Every module the editor's entry loads, followed through its imports. */
function frameModules(): string[] {
  const seen = new Set<string>()
  const queue = [join(HERE, 'main.ts'), join(HERE, 'main-view.ts')]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s*['"]([^'"]+)['"]/gm)) {
      const spec = match[1]
      assert.ok(spec.startsWith('.'), `${relative(ROOT, file)} imports ${spec}: an editor frame loads only relative files`)
      const target = resolve(dirname(file), spec)
      queue.push(/\.tsx?$/.test(target) ? target : `${target}.ts`)
    }
  }
  return [...seen].map((file) => relative(ROOT, file).replace(/\\/g, '/'))
}

test('the editor frame loads only relative, pure modules: no Node, no worker code, no piece but the engine’s syntax layer', () => {
  const modules = frameModules()
  assert.ok(modules.includes('src/pieces/engine/js/lexer.ts'), 'the engine’s lexer colours the text')
  for (const module of modules) {
    assert.ok(/^src\/(pieces\/(editor|engine\/(js|isml))|core\/i18n\.ts)/.test(module), `${module} is loaded by the editor frame`)
    assert.ok(!/(locate|worker)\.ts$/.test(module) || module.endsWith('locate-client.ts'), `${module} is worker code`)
    const source = readFileSync(join(ROOT, module), 'utf8')
    assert.ok(!/from\s*['"]node:/.test(source), `${module} imports Node`)
  }
})

test('every text fits a notice line in both languages, and the piece is listed with no view of its own', () => {
  for (const language of LANGUAGES) {
    for (const [key, text] of Object.entries(messages[language])) {
      assert.ok(text.length <= NOTICE_MAX_CHARS, `${language}.${key} is ${text.length} characters`)
    }
  }
  assert.equal(section.delivered, true)
  assert.equal(section.hasView, false)
})

test('no file of the piece names a real project: fixtures and tests are invented', () => {
  const files = readdirSync(HERE, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  for (const entry of files) {
    const text = readFileSync(join(entry.parentPath, entry.name), 'utf8')
    for (const host of text.matchAll(/https?:\/\/([\w.-]+)/g)) assert.ok(/(^|\.)example\.com$/.test(host[1]), `${entry.name} names ${host[1]}`)
  }
})
