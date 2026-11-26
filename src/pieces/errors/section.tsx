// The errors piece's half of the panel, listed in src/panel/sections.ts: per environment, the
// errors not yet marked (new) and the ones marked (seen), each with its count, first and last time
// and its sample; "Mark as seen" for one or all, "Forget", "Read now". The environments' own state
// is on the panel's status line; this view only says when the one picked cannot be read.
//
// What it shows comes from the worker already masked: the normalised first line, the logger and
// the top frames of each signature. Never a host, a local path or a raw log entry.
import { atom, Button, Callout, Collapsible, env, Link, plugin, read, RelativeTime, Select, Stack, Text, update, type OrcaNode, type PanelContext } from 'orca'
import { t, wordError } from '../../core/i18n'
import { ROLES, isRole, type Role } from '../../core/instances'
import type { PanelSection } from '../../core/piece'
import { Actions, Empty, ErrorState, Group, LabelledRow, ListRow } from '../../panel/ui'
import { messages, openFailureKey, ROLE_KEYS, type ErrorsMessageKey } from './i18n'
import type { ErrorFrame, ErrorRow, RoleErrors } from './protocol'

/** The environment picked, kept across runs of the plugin. */
const pickedRole = atom<string>('errorsRole', 'sandbox', { persist: 'plugin' })
/** The last answer for each environment. */
const answers = atom<Partial<Record<Role, RoleErrors>>>({})
/** The code of a request that failed, per environment; the next good answer clears it. */
const failures = atom<Partial<Record<Role, string>>>({})
/** What is being sent now (`refresh`, `mark:<signature>`, `forget:<signature>`), so its button waits. */
const pending = atom<string | null>(null)
/** Why the last frame pressed did not open, worded when drawn. */
const openProblem = atom<string | null>(null)

function text(locale: string, key: ErrorsMessageKey, vars?: Record<string, string | number>): string {
  return t(messages, locale, key, vars)
}

function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'action_failed'
}

function currentRole(): Role {
  const role = read(pickedRole)
  return isRole(role) ? role : 'sandbox'
}

function keep(role: Role, answer: RoleErrors): void {
  update(answers, (previous) => ({ ...previous, [role]: answer }))
  update(failures, (previous) => ({ ...previous, [role]: undefined }))
}

function fail(role: Role, error: unknown): void {
  update(failures, (previous) => ({ ...previous, [role]: codeOf(error) }))
}

async function load(role: Role): Promise<void> {
  try {
    keep(role, await plugin.request('errors.list', { role }))
  } catch (error) {
    fail(role, error)
  }
}

/** Sends one action and keeps its answer; `name` marks its button as waiting meanwhile. */
async function act(role: Role, name: string, send: () => Promise<RoleErrors>): Promise<void> {
  update(pending, () => name)
  try {
    keep(role, await send())
  } catch (error) {
    fail(role, error)
  } finally {
    update(pending, () => null)
  }
}

function refresh(role: Role): Promise<void> {
  // The worker answers at once, reading; `errors.changed` brings the list once the read ended.
  return act(role, 'refresh', () => plugin.request('errors.refresh', { role }))
}

function mark(role: Role, signatures: string[], name: string): Promise<void> {
  return act(role, name, () => plugin.request('errors.mark', { role, signatures }))
}

function forget(role: Role, signature: string): Promise<void> {
  return act(role, `forget:${signature}`, () => plugin.request('errors.forget', { role, signature }))
}

async function openFrame(role: Role, signature: string, frame: number): Promise<void> {
  update(openProblem, () => null)
  try {
    const result = await plugin.request('errors.open', { role, signature, frame })
    if (!result.opened) update(openProblem, () => result.reason ?? 'action_failed')
  } catch (error) {
    update(openProblem, () => codeOf(error))
  }
}

function pick(value: string): void {
  if (!isRole(value)) return
  update(pickedRole, () => value)
  update(openProblem, () => null)
  void load(value)
}

/** A moment as the person's locale writes a date and time, in their time zone. */
function formatTime(at: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
  } catch {
    return new Date(at).toISOString()
  }
}

/** The last part of a script's path: the name a person recognises. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function FrameLine({ frame, onOpen, locale }: { frame: ErrorFrame; onOpen: () => unknown; locale: string }) {
  const where = frame.line === null ? fileName(frame.file) : text(locale, 'frameLine', { file: fileName(frame.file), line: frame.line })
  const label = frame.function ? `${where} · ${frame.function}` : where
  return (
    <Text size="sm" truncate>
      {frame.openable ? <Link onPress={onOpen}>{label}</Link> : label}
    </Text>
  )
}

function Time({ at }: { at: number }) {
  return (
    <Text size="sm">
      <RelativeTime at={at} />
    </Text>
  )
}

/** One signature: its first line, its count, and its sample on demand. */
function ErrorItem({ row, role, locale, busy }: { row: ErrorRow; role: Role; locale: string; busy: string | null }) {
  const isNew = row.markedAt === null
  return (
    <Stack gap="xs">
      <ListRow tone={isNew ? 'attention' : 'off'} title={row.message} note={text(locale, 'times', { count: row.count })} noteTone={isNew ? 'attention' : undefined} />
      <Collapsible title={text(locale, 'details')}>
        <Stack gap="xs">
          <LabelledRow label={text(locale, 'firstSeen')}>
            <Time at={row.firstSeen} />
          </LabelledRow>
          <LabelledRow label={text(locale, 'lastSeen')}>
            <Time at={row.lastSeen} />
          </LabelledRow>
          {row.markedAt === null ? null : (
            <LabelledRow label={text(locale, 'markedAt')}>
              <Time at={row.markedAt} />
            </LabelledRow>
          )}
          <LabelledRow label={text(locale, 'logger')}>{row.logger ?? text(locale, 'noLogger')}</LabelledRow>
          <Text size="sm" muted>
            {text(locale, 'frames')}
          </Text>
          {row.frames.length === 0 ? (
            <Text size="sm" muted>
              {text(locale, 'noFrames')}
            </Text>
          ) : (
            row.frames.map((frame, index) => <FrameLine key={`frame-${index}`} frame={frame} locale={locale} onOpen={() => openFrame(role, row.signature, index)} />)
          )}
          {row.frames.some((frame) => !frame.openable) ? (
            <Text size="sm" muted>
              {text(locale, 'frameNotInWorkspace')}
            </Text>
          ) : null}
          <Actions>
            {isNew ? (
              <Button size="sm" variant="outline" icon="check" disabled={busy !== null} onPress={() => mark(role, [row.signature], `mark:${row.signature}`)}>
                {text(locale, 'mark')}
              </Button>
            ) : (
              <Button size="sm" variant="outline" icon="delete" disabled={busy !== null} onPress={() => forget(role, row.signature)}>
                {text(locale, 'forget')}
              </Button>
            )}
          </Actions>
        </Stack>
      </Collapsible>
    </Stack>
  )
}

function Reading({ answer, locale, busy }: { answer: RoleErrors; locale: string; busy: string | null }) {
  const reading = answer.reading || busy === 'refresh'
  const ready = answer.state === 'ready'
  return (
    <Group title={text(locale, 'readGroup')}>
      <LabelledRow label={text(locale, 'lastRead')}>{answer.lastRead === null ? text(locale, 'neverRead') : <Time at={answer.lastRead} />}</LabelledRow>
      <LabelledRow label={text(locale, 'timer')}>
        {answer.role !== 'sandbox' ? text(locale, 'byHand') : answer.intervalMinutes > 0 ? text(locale, 'timerEvery', { minutes: answer.intervalMinutes }) : text(locale, 'timerOff')}
      </LabelledRow>
      {answer.role === 'sandbox' && answer.intervalMinutes === 0 ? (
        <Text size="sm" muted>
          {text(locale, 'timerHint')}
        </Text>
      ) : null}
      {ready ? (
        <Actions>
          <Button size="sm" variant="solid" icon="refresh" tooltip={text(locale, 'readNowTooltip')} disabled={reading || busy !== null} onPress={() => refresh(answer.role)}>
            {reading ? text(locale, 'reading') : text(locale, 'readNow')}
          </Button>
        </Actions>
      ) : null}
    </Group>
  )
}

function ErrorsView({ answer, failure, locale, busy }: { answer: RoleErrors | undefined; failure: string | undefined; locale: string; busy: string | null }) {
  const role = currentRole()
  const roleName = text(locale, ROLE_KEYS[role])
  const known = read(answers)
  const problem = read(openProblem)
  const picker = (
    <Select
      key="role"
      label={text(locale, 'environment')}
      value={role}
      options={ROLES.map((value) => {
        const name = text(locale, ROLE_KEYS[value])
        const count = known[value]?.rows.filter((row) => row.markedAt === null).length ?? 0
        return { value, label: count > 0 ? text(locale, 'roleOption', { role: name, count }) : name }
      })}
      onChange={pick}
    />
  )
  if (!answer) {
    return (
      <Stack gap="md">
        {picker}
        <ErrorState title={text(locale, 'readFailedTitle')} message={wordError(locale, failure ?? 'action_failed')} retryLabel={t(messages, locale, 'readNow')} onRetry={() => load(role)} />
      </Stack>
    )
  }
  const fresh = answer.rows.filter((row) => row.markedAt === null)
  const seen = answer.rows.filter((row) => row.markedAt !== null)
  const blocks: OrcaNode[] = [picker, <Reading key="reading" answer={answer} locale={locale} busy={busy} />]
  if (failure) blocks.push(<ErrorState key="failure" title={text(locale, 'readFailedTitle')} message={wordError(locale, failure)} retryLabel={text(locale, 'readNow')} onRetry={() => load(role)} busy={busy !== null} />)
  if (answer.state !== 'ready') {
    blocks.push(<Empty key="not-ready" icon="warning" title={text(locale, 'notReadyTitle', { role: roleName })} guidance={text(locale, 'notReadyBody')} />)
  } else if (answer.error) {
    blocks.push(<ErrorState key="error" title={text(locale, 'readFailedTitle')} message={wordError(locale, answer.error)} retryLabel={text(locale, 'readNow')} onRetry={() => refresh(role)} busy={busy !== null || answer.reading} />)
  }
  if (answer.missedSince !== null && answer.state === 'ready') {
    blocks.push(
      <Callout key="missed" tone="warning" icon="warning" title={text(locale, 'missedTitle')}>
        <Text>{text(locale, 'missedBody', { time: formatTime(answer.missedSince, locale) })}</Text>
      </Callout>
    )
  }
  if (problem) blocks.push(<ErrorState key="open" title={text(locale, 'openFailedTitle')} message={text(locale, openFailureKey(problem))} />)
  if (answer.rows.length === 0) {
    if (answer.state === 'ready') blocks.push(<Empty key="none" icon="check" title={text(locale, 'noneTitle')} guidance={text(locale, role === 'sandbox' ? 'noneGuidanceSandbox' : 'noneGuidanceOther')} />)
  } else {
    blocks.push(
      <Group
        key="new"
        title={text(locale, 'newGroup')}
        action={
          fresh.length > 1 ? (
            <Button size="sm" variant="outline" icon="check" disabled={busy !== null} onPress={() => mark(role, fresh.map((row) => row.signature), 'mark-all')}>
              {text(locale, 'markAll')}
            </Button>
          ) : undefined
        }
      >
        {fresh.length === 0 ? (
          <Text size="sm" muted>
            {text(locale, 'allSeen')}
          </Text>
        ) : (
          fresh.map((row) => <ErrorItem key={row.signature} row={row} role={role} locale={locale} busy={busy} />)
        )}
      </Group>
    )
    if (seen.length > 0) {
      blocks.push(
        <Group key="seen" title={text(locale, 'seenGroup')}>
          {seen.map((row) => (
            <ErrorItem key={row.signature} row={row} role={role} locale={locale} busy={busy} />
          ))}
        </Group>
      )
    }
  }
  return <Stack gap="md">{blocks}</Stack>
}

export const section: PanelSection = {
  id: 'errors',
  icon: 'bug',
  title: (locale) => t(messages, locale, 'title'),
  delivered: true,
  hasView: true,
  setup(ctx: PanelContext) {
    ctx.subscriptions.push(
      plugin.on('errors.changed', ({ role }) => {
        // The environment on screen is asked again; another one, when it is next picked.
        if (role === currentRole()) void load(role)
        else update(answers, (previous) => ({ ...previous, [role]: undefined }))
      })
    )
    void load(currentRole())
  },
  render(locale) {
    const role = currentRole()
    const answer = read(answers)[role]
    const failure = read(failures)[role]
    if (!answer && !failure) return null
    return <ErrorsView answer={answer} failure={failure} locale={locale ?? env.locale} busy={read(pending)} />
  }
}
