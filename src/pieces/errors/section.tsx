// The errors piece's half of the panel, listed in src/panel/sections.ts: per environment, a short
// row per error not yet marked (new) and, folded, per error marked (seen): its count, its first
// line, when it was last seen. Pressing one opens its detail in place of the list, with a way back:
// its state, count and times, its actions, the fields of its first line as labelled rows, its
// message with what masking put in place of a value drawn as code, and its stack trace as frames,
// each one that is a file of the workspace pressable to open it, with *Add breakpoint here*. The
// environments' own state is on the panel's status line; this view only says when the one picked
// cannot be read.
//
// What it shows comes from the worker already masked: the normalised first line, its fields, the
// logger and the top frames of each signature. Never a host, a local path or a raw log entry.
import { atom, Badge, Box, Button, Code, Collapsible, env, IconButton, plugin, read, RelativeTime, Row, Select, Stack, Text, update, type OrcaNode, type PanelContext } from 'orca'
import { t, wordError } from '../../core/i18n'
import { ROLES, isRole, type Role } from '../../core/instances'
import type { PanelSection } from '../../core/piece'
import { openSetup } from '../../panel/navigation'
import { Empty, ErrorState, Group, LabelledRow, ListRow, MaskedText, Notice, NoticeLine, PAGE_SIZE, ShowMore, StateBadge, StateMark } from '../../panel/ui'
import { messages, openFailureKey, ROLE_KEYS, type ErrorsMessageKey } from './i18n'
import { isOlderAnswer, type ErrorFrame, type ErrorRow, type RoleErrors } from './protocol'

/** The environment picked, kept across runs of the plugin. */
const pickedRole = atom<string>('errorsRole', 'sandbox', { persist: 'plugin' })
/** The error whose detail is open, by its signature (a hash, nothing of the log); null for the list. */
const openError = atom<string | null>('errorsDetail', null, { persist: 'plugin' })
/** The last answer for each environment. */
const answers = atom<Partial<Record<Role, RoleErrors>>>({})
/** The code of a request that failed, per environment; the next good answer clears it. */
const failures = atom<Partial<Record<Role, string>>>({})
/** What is being sent now (`refresh`, `mark:<signature>`, `forget:<signature>`), so its button waits. */
const pending = atom<string | null>(null)
/** Why the last frame pressed did not open, worded when drawn. */
const openProblem = atom<string | null>(null)
/** What the last *Add breakpoint here* did: the file's name and line, or why it failed. */
const breakpointNote = atom<{ ok: boolean; text: string } | null>(null)
/** How many new and seen rows are drawn: a long list is paged. */
const shownNew = atom(PAGE_SIZE)
const shownSeen = atom(PAGE_SIZE)
/** Each environment's last answer as JSON, so an answer that changes nothing draws nothing. */
const lastJson: Partial<Record<Role, string>> = {}

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

/** Keeps an answer, unless it shows an older state than the one kept: answers can cross. */
function keep(role: Role, answer: RoleErrors): void {
  if (isOlderAnswer(answer, read(answers)[role])) return
  const json = JSON.stringify(answer)
  if (lastJson[role] !== json) {
    lastJson[role] = json
    update(answers, (previous) => ({ ...previous, [role]: answer }))
  }
  if (read(failures)[role] !== undefined) update(failures, (previous) => ({ ...previous, [role]: undefined }))
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

async function forget(role: Role, signature: string): Promise<void> {
  await act(role, `forget:${signature}`, () => plugin.request('errors.forget', { role, signature }))
  // A forgotten error is gone from the list: its detail closes with it.
  if (read(openError) === signature) update(openError, () => null)
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

/** Puts a breakpoint on a frame's line, in the debugger's store of breakpoints. */
async function addBreakpoint(locale: string, frame: ErrorFrame): Promise<void> {
  if (!frame.path || frame.line === null) return
  update(breakpointNote, () => null)
  const name = `${fileName(frame.path)}:${frame.line}`
  try {
    await plugin.request('debugger.breakpoint', { path: frame.path, line: frame.line, on: true })
    update(breakpointNote, () => ({ ok: true, text: text(locale, 'breakpointAdded', { name }) }))
  } catch {
    // The debugger words why in its own view; here, only that it did not happen.
    update(breakpointNote, () => ({ ok: false, text: text(locale, 'breakpointFailed') }))
  }
}

function pick(value: string): void {
  if (!isRole(value)) return
  update(pickedRole, () => value)
  update(shownNew, () => PAGE_SIZE)
  update(shownSeen, () => PAGE_SIZE)
  update(openError, () => null)
  update(openProblem, () => null)
  update(breakpointNote, () => null)
  void load(value)
}

function showError(signature: string | null): void {
  update(openError, () => signature)
  update(openProblem, () => null)
  update(breakpointNote, () => null)
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

/** The first frame that is a file of the workspace, and its index: where *Open file* goes. */
function topOpenable(row: ErrorRow): { frame: ErrorFrame; index: number } | null {
  const index = row.frames.findIndex((frame) => frame.openable)
  return index < 0 ? null : { frame: row.frames[index], index }
}

// ---------------------------------------------------------------------------------------------
// The list

/** One error as a short row: its state, first line, count and when it was last seen. */
function ErrorListRow({ row, role, locale, busy }: { row: ErrorRow; role: Role; locale: string; busy: string | null }) {
  const isNew = row.markedAt === null
  return (
    <ListRow
      tone={isNew ? 'attention' : 'off'}
      title={row.message}
      detail={
        <Text size="sm" muted truncate>
          <RelativeTime at={row.lastSeen} format="short" />
        </Text>
      }
      note={text(locale, 'times', { count: row.count })}
      noteTone={isNew ? 'attention' : undefined}
      onPress={() => showError(row.signature)}
      actions={
        isNew ? <IconButton icon="check" size="xs" variant="ghost" label={text(locale, 'mark')} disabled={busy !== null} onPress={() => mark(role, [row.signature], `mark:${row.signature}`)} /> : undefined
      }
    />
  )
}

/** When the environment was last read, and whether it is read on a timer, in one muted line. */
function ReadLine({ answer, locale }: { answer: RoleErrors; locale: string }) {
  const timer = answer.role === 'sandbox' && answer.intervalMinutes > 0 ? text(locale, 'timerEvery', { minutes: answer.intervalMinutes }) : text(locale, 'byHand')
  return (
    <Text size="sm" muted truncate>
      {answer.lastRead === null ? text(locale, 'neverRead') : text(locale, 'readAt')} {answer.lastRead === null ? null : <RelativeTime at={answer.lastRead} format="short" />}
      {` · ${timer}`}
    </Text>
  )
}

function ErrorsList({ answer, role, locale, busy }: { answer: RoleErrors; role: Role; locale: string; busy: string | null }) {
  const fresh = answer.rows.filter((row) => row.markedAt === null)
  const seen = answer.rows.filter((row) => row.markedAt !== null)
  const newShown = read(shownNew)
  const seenShown = read(shownSeen)
  const more = (left: number) => text(locale, 'showMore', { count: left })
  const capped = (left: number) => text(locale, 'notShown', { count: left })
  const blocks: OrcaNode[] = []
  if (answer.rows.length === 0) {
    if (answer.state === 'ready') blocks.push(<Empty key="none" icon="check" title={text(locale, 'noneTitle')} guidance={text(locale, role === 'sandbox' ? 'noneGuidanceSandbox' : 'noneGuidanceOther')} />)
    return <Stack gap="md">{blocks}</Stack>
  }
  blocks.push(
    <Group
      key="new"
      title={text(locale, 'newGroup')}
      action={
        fresh.length > 1 ? (
          <Button size="xs" variant="ghost" icon="check" disabled={busy !== null} onPress={() => mark(role, fresh.map((row) => row.signature), 'mark-all')}>
            {text(locale, 'markAll')}
          </Button>
        ) : undefined
      }
    >
      {fresh.length === 0 ? <NoticeLine tone="ok" text={text(locale, 'allSeen')} /> : fresh.slice(0, newShown).map((row) => <ErrorListRow key={row.signature} row={row} role={role} locale={locale} busy={busy} />)}
      <ShowMore shown={newShown} total={fresh.length} label={more} capped={capped} onPress={() => update(shownNew, (shown) => shown + PAGE_SIZE)} />
    </Group>
  )
  if (seen.length > 0) {
    blocks.push(
      <Collapsible key="seen" title={text(locale, 'seenGroup', { count: seen.length })}>
        <Stack gap="xs">
          {seen.slice(0, seenShown).map((row) => (
            <ErrorListRow key={row.signature} row={row} role={role} locale={locale} busy={busy} />
          ))}
          <ShowMore shown={seenShown} total={seen.length} label={more} capped={capped} onPress={() => update(shownSeen, (shown) => shown + PAGE_SIZE)} />
        </Stack>
      </Collapsible>
    )
  }
  return <Stack gap="md">{blocks}</Stack>
}

// ---------------------------------------------------------------------------------------------
// The detail of one error

/**
 * One frame of the trace: its function, then its file and line as code. A frame of a script of the
 * workspace stands out, its name a link that opens the file at its line, with *Add breakpoint
 * here*; a frame of the platform, or of a script elsewhere, is muted.
 */
function FrameRow({ frame, index, row, role, locale }: { frame: ErrorFrame; index: number; row: ErrorRow; role: Role; locale: string }) {
  const where = frame.line === null ? `${frame.file} · ${text(locale, 'frameNoLine')}` : `${frame.file}:${frame.line}`
  const name = frame.function ?? fileName(frame.file)
  const local = frame.openable
  return (
    <Row justify="between" align="start" gap="sm">
      <Row align="start" gap="sm">
        <StateMark tone={local ? 'ok' : 'off'} label={name} />
        <Stack gap="none">
          {local ? (
            <Text weight="medium">{name}</Text>
          ) : (
            <Text muted>{name}</Text>
          )}
          <Text size="sm" muted>
            <Code>{where}</Code>
          </Text>
        </Stack>
      </Row>
      {local ? (
        <Row align="center" gap="none">
          <IconButton icon="open-external" size="xs" variant="ghost" label={text(locale, 'openFile')} onPress={() => openFrame(role, row.signature, index)} />
          <IconButton icon="flag" size="xs" variant="ghost" label={text(locale, 'addBreakpoint')} disabled={!frame.path || frame.line === null} onPress={() => addBreakpoint(locale, frame)} />
        </Row>
      ) : null}
    </Row>
  )
}

function ErrorDetail({ row, role, locale, busy }: { row: ErrorRow; role: Role; locale: string; busy: string | null }) {
  const isNew = row.markedAt === null
  const top = topOpenable(row)
  const fields: [ErrorsMessageKey, string | null][] = [
    ['pipeline', row.pipeline],
    ['logger', row.logger],
    ['level', row.level]
  ]
  const known = fields.filter((field): field is [ErrorsMessageKey, string] => field[1] !== null && field[1] !== '')
  return (
    <Stack gap="md">
      <Row align="center" gap="xs">
        <IconButton icon="collapse" size="sm" variant="ghost" label={text(locale, 'back')} onPress={() => showError(null)} />
        <Text weight="semibold" truncate>
          {text(locale, ROLE_KEYS[role])}
        </Text>
      </Row>
      <Stack gap="xs">
        <Row align="center" gap="xs" wrap>
          <StateBadge tone={isNew ? 'attention' : 'off'}>{text(locale, isNew ? 'stateNew' : 'stateSeen')}</StateBadge>
          <Badge tone={isNew ? 'warning' : 'neutral'}>{text(locale, 'times', { count: row.count })}</Badge>
        </Row>
        <LabelledRow label={text(locale, 'lastSeen')}>
          <Text>
            <RelativeTime at={row.lastSeen} />
          </Text>
        </LabelledRow>
        <LabelledRow label={text(locale, 'firstSeen')}>
          <Text>
            <RelativeTime at={row.firstSeen} />
          </Text>
        </LabelledRow>
        {row.markedAt === null ? null : (
          <LabelledRow label={text(locale, 'markedAt')}>
            <Text>
              <RelativeTime at={row.markedAt} />
            </Text>
          </LabelledRow>
        )}
        <Row gap="xs" wrap>
          {isNew ? (
            <Button size="xs" variant="solid" icon="check" disabled={busy !== null} onPress={() => mark(role, [row.signature], `mark:${row.signature}`)}>
              {text(locale, 'mark')}
            </Button>
          ) : (
            <Button size="xs" variant="outline" icon="delete" disabled={busy !== null} onPress={() => forget(role, row.signature)}>
              {text(locale, 'forget')}
            </Button>
          )}
          {top ? (
            <Button size="xs" variant="outline" icon="open-external" onPress={() => openFrame(role, row.signature, top.index)}>
              {text(locale, 'openFile')}
            </Button>
          ) : null}
          {top?.frame.path && top.frame.line !== null ? (
            <Button size="xs" variant="outline" icon="flag" onPress={() => addBreakpoint(locale, top.frame)}>
              {text(locale, 'addBreakpoint')}
            </Button>
          ) : null}
        </Row>
      </Stack>
      <Group title={text(locale, 'message')}>
        <MaskedText text={row.message} />
      </Group>
      {known.length > 0 ? (
        <Group title={text(locale, 'where')}>
          {known.map(([key, value]) => (
            <LabelledRow key={key} label={text(locale, key)}>
              <MaskedText text={value} size="sm" />
            </LabelledRow>
          ))}
        </Group>
      ) : null}
      <Group title={text(locale, 'stack')}>
        {row.frames.length === 0 ? (
          <Text size="sm" muted>
            {text(locale, 'noFrames')}
          </Text>
        ) : (
          row.frames.map((frame, index) => <FrameRow key={`frame-${index}`} frame={frame} index={index} row={row} role={role} locale={locale} />)
        )}
      </Group>
    </Stack>
  )
}

// ---------------------------------------------------------------------------------------------
// The view

function ErrorsView({ answer, failure, locale, busy }: { answer: RoleErrors | undefined; failure: string | undefined; locale: string; busy: string | null }) {
  const role = currentRole()
  const roleName = text(locale, ROLE_KEYS[role])
  const known = read(answers)
  const problem = read(openProblem)
  const note = read(breakpointNote)
  const reading = (answer?.reading ?? false) || busy === 'refresh'
  const picker = (
    <Row key="role" align="center" gap="xs">
      <Box grow>
        <Select
          label={text(locale, 'environment')}
          labelHidden
          value={role}
          options={ROLES.map((value) => {
            const name = text(locale, ROLE_KEYS[value])
            const count = known[value]?.rows.filter((row) => row.markedAt === null).length ?? 0
            return { value, label: count > 0 ? text(locale, 'roleOption', { role: name, count }) : name }
          })}
          onChange={pick}
        />
      </Box>
      {answer?.state === 'ready' ? (
        <Button size="sm" variant="solid" icon="refresh" disabled={reading || busy !== null} onPress={() => refresh(role)}>
          {reading ? text(locale, 'reading') : text(locale, 'readNow')}
        </Button>
      ) : null}
    </Row>
  )
  if (!answer) {
    return (
      <Stack gap="md">
        {picker}
        <ErrorState title={text(locale, 'readFailedTitle')} message={wordError(locale, failure ?? 'action_failed')} retryLabel={text(locale, 'retry')} onRetry={() => load(role)} />
      </Stack>
    )
  }
  const detail = answer.rows.find((row) => row.signature === read(openError)) ?? null
  const blocks: OrcaNode[] = []
  if (failure) blocks.push(<ErrorState key="failure" title={text(locale, 'readFailedTitle')} message={wordError(locale, failure)} retryLabel={text(locale, 'retry')} onRetry={() => load(role)} busy={busy !== null} />)
  if (problem) blocks.push(<Notice key="open" tone="failed" title={text(locale, 'openFailedTitle')} detail={text(locale, openFailureKey(problem))} action={{ label: text(locale, 'dismiss'), icon: 'close', onPress: () => update(openProblem, () => null) }} />)
  if (note) blocks.push(<NoticeLine key="breakpoint" tone={note.ok ? 'ok' : 'failed'} text={note.text} action={{ label: text(locale, 'dismiss'), icon: 'close', onPress: () => update(breakpointNote, () => null) }} />)
  if (detail) {
    blocks.push(<ErrorDetail key={`detail-${detail.signature}`} row={detail} role={role} locale={locale} busy={busy} />)
    return <Stack gap="md">{blocks}</Stack>
  }
  blocks.unshift(picker, <ReadLine key="read" answer={answer} locale={locale} />)
  if (answer.state !== 'ready') {
    blocks.push(<NoticeLine key="not-ready" tone="attention" text={text(locale, 'notReady', { role: roleName })} action={{ label: text(locale, 'openSetup'), icon: 'settings', onPress: openSetup }} />)
  } else if (answer.error) {
    blocks.push(<ErrorState key="error" title={text(locale, 'readFailedTitle')} message={wordError(locale, answer.error)} retryLabel={text(locale, 'retry')} onRetry={() => refresh(role)} busy={busy !== null || answer.reading} />)
  }
  if (answer.missedSince !== null && answer.state === 'ready') blocks.push(<NoticeLine key="missed" tone="attention" text={text(locale, 'missed', { time: formatTime(answer.missedSince, locale) })} />)
  blocks.push(<ErrorsList key="list" answer={answer} role={role} locale={locale} busy={busy} />)
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
        else {
          delete lastJson[role]
          update(answers, (previous) => ({ ...previous, [role]: undefined }))
        }
      })
    )
    for (const role of ROLES) delete lastJson[role]
    void load(currentRole())
  },
  render(locale) {
    const role = currentRole()
    const answer = read(answers)[role]
    const failure = read(failures)[role]
    if (!answer && !failure) return null
    return <ErrorsView answer={answer} failure={failure} locale={locale ?? env.locale} busy={read(pending)} />
  },
  reset: resetErrorsView
}

/** Closes what is open in the view: an error's detail, the pages of rows drawn, its notes. */
export function resetErrorsView(): void {
  update(openError, () => null)
  update(shownNew, () => PAGE_SIZE)
  update(shownSeen, () => PAGE_SIZE)
  update(openProblem, () => null)
  update(breakpointNote, () => null)
}
