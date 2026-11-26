// The building blocks of the panel: what each one draws, with Orca's own components only, and
// that Orca would drop none of their props.
import { Button, Text, type OrcaNode } from 'orca'
import { afterEach, assert, mount, test, type TestPanel } from 'orca/testing'
import { Actions, Empty, ErrorState, Group, LabelledRow, ListRow, StateBadge, StateMark, TONES, type StateTone } from './ui'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

/** Mounts a component and checks that Orca would draw it as written. */
async function draw(component: () => OrcaNode): Promise<TestPanel> {
  panel = await mount(component)
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  return panel
}

test('every tone of the plugin is drawn with one of Orca’s, and no two share one', () => {
  const tones: StateTone[] = ['ok', 'busy', 'attention', 'failed', 'off']
  assert.deepEqual(Object.keys(TONES).sort(), [...tones].sort())
  assert.deepEqual(tones.map((tone) => TONES[tone]), ['success', 'accent', 'warning', 'danger', 'neutral'])
})

test('StateBadge draws its words in the tone’s colour', async () => {
  const shown = await draw(() => <StateBadge tone="attention">Incomplete</StateBadge>)
  const badge = shown.find({ type: 'Badge' })
  assert.equal(badge?.text, 'Incomplete')
  assert.equal(badge?.props.tone, 'warning')
})

test('StateMark is a small filled dot, or a hollow ring when off', async () => {
  let shown = await draw(() => <StateMark tone="ok" />)
  let mark = shown.find({ type: 'Box' })
  assert.deepEqual({ ...mark?.props }, { width: 8, height: 8, radius: 'full', border: 'success', background: 'success', shrink: false })
  shown.unmount()
  shown = await draw(() => <StateMark tone="off" />)
  mark = shown.find({ type: 'Box' })
  assert.equal(mark?.props.border, true)
  assert.equal(mark?.props.background, undefined)
})

test('LabelledRow puts the label on the left and the value on the right, cutting a long text', async () => {
  let shown = await draw(() => <LabelledRow label="Version">ws-feature-cart</LabelledRow>)
  const row = shown.find({ type: 'Row' })
  assert.equal(row?.props.justify, 'between')
  const texts = shown.findAll({ type: 'Text' })
  assert.deepEqual(texts.map((item) => item.text), ['Version', 'ws-feature-cart'])
  assert.equal(texts[0].props.muted, true)
  assert.ok(texts.every((item) => item.props.truncate === true))
  shown.unmount()
  // A badge as the value is drawn as given.
  shown = await draw(() => (
    <LabelledRow label="Sandbox">
      <StateBadge tone="ok">Started</StateBadge>
    </LabelledRow>
  ))
  assert.equal(shown.find({ type: 'Badge' })?.text, 'Started')
})

test('Group has a small title, an optional action beside it, and its rows under it; no card', async () => {
  const shown = await draw(() => (
    <Group title="Workspaces" action={<Button size="xs">Add</Button>}>
      <Text>main</Text>
    </Group>
  ))
  const title = shown.find({ text: 'Workspaces' })
  assert.equal(title?.props.weight, 'semibold')
  assert.equal(title?.props.size, 'sm')
  assert.ok(shown.find({ role: 'button', text: 'Add' }))
  assert.ok(shown.find({ text: 'main' }))
  assert.equal(shown.find({ type: 'Card' }), null)
})

test('Actions lays its buttons side by side and wraps them when narrow', async () => {
  const shown = await draw(() => (
    <Actions>
      <Button>Deploy all</Button>
      <Button variant="outline">Reload</Button>
    </Actions>
  ))
  assert.equal(shown.find({ type: 'Row' })?.props.wrap, true)
  assert.equal(shown.findAll({ role: 'button' }).length, 2)
})

test('Empty is Orca’s empty state with one line of guidance', async () => {
  const shown = await draw(() => <Empty title="No errors" guidance="New errors of the log appear here." icon="warning" />)
  const empty = shown.find({ type: 'EmptyState' })
  assert.equal(empty?.label, 'No errors')
  assert.equal(empty?.props.description, 'New errors of the log appear here.')
  assert.equal(empty?.props.icon, 'warning')
  assert.match(shown.summary().join('\n'), /No errors/)
})

test('ErrorState says what failed and why, and retries only when given a way to', async () => {
  let retried = 0
  let shown = await draw(() => <ErrorState title="The sandbox could not be read" message="b2c ended with an error." retryLabel="Try again" onRetry={() => retried++} />)
  assert.match(shown.summary().join('\n'), /The sandbox could not be read/)
  assert.equal(shown.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.ok(shown.find({ text: 'b2c ended with an error.' }))
  await shown.press({ role: 'button', text: 'Try again' })
  assert.equal(retried, 1)
  shown.unmount()
  // While busy the retry waits.
  shown = await draw(() => <ErrorState title="Failed" message="Why" retryLabel="Try again" busy onRetry={() => retried++} />)
  assert.equal(shown.find({ role: 'button', text: 'Try again' })?.disabled, true)
  shown.unmount()
  // Without a retry, no button.
  shown = await draw(() => <ErrorState title="Failed" message="Why" />)
  assert.equal(shown.find({ role: 'button' }), null)
})

test('ListRow leads with a state mark and ends with a short note', async () => {
  let shown = await draw(() => <ListRow tone="busy" title="feature-cart" note="uploading…" noteTone="busy" current />)
  assert.equal(shown.find({ type: 'Box' })?.props.background, 'accent')
  const name = shown.find({ text: 'feature-cart' })
  assert.equal(name?.props.weight, 'medium')
  assert.equal(name?.props.truncate, true)
  assert.equal(shown.find({ text: 'uploading…' })?.props.tone, 'accent')
  shown.unmount()
  shown = await draw(() => <ListRow tone="off" title="main" note="idle" />)
  assert.equal(shown.find({ type: 'Box' })?.props.border, true)
  assert.equal(shown.find({ text: 'main' })?.props.weight, 'regular')
  assert.equal(shown.find({ text: 'idle' })?.props.muted, true)
  shown.unmount()
  shown = await draw(() => <ListRow tone="ok" title="main" />)
  assert.deepEqual(shown.findAll({ type: 'Text' }).map((item) => item.text), ['main'])
})
