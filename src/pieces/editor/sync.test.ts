// The document sync against Orca's mock editor host: edits reach the file, a save gets what is
// pending, an outside write is merged with the person's edits (both kept, the person's version
// where they overlap), and the surface hears every outside change.
import { assert, mockEditorHost, test } from 'orca/testing'
import { EditorModel } from './surface/model'
import { startSync } from './sync'

const TEMPLATE = ['<isdecorate template="common/layout/page">', '    <div class="cart">', '        ${pdict.count}', '    </div>', '</isdecorate>', ''].join('\n')

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('the editor opens on the file and its edits reach it', async () => {
  const host = mockEditorHost({ text: TEMPLATE })
  const sync = await startSync(host.orca, { debounceMs: 5 })
  try {
    assert.equal(sync.initial, TEMPLATE)
    assert.equal(sync.readOnly, false)
    sync.change(TEMPLATE.replace('cart', 'basket'))
    await settle()
    assert.equal(host.text, TEMPLATE.replace('cart', 'basket'))
  } finally {
    sync.dispose()
    host.dispose()
  }
})

test('a save gets the edit still waiting', async () => {
  const host = mockEditorHost({ text: TEMPLATE })
  const sync = await startSync(host.orca, { debounceMs: 10_000 })
  try {
    sync.change(TEMPLATE + '<!-- saved -->\n')
    assert.equal(host.text, TEMPLATE, 'nothing sent yet')
    await host.flush()
    assert.equal(host.text, TEMPLATE + '<!-- saved -->\n')
  } finally {
    sync.dispose()
    host.dispose()
  }
})

test('an agent writes the file while the person edits: both changes are kept', async () => {
  const host = mockEditorHost({ text: TEMPLATE })
  const sync = await startSync(host.orca, { debounceMs: 10_000 })
  const model = new EditorModel(sync.initial)
  const replaced: string[] = []
  sync.onReplace((text) => {
    replaced.push(text)
    model.replaceAll(text)
  })
  try {
    // The person types on line 3; the agent changes line 1 before the edit is sent.
    model.setSelection({ line: 2, col: 22 })
    model.type('!')
    sync.change(model.text())
    host.replace(TEMPLATE.replace('common/layout/page', 'common/layout/checkout'))
    await host.flush()
    const expected = TEMPLATE.replace('common/layout/page', 'common/layout/checkout').replace('${pdict.count}', '${pdict.count}!')
    assert.equal(host.text, expected)
    assert.equal(model.text(), expected)
    assert.ok(replaced.length >= 1, 'the surface heard the merge')
    assert.deepEqual(model.selection.head, { line: 2, col: 23 }, 'the caret stays after what was typed')
    assert.equal(sync.lastMerge()?.conflicts, 0)
  } finally {
    sync.dispose()
    host.dispose()
  }
})

test('an outside write with nothing pending replaces the text, and the caret keeps its place', async () => {
  const host = mockEditorHost({ text: TEMPLATE })
  const sync = await startSync(host.orca, { debounceMs: 5 })
  const model = new EditorModel(sync.initial)
  sync.onReplace((text) => model.replaceAll(text))
  try {
    model.setSelection({ line: 3, col: 4 })
    host.replace('<!-- header -->\n' + TEMPLATE)
    await settle()
    assert.equal(model.text(), '<!-- header -->\n' + TEMPLATE)
    assert.deepEqual(model.selection.head, { line: 4, col: 4 }, 'the caret moved down with its line')
    // The outside change is one undo step of its own.
    assert.ok(model.undo())
    assert.equal(model.text(), TEMPLATE)
  } finally {
    sync.dispose()
    host.dispose()
  }
})

test('both sides change the same line differently: the person’s version is kept there, the rest merged', async () => {
  const host = mockEditorHost({ text: TEMPLATE })
  const sync = await startSync(host.orca, { debounceMs: 10_000 })
  try {
    const mine = TEMPLATE.replace('cart', 'mine').replace('</isdecorate>', '</isdecorate>\n<!-- end -->')
    sync.change(mine)
    host.replace(TEMPLATE.replace('cart', 'theirs').replace('<isdecorate', '<iscontent type="text/html"/>\n<isdecorate'))
    await host.flush()
    assert.equal(host.text, '<iscontent type="text/html"/>\n' + mine)
    assert.equal(sync.lastMerge()?.conflicts, 1)
  } finally {
    sync.dispose()
    host.dispose()
  }
})

test('CRLF files keep their line breaks through edits and merges', async () => {
  const crlf = TEMPLATE.replace(/\n/g, '\r\n')
  const host = mockEditorHost({ text: crlf })
  const sync = await startSync(host.orca, { debounceMs: 10_000 })
  const model = new EditorModel(sync.initial)
  sync.onReplace((text) => model.replaceAll(text))
  try {
    model.setSelection({ line: 1, col: 4 })
    model.enter()
    sync.change(model.text())
    host.replace(crlf.replace('</isdecorate>', '</isdecorate><!-- x -->'))
    await host.flush()
    assert.ok(!/[^\r]\n/.test(host.text ?? ''), 'no bare LF')
    assert.equal(host.text, crlf.replace('    <div', '    \r\n    <div').replace('</isdecorate>', '</isdecorate><!-- x -->'))
  } finally {
    sync.dispose()
    host.dispose()
  }
})

test('a byte order mark survives select all and paste, and an outside write, on every write to the file', async () => {
  const bom = '﻿' + TEMPLATE
  const host = mockEditorHost({ text: bom })
  const sync = await startSync(host.orca, { debounceMs: 10_000 })
  const model = new EditorModel(sync.initial)
  sync.onReplace((text) => model.replaceAll(text))
  model.onUpdate((event) => {
    if (event.textChanged && !event.provisional) sync.change(model.text())
  })
  try {
    model.selectAll()
    model.paste('<div/>')
    await host.flush()
    assert.equal(host.text, '﻿<div/>')
    host.replace('﻿<div/>\n<p/>')
    await new Promise((resolve) => setTimeout(resolve, 30))
    model.setSelection({ line: 0, col: 0 })
    model.type('x')
    await host.flush()
    assert.equal(host.text, '﻿x<div/>\n<p/>')
  } finally {
    sync.dispose()
    host.dispose()
  }
})

test('a read-only document sends nothing', async () => {
  const host = mockEditorHost({ text: TEMPLATE }, { readOnly: true })
  const sync = await startSync(host.orca, { debounceMs: 5 })
  try {
    assert.equal(sync.readOnly, true)
    sync.change('changed')
    await settle()
    assert.equal(host.text, TEMPLATE)
    assert.equal(host.edits.length, 0)
  } finally {
    sync.dispose()
    host.dispose()
  }
})
