import { assert, test } from 'orca/testing'
import { CORE_MESSAGES, format, languageOf, t, translator, wordError, type Messages } from './i18n'
import { PIECE_IDS } from './piece'

/** Core's table and every piece's, found by its folder: a new piece needs no line here. */
async function tables(): Promise<Record<string, Messages<string>>> {
  const all: Record<string, Messages<string>> = { core: CORE_MESSAGES }
  for (const id of PIECE_IDS) all[id] = (await import(`../pieces/${id}/i18n`)).messages
  return all
}

test('Spanish has every English key, in every table, and no other', async () => {
  const all = await tables()
  assert.deepEqual(Object.keys(all), ['core', ...PIECE_IDS])
  for (const [name, table] of Object.entries(all)) {
    assert.ok(Object.keys(table.en).length > 0, name)
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

/** Every code of B2cErrorCode, the worker's `no_version`, and the two the host answers with. */
const CODES = [
  'b2c_not_found',
  'b2c_failed',
  'b2c_timeout',
  'no_version',
  'aborted',
  'role_refused',
  'role_required',
  'role_not_configured',
  'credentials_missing',
  'value_invalid',
  'flag_not_allowed',
  'unsafe_argument',
  'cwd_not_found',
  'config_invalid',
  'timeout',
  'action_failed'
]

test('words every error code the panel can get, in both languages, and an unknown one', () => {
  for (const code of CODES) {
    assert.ok(!wordError('en', code).includes(code), code)
    assert.ok(!wordError('es', code).includes(code), code)
    assert.notEqual(wordError('es', code), wordError('en', code), code)
  }
  assert.equal(wordError('en', 'timeout'), 'The plugin took too long to answer.')
  assert.equal(wordError('es', 'action_failed'), 'No se ha podido completar la acción.')
  assert.equal(wordError('en', 'weird'), 'Unexpected error (weird).')
})
