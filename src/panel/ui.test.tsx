// The building blocks of the panel: what each one draws, with Orca's own components only, and
// that Orca would drop none of their props.
import { atom, Button, Code, derived, read, RelativeTime, set, Text, type OrcaNode } from 'orca'
import { afterEach, assert, mount, test, type TestPanel } from 'orca/testing'
import { Actions, Empty, ErrorState, Group, LabelledRow, ListRow, MaskedText, memo, MAX_ROWS, Notice, NOTICE_ICONS, NoticeLine, PAGE_SIZE, placeholderParts, ShowMore, StateBadge, StateMark, TONES, type StateTone } from './ui'

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

test('StateMark is a dot, a hollow ring when off, a spinner while busy, all the same width', async () => {
  /** The mark itself, inside the box that gives every mark one width. */
  const markOf = (shown: TestPanel) => {
    const frame = shown.tree()
    assert.ok(frame && typeof frame === 'object', 'drawn')
    assert.equal(frame.type, 'Box')
    assert.equal(frame.props?.width, 16)
    assert.equal(frame.props?.shrink, false)
    return shown.findAll({ type: 'Box' }).find((box) => box.props.width === 10)
  }
  let shown = await draw(() => <StateMark tone="ok" />)
  assert.deepEqual({ ...markOf(shown)?.props }, { width: 10, height: 10, radius: 'full', border: 'success', background: 'success' })
  shown.unmount()
  shown = await draw(() => <StateMark tone="failed" />)
  assert.equal(markOf(shown)?.props.background, 'danger')
  shown.unmount()
  shown = await draw(() => <StateMark tone="off" />)
  assert.equal(markOf(shown)?.props.border, true)
  assert.equal(markOf(shown)?.props.background, undefined)
  shown.unmount()
  shown = await draw(() => <StateMark tone="busy" label="Uploading" />)
  assert.equal(markOf(shown), undefined)
  const spinner = shown.find({ type: 'Spinner' })
  assert.equal(spinner?.props.label, 'Uploading')
  assert.equal(spinner?.props.labelHidden, true)
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
  // The spinner is named by the note, which says the same.
  assert.equal(shown.find({ type: 'Spinner' })?.props.label, 'uploading…')
  const name = shown.find({ text: 'feature-cart' })
  assert.equal(name?.props.weight, 'semibold')
  assert.equal(name?.props.truncate, true)
  assert.equal(shown.find({ text: 'uploading…' })?.props.tone, 'accent')
  shown.unmount()
  shown = await draw(() => <ListRow tone="off" title="main" note="idle" />)
  assert.equal(shown.findAll({ type: 'Box' }).find((box) => box.props.width === 10)?.props.border, true)
  assert.equal(shown.find({ text: 'main' })?.props.weight, 'regular')
  assert.equal(shown.find({ text: 'idle' })?.props.muted, true)
  shown.unmount()
  shown = await draw(() => <ListRow tone="ok" title="main" />)
  assert.deepEqual(shown.findAll({ type: 'Text' }).map((item) => item.text), ['main'])
})

test('ListRow opens its item when given a press action, through a link on its name', async () => {
  let opened = 0
  let shown = await draw(() => <ListRow tone="failed" title="TypeError in a script" note="3×" noteTone="failed" onPress={() => opened++} />)
  const link = shown.find({ type: 'Link' })
  assert.equal(link?.text, 'TypeError in a script')
  await shown.press({ type: 'Link' })
  assert.equal(opened, 1)
  shown.unmount()
  // Without one, the name is plain text.
  shown = await draw(() => <ListRow tone="failed" title="TypeError in a script" />)
  assert.equal(shown.find({ type: 'Link' }), null)
})

test('ListRow takes a second line, as a muted text or as given, and its own buttons after the note', async () => {
  let pressed = 0
  let shown = await draw(() => <ListRow tone="off" title="checkout-fix" detail="bugfix/checkout-total" note="idle" actions={<Button size="xs" onPress={() => pressed++}>Use</Button>} />)
  const detail = shown.find({ text: 'bugfix/checkout-total' })
  assert.equal(detail?.props.muted, true)
  assert.equal(detail?.props.truncate, true)
  await shown.press({ type: 'Button', text: 'Use' })
  assert.equal(pressed, 1)
  shown.unmount()
  shown = await draw(() => (
    <ListRow
      tone="ok"
      title="show()"
      detail={
        <Text size="sm" muted>
          <Code>Page.js:11</Code>
        </Text>
      }
    />
  ))
  assert.ok(shown.find({ type: 'Code', text: 'Page.js:11' }))
  shown.unmount()
  shown = await draw(() => (
    <ListRow
      tone="ok"
      title="TypeError"
      detail={
        <Text size="sm" muted>
          <RelativeTime at={Date.now() - 60_000} format="short" />
        </Text>
      }
    />
  ))
  assert.ok(shown.find({ type: 'RelativeTime' }))
})

test('Notice is compact: an icon by its tone, a short title, one line, and one button', async () => {
  let fixed = 0
  let shown = await draw(() => <Notice tone="attention" title="No dw.json" detail="Add one at the workspace root." action={{ label: 'Check again', icon: 'refresh', onPress: () => fixed++ }} />)
  const callout = shown.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'warning')
  assert.equal(callout?.props.icon, 'warning')
  assert.equal(callout?.props.title, 'No dw.json')
  const line = shown.find({ text: 'Add one at the workspace root.' })
  // The line wraps, never cut: at 300 px it may take two lines, and the fix is in it.
  assert.equal(line?.props.truncate, undefined)
  // Its row wraps, so when the line takes the width the button goes under it, still seen.
  assert.equal(shown.findAll({ type: 'Row' }).find((row) => row.props.justify === 'between')?.props.wrap, true)
  assert.equal(shown.findAll({ role: 'button' }).length, 1)
  await shown.press({ type: 'Button', text: 'Check again' })
  assert.equal(fixed, 1)
  shown.unmount()
  // Each tone has an icon of its own, so the tone is never told by colour alone.
  const tones: StateTone[] = ['ok', 'busy', 'attention', 'failed', 'off']
  assert.deepEqual(tones.map((tone) => NOTICE_ICONS[tone]), ['check', 'info', 'warning', 'error', 'info'])
  // A title alone draws no empty row.
  shown = await draw(() => <Notice tone="failed" title="Upload stopped" />)
  assert.equal(shown.find({ type: 'Row' }), null)
})

test('NoticeLine is one line with a mark and at most a small button, never a callout', async () => {
  let opened = 0
  const shown = await draw(() => <NoticeLine tone="attention" text="Sandbox not set up" action={{ label: 'Open setup', icon: 'settings', onPress: () => opened++ }} />)
  assert.equal(shown.find({ type: 'Callout' }), null)
  assert.equal(shown.find({ text: 'Sandbox not set up' })?.props.truncate, undefined, 'it wraps, never cut')
  // Its outer row wraps, so the button goes under the text when narrow.
  const root = shown.tree() as { type?: string; props?: Record<string, unknown> } | null
  assert.equal(root?.type, 'Row')
  assert.equal(root?.props?.wrap, true)
  assert.equal(shown.find({ type: 'Button' })?.props.variant, 'ghost')
  await shown.press({ type: 'Button', text: 'Open setup' })
  assert.equal(opened, 1)
})

test('MaskedText draws what masking put in place of a value as code, the words around it as text', async () => {
  assert.deepEqual(placeholderParts('order #, amount #.# EUR at <host> for ***'), [
    { text: 'order ', placeholder: false },
    { text: '#', placeholder: true },
    { text: ', amount ', placeholder: false },
    { text: '#.#', placeholder: true },
    { text: ' EUR at ', placeholder: false },
    { text: '<host>', placeholder: true },
    { text: ' for ', placeholder: false },
    { text: '***', placeholder: true }
  ])
  assert.deepEqual(placeholderParts('nothing masked'), [{ text: 'nothing masked', placeholder: false }])
  const shown = await draw(() => <MaskedText text="Failed for <code> on <host>" />)
  assert.deepEqual(shown.findAll({ type: 'Code' }).map((code) => code.text), ['<code>', '<host>'])
  assert.equal(shown.find({ type: 'Text' })?.props.truncate, undefined, 'it wraps')
})

test('ShowMore draws a page more at a time, and stops at MAX_ROWS with a line on what is not drawn', async () => {
  let more = 0
  const label = (left: number) => `Show ${left} more`
  const capped = (left: number) => `${left} more not shown`
  let shown = await draw(() => <ShowMore shown={PAGE_SIZE} total={300} label={label} capped={capped} onPress={() => more++} />)
  await shown.press({ type: 'Button', text: `Show ${300 - PAGE_SIZE} more` })
  assert.equal(more, 1)
  shown.unmount()
  shown = await draw(() => <ShowMore shown={MAX_ROWS} total={300} label={label} capped={capped} onPress={() => more++} />)
  assert.equal(shown.find({ type: 'Button' }), null)
  assert.ok(shown.find({ text: `${300 - MAX_ROWS} more not shown` }))
  shown.unmount()
  shown = await draw(() => <ShowMore shown={30} total={30} label={label} capped={capped} onPress={() => more++} />)
  assert.equal(shown.tree(), null)
})

test('memo builds a value once per change of its inputs, where Orca’s derived builds it on every draw', async () => {
  const list = atom<readonly number[]>(Array.from({ length: 1000 }, (_, i) => i))
  const query = atom('')
  const other = atom(0)
  let memoBuilds = 0
  let derivedBuilds = 0
  const filtered = memo(
    () => [read(list), read(query)],
    () => {
      memoBuilds++
      return read(list).filter((n) => String(n).includes(read(query)))
    }
  )
  const viaDerived = derived(() => {
    derivedBuilds++
    return read(list).length
  })
  derivedBuilds = 0
  panel = await mount(() => (
    <Text>
      {`${filtered().length} of ${read(viaDerived)}, ${read(other)}`}
    </Text>
  ))
  assert.ok(panel.find({ text: '1000 of 1000, 0' }))
  // Something it does not read changes: the draw runs again, the value is not built again.
  for (let i = 1; i <= 5; i++) set(other, i)
  await panel.settled()
  assert.ok(panel.find({ text: '1000 of 1000, 5' }))
  assert.equal(memoBuilds, 1)
  // Orca's derived is built on each draw: why the views use memo for what grows with their data.
  assert.ok(derivedBuilds >= 2, `${derivedBuilds} builds`)
  // An input changes: built once more, and the draw follows it.
  set(query, '99')
  await panel.settled()
  assert.ok(panel.find({ text: '19 of 1000, 5' }))
  assert.equal(memoBuilds, 2)
})
