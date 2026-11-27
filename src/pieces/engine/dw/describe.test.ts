// Descriptions read at run time through `b2c docs read`, with a fake runner: the answer must be the
// page asked for, only the section asked for comes back, masked, and each page is read once.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { guard, refusedFlag } from '../../../core/instances'
import type { RunOptions, RunResult } from '../../../core/b2c'
import { createDescriber, DescribeError } from './describe'

const page = (id: string) => readFileSync(new URL(`../fixtures/dw/${id}.md`, import.meta.url), 'utf8')

/** A fake runner: the fixture pages, or `answer`; `mask` hides the word `garden`. */
function fakeB2c(answer?: (id: string) => unknown) {
  const calls: Array<{ args: readonly string[]; options?: RunOptions }> = []
  const masked: string[] = []
  return {
    calls,
    masked,
    b2c: {
      async run(args: readonly string[], options?: RunOptions): Promise<RunResult> {
        calls.push({ args, options })
        const id = args[2]
        const json = answer ? answer(id) : { entry: { id }, content: page(id) }
        if (json instanceof Error) throw json
        return { stdout: '', stderr: '', json }
      },
      async mask(text: string) {
        masked.push(text)
        return text.replace(/garden/gi, '***')
      }
    }
  }
}

test('a member’s own section, masked, read with a role-less docs command', async () => {
  const fake = fakeB2c()
  const describer = createDescriber(fake.b2c, { cwd: 'C:\\empty' })
  const text = await describer.describe('dw.garden.Plant', 'water(Number, Boolean)')
  assert.equal(
    text,
    [
      '- water(litres: [Number](/script-api/TopLevel.Number.md), warm: [Boolean](/script-api/TopLevel.Boolean.md)): [Boolean](/script-api/TopLevel.Boolean.md)',
      '  - : Waters the plant.',
      '',
      '    **Parameters:**',
      '',
      '    - litres - how much water to pour.',
      '    - warm - whether the water is warm.',
      '',
      '    **Returns:**',
      '',
      '    - true when the plant drank it.',
      '',
      '    **API Version:**'
    ].join('\n')
  )
  assert.equal(fake.calls.length, 1)
  const [{ args, options }] = fake.calls
  assert.deepEqual(args, ['docs', 'read', 'dw.garden.Plant', '--workspace', 'all'])
  assert.deepEqual(guard(args, undefined), { ok: true, needsRole: false })
  assert.equal(refusedFlag(args), -1)
  assert.equal(options?.role, undefined)
  assert.equal(options?.cwd, 'C:\\empty')
})

test('what comes back went through the mask; the class’s own description too', async () => {
  const fake = fakeB2c()
  const describer = createDescriber(fake.b2c)
  const plant = await describer.describe('dw.garden.Plant')
  assert.equal(plant, 'Invented base class of everything that grows in the fixture ***.')
  assert.deepEqual(fake.masked, ['Invented base class of everything that grows in the fixture garden.'])
  const manager = await describer.describe('dw.garden.GardenMgr')
  assert.match(manager ?? '', /^Invented helper that looks after every bed of the fixture \*\*\*\.\n\n\*\*Deprecated:\*\*\n\n:::warning\nUse \[Plant\]/)
})

test('a member is found by the key the index gives it, escapes and variants included', async () => {
  const describer = createDescriber(fakeB2c().b2c)
  assert.match((await describer.describe('dw.garden.Plant', 'tag(String[])')) ?? '', /^- tag\(labels:/)
  assert.match((await describer.describe('dw.garden.Plant', 'COLOUR_GREEN')) ?? '', /^- COLOUR\\_GREEN:/)
  assert.match((await describer.describe('dw.garden.Tree', 'grow(Number) - Variant 2')) ?? '', /^- ~~grow\(centimetres:[\s\S]*\*\*Deprecated:\*\*/)
  assert.match((await describer.describe('dw.garden.Tree', 'Tree(String, Number...)')) ?? '', /^- Tree\(name:/)
  // The last member of a section stops at the next section, without its rule.
  assert.equal(await describer.describe('dw.garden.Tree', 'height'), '- height: [Number](/script-api/TopLevel.Number.md)\n  - : The height of the tree in metres.')
  // A member the page does not have, or a summary heading, is no section.
  assert.equal(await describer.describe('dw.garden.Tree', 'shade()'), null)
  assert.equal(await describer.describe('dw.garden.Tree', 'Methods inherited from class Plant'), null)
})

test('an answer for another page than the one asked is refused, and not kept', async () => {
  let wrong = true
  const fake = fakeB2c((id) => ({ entry: { id: wrong ? 'dw.garden.GardenMgr' : id }, content: page(wrong ? 'dw.garden.GardenMgr' : id) }))
  const describer = createDescriber(fake.b2c)
  await assert.rejects(describer.describe('dw.garden.Plant'), (error: unknown) => error instanceof DescribeError && error.code === 'wrong_page')
  wrong = false
  assert.match((await describer.describe('dw.garden.Plant')) ?? '', /^Invented base class/)
  assert.equal(fake.calls.length, 2)
  await assert.rejects(createDescriber(fakeB2c(() => ({ entry: { id: 'dw.garden.Plant' } })).b2c).describe('dw.garden.Plant'), /no_content/)
  await assert.rejects(createDescriber(fakeB2c(() => 'not json').b2c).describe('dw.garden.Plant'), /wrong_page/)
})

test('each page is read once for the worker’s life, a failed read is tried again', async () => {
  let fail = true
  const fake = fakeB2c((id) => {
    if (fail) return new Error('b2c_failed')
    return { entry: { id }, content: page(id) }
  })
  const describer = createDescriber(fake.b2c)
  await assert.rejects(describer.describe('dw.garden.Tree', 'height'), /b2c_failed/)
  fail = false
  await Promise.all([describer.describe('dw.garden.Tree', 'height'), describer.describe('dw.garden.Tree', 'getName()'), describer.describe('dw.garden.Tree')])
  await describer.describe('dw.garden.Tree', 'plantAll(String...)')
  assert.equal(fake.calls.length, 2)
})

test('only a class id reaches b2c', async () => {
  const fake = fakeB2c()
  const describer = createDescriber(fake.b2c)
  for (const bad of ['--version', 'Plant', 'dw garden', 'dw.garden.Plant --raw', '', 'dw..Plant']) {
    await assert.rejects(describer.describe(bad), (error: unknown) => error instanceof DescribeError && error.code === 'invalid_class')
  }
  assert.equal(fake.calls.length, 0)
})
