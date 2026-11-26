// The building blocks of the panel: what every view is made of, so the sections the pieces write
// look like one panel. Each block is built only from Orca's own components and holds no text of
// its own: the caller words everything in Orca's language. CLAUDE.md, "Panel look", says which
// block goes where.
import { Badge, Box, Button, Callout, EmptyState, Link, Row, Spinner, Stack, Text, type IconName, type OrcaNode, type Tone } from 'orca'

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
 * Something failed: what, in the title; why, in the message (worded with `wordError`); and, when
 * trying again can help, a button for it.
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
  return (
    <Callout tone="danger" icon="error" title={title}>
      <Stack gap="sm">
        <Text>{message}</Text>
        {onRetry && retryLabel ? (
          <Actions>
            <Button size="sm" variant="outline" icon="refresh" disabled={busy} onPress={onRetry}>
              {retryLabel}
            </Button>
          </Actions>
        ) : null}
      </Stack>
    </Callout>
  )
}

/**
 * One item of a list: a state mark, its name (cut when it does not fit) and a short note on the
 * right (`uploading…`, `3 new`). `current` sets the name in a heavier weight. With `onPress` the
 * name is a link that opens the item (the log entry, the file at its line).
 */
export function ListRow({
  tone,
  title,
  note,
  noteTone,
  current = false,
  onPress
}: {
  tone: StateTone
  title: string
  note?: string
  noteTone?: StateTone
  current?: boolean
  onPress?: () => unknown
}) {
  return (
    <Row justify="between" align="center" gap="sm">
      <Row align="center" gap="sm">
        <StateMark tone={tone} label={note ?? title} />
        <Text truncate weight={current ? 'medium' : 'regular'}>
          {onPress ? <Link onPress={onPress}>{title}</Link> : title}
        </Text>
      </Row>
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
    </Row>
  )
}
