// The building blocks of the panel: what every view is made of, so the sections the pieces write
// look like one panel. Each block is built only from Orca's own components and holds no text of
// its own: the caller words everything in Orca's language. CLAUDE.md, "Panel look", says which
// block goes where.
import { Badge, Box, Button, Callout, Code, EmptyState, Link, Row, Spinner, Stack, Text, type IconName, type OrcaNode, type Tone } from 'orca'

/**
 * The plugin's tones, by what they mean rather than by colour: `ok` done or ready, `busy` working
 * now, `attention` usable but something is missing, `failed` broken or refused, `off` not set up
 * or not running.
 */
export type StateTone = 'ok' | 'busy' | 'attention' | 'failed' | 'off'

/** The Orca tone each of the plugin's tones is drawn with. */
export const TONES: Readonly<Record<StateTone, Tone>> = {
  ok: 'success',
  busy: 'accent',
  attention: 'warning',
  failed: 'danger',
  off: 'neutral'
}

/** The icon a notice of each tone leads with, so its tone is never told by colour alone. */
export const NOTICE_ICONS: Readonly<Record<StateTone, IconName>> = {
  ok: 'check',
  busy: 'info',
  attention: 'warning',
  failed: 'error',
  off: 'info'
}

/** The one button of a notice: what fixes the problem, or leads to where it is fixed. */
export type NoticeAction = { label: string; onPress: () => unknown; icon?: IconName; disabled?: boolean }

/** A state in one or two words (`Ready`, `Not started`), coloured by its tone. */
export function StateBadge({ tone, children }: { tone: StateTone; children: string }) {
  return <Badge tone={TONES[tone]}>{children}</Badge>
}

/**
 * A small round mark in a tone: a spinner while `busy`, a filled dot for the other states, a
 * hollow ring for `off`. It sits beside a text that says the same; `label` names a spinner for
 * screen readers.
 */
export function StateMark({ tone, label = '' }: { tone: StateTone; label?: string }) {
  // Every mark takes the same width, so the names beside a dot and beside a spinner line up.
  return (
    <Box width={16} align="center" justify="center" shrink={false}>
      {tone === 'busy' ? (
        <Spinner label={label} labelHidden />
      ) : tone === 'off' ? (
        <Box width={10} height={10} radius="full" border={true} />
      ) : (
        <Box width={10} height={10} radius="full" border={TONES[tone]} background={TONES[tone]} />
      )}
    </Box>
  )
}

/**
 * A label on the left and its value on the right: a text (cut with an ellipsis when it does not
 * fit), a `StateBadge` or a small control.
 */
export function LabelledRow({ label, children }: { label: string; children?: OrcaNode }) {
  return (
    <Row justify="between" align="center" gap="sm">
      <Text muted truncate>
        {label}
      </Text>
      {typeof children === 'string' || typeof children === 'number' ? <Text truncate>{String(children)}</Text> : children}
    </Row>
  )
}

/** A titled part of a view. Never a card: a view is a list of groups, one under the other. */
export function Group({ title, action, children }: { title: string; action?: OrcaNode; children?: OrcaNode }) {
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm">
        <Text size="sm" weight="semibold" muted>
          {title}
        </Text>
        {action ?? null}
      </Row>
      <Stack gap="xs">{children}</Stack>
    </Stack>
  )
}

/** The buttons of a view or a group, side by side, wrapping onto a new line when narrow. */
export function Actions({ children }: { children?: OrcaNode }) {
  return (
    <Row gap="sm" wrap>
      {children}
    </Row>
  )
}

/** Nothing to show yet, and one line on what brings something. */
export function Empty({ title, guidance, icon }: { title: string; guidance: string; icon?: IconName }) {
  return <EmptyState title={title} description={guidance} icon={icon} />
}

/**
 * The longest a notice's line may be: two lines of a 300 px sidebar. A test holds every text a
 * notice can show to it, in both languages.
 */
export const NOTICE_MAX_CHARS = 76

/**
 * A problem a view must show and the status line does not: an icon, a title of a few words
 * (`Sandbox not set up`), at most one short line on why (it wraps, never cut: at 300 px it may
 * take two), and one button that fixes it or leads to where it is fixed (`Open setup`, `Retry`),
 * beside the line when it fits and under it when not. Never a paragraph.
 */
export function Notice({ tone, title, detail, action }: { tone: StateTone; title: string; detail?: string; action?: NoticeAction }) {
  return (
    <Callout tone={TONES[tone]} icon={NOTICE_ICONS[tone]} title={title}>
      {detail || action ? (
        <Row align="center" justify="between" gap="sm" wrap>
          {detail ? (
            <Text size="sm">{detail}</Text>
          ) : (
            <Box grow />
          )}
          {action ? (
            <Button size="xs" variant="outline" icon={action.icon} disabled={action.disabled ?? false} onPress={action.onPress}>
              {action.label}
            </Button>
          ) : null}
        </Row>
      ) : null}
    </Callout>
  )
}

/**
 * A problem the status line already says, or a passing fact: one line with a state mark (it wraps,
 * never cut) and, at most, one small button, beside it when it fits and under it when not. Never
 * a callout.
 */
export function NoticeLine({ tone, text, action }: { tone: StateTone; text: string; action?: NoticeAction }) {
  return (
    <Row align="center" justify="between" gap="xs" wrap>
      <Row align="center" gap="sm">
        <StateMark tone={tone} label={text} />
        <Text size="sm" muted>
          {text}
        </Text>
      </Row>
      {action ? (
        <Button size="xs" variant="ghost" icon={action.icon} disabled={action.disabled ?? false} onPress={action.onPress}>
          {action.label}
        </Button>
      ) : null}
    </Row>
  )
}

/**
 * Something failed: what, in the title; why, in one line (worded with `wordError`); and, when
 * trying again can help, a button for it. A `Notice` in the failed tone.
 */
export function ErrorState({
  title,
  message,
  retryLabel,
  onRetry,
  busy = false
}: {
  title: string
  message: string
  retryLabel?: string
  onRetry?: () => unknown
  busy?: boolean
}) {
  return <Notice tone="failed" title={title} detail={message} action={onRetry && retryLabel ? { label: retryLabel, onPress: onRetry, icon: 'refresh', disabled: busy } : undefined} />
}

/**
 * One item of a list: a state mark, its name (cut when it does not fit), an optional second line
 * (`detail`: a branch, a code version; a text is drawn muted and cut, anything else as given, such
 * as a `Text` holding a `RelativeTime` or a `Code` path), a short note on the right (`uploading…`,
 * `3 new`) and, after it, the item's own small buttons (`actions`, `IconButton`s with a label).
 * `current` sets the name in a heavier weight. With `onPress` the name is a link that opens the
 * item (the log entry, the file at its line).
 */
export function ListRow({
  tone,
  title,
  detail,
  note,
  noteTone,
  current = false,
  onPress,
  actions
}: {
  tone: StateTone
  title: string
  detail?: OrcaNode
  note?: string
  noteTone?: StateTone
  current?: boolean
  onPress?: () => unknown
  actions?: OrcaNode
}) {
  const name = (
    <Text truncate weight={current ? 'semibold' : 'regular'}>
      {onPress ? <Link onPress={onPress}>{title}</Link> : title}
    </Text>
  )
  return (
    <Row justify="between" align="center" gap="sm">
      <Row align="center" gap="sm">
        <StateMark tone={tone} label={note ?? title} />
        {detail ? (
          <Stack gap="none">
            {name}
            {typeof detail === 'string' ? (
              <Text size="sm" muted truncate>
                {detail}
              </Text>
            ) : (
              detail
            )}
          </Stack>
        ) : (
          name
        )}
      </Row>
      {note || actions ? (
        <Row align="center" gap="xs">
          {note ? (
            noteTone && noteTone !== 'off' ? (
              <Text size="sm" tone={TONES[noteTone]}>
                {note}
              </Text>
            ) : (
              <Text size="sm" muted>
                {note}
              </Text>
            )
          ) : null}
          {actions ?? null}
        </Row>
      ) : null}
    </Row>
  )
}

/**
 * What a masked or normalised text put in place of a value: `#` for a number, `<code>`,
 * `<host>`, `<locale>` and the like, `***` for a value of dw.json.
 */
const PLACEHOLDER = /(<[a-z][a-z-]*>|\*\*\*|#(?:[.,:]#)*)/g

/** A masked text cut into its words and its placeholders, in order. */
export function placeholderParts(text: string): { text: string; placeholder: boolean }[] {
  const parts: { text: string; placeholder: boolean }[] = []
  let last = 0
  for (const match of text.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0
    if (at > last) parts.push({ text: text.slice(last, at), placeholder: false })
    parts.push({ text: match[0], placeholder: true })
    last = at + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), placeholder: false })
  return parts
}

/**
 * A masked text, wrapping, with what masking or normalising put in place of a value drawn as code,
 * so a `#` or a `<host>` reads as a stand-in, not as part of the message.
 */
export function MaskedText({ text, size }: { text: string; size?: 'sm' | 'md' }) {
  return <Text size={size}>{placeholderParts(text).map((part, index) => (part.placeholder ? <Code key={`p${index}`}>{part.text}</Code> : part.text))}</Text>
}

/** How many rows a long list draws at first, and how many more each *Show more* adds. */
export const PAGE_SIZE = 25

/**
 * The most rows a list ever draws, however often *Show more* is pressed: past it, a view narrows
 * the list instead (a search, a filter). It keeps a view well under its size budget.
 */
export const MAX_ROWS = 100

/**
 * The end of a long list drawn a page at a time: a small button that draws more, saying how many
 * are left; at `MAX_ROWS`, one muted line saying how many are not drawn (`capped`). Nothing when
 * every row is drawn.
 */
export function ShowMore({
  shown,
  total,
  label,
  capped,
  onPress
}: {
  shown: number
  total: number
  label: (left: number) => string
  capped: (left: number) => string
  onPress: () => unknown
}) {
  if (shown >= total) return null
  if (shown >= MAX_ROWS) {
    return (
      <Text size="sm" muted>
        {capped(total - shown)}
      </Text>
    )
  }
  return (
    <Row>
      <Button size="xs" variant="ghost" icon="expand" onPress={onPress}>
        {label(total - shown)}
      </Button>
    </Row>
  )
}

/**
 * A value computed from what a view reads, computed again only when one of its inputs changed.
 * Orca's `derived` is no cache: each `read` of it calls its function again, so a list built in one
 * (a tree of thousands of scripts) was built on every draw, whatever changed. `inputs` reads every
 * value `compute` depends on (so the draw still follows them) and returns them; `compute` runs only
 * when one of them is not the same value as last time (`Object.is`: atoms are replaced, never
 * changed in place), and reads them again itself. Only the last result is kept.
 */
export function memo<T>(inputs: () => readonly unknown[], compute: () => T): () => T {
  let last: { keys: readonly unknown[]; value: T } | null = null
  return () => {
    const keys = inputs()
    if (last && last.keys.length === keys.length && last.keys.every((value, i) => Object.is(value, keys[i]))) return last.value
    const value = compute()
    last = { keys, value }
    return value
  }
}
