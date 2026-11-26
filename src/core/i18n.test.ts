import { assert, test } from 'orca/testing'
import { messages as debuggerMessages } from '../pieces/debugger/i18n'
import { messages as editorMessages } from '../pieces/editor/i18n'
import { messages as engineMessages } from '../pieces/engine/i18n'
import { messages as errorsMessages } from '../pieces/errors/i18n'
import { messages as sandboxMessages } from '../pieces/sandbox/i18n'
import { CORE_MESSAGES, format, languageOf, t, translator, wordError, type Messages } from './i18n'

const TABLES: Record<string, Messages<string>> = {
  core: CORE_MESSAGES,
  sandbox: sandboxMessages,
  errors: errorsMessages,
  debugger: debuggerMessages,
  engine: engineMessages,
  editor: editorMessages
}

test('Spanish has every English key, in every table, and no other', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    assert.deepEqual(Object.keys(table.es).sort(), Object.keys(table.en).sort(), name)
    for (const [key, value] of Object.entries(table.es)) assert.ok(value.trim(), `${name}.${key} is empty in Spanish`)
  }
})

test('picks the language and falls back to English', () => {
  assert.equal(languageOf('es-ES'), 'es')
  assert.equal(languageOf('es'), 'es')
  assert.equal(languageOf('en-GB'), 'en')
  assert.equal(languageOf('fr-FR'), 'en')
  assert.equal(languageOf(''), 'en')
  assert.equal(t(CORE_MESSAGES, 'es-ES', 'refresh'), 'Actualizar')
  assert.equal(t(CORE_MESSAGES, 'de', 'refresh'), 'Refresh')
})

test('fills placeholders and leaves unknown ones alone', () => {
  assert.equal(format('Found, version {version}', { version: '1.2.3' }), 'Found, version 1.2.3')
  assert.equal(format('{a} and {b}', { a: 1 }), '1 and {b}')
  assert.equal(t(CORE_MESSAGES, 'es', 'b2cFound', { version: '2.0.0' }), 'Encontrado, versión 2.0.0')
})

test('a translator follows a locale that changes', () => {
  let locale = 'en'
  const tr = translator(() => locale)
  assert.equal(tr(CORE_MESSAGES, 'pieces'), 'Pieces')
  locale = 'es'
  assert.equal(tr(CORE_MESSAGES, 'pieces'), 'Piezas')
})

test('words every error code the worker sends, and an unknown one', () => {
  for (const code of ['b2c_not_found', 'b2c_failed', 'b2c_timeout', 'no_version', 'aborted', 'role_refused', 'role_required', 'role_not_configured', 'credentials_missing', 'unsafe_argument', 'config_invalid']) {
    assert.ok(!wordError('en', code).includes(code), code)
    assert.notEqual(wordError('es', code), wordError('en', code), code)
  }
  assert.equal(wordError('en', 'weird'), 'Unexpected error (weird).')
})
