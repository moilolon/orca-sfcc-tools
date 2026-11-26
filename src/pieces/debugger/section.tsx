// The debugger piece's view, listed in src/panel/sections.ts: the session and its state, the
// breakpoints of the debugged workspace, and, while a request is halted, its threads, call stack,
// scopes and variables (read when opened, never kept), an expression to evaluate, and continue and
// step. Built only from src/panel/ui.tsx and Orca's components. Every text that came from b2c was
// masked by the worker; this view never sees a host or an absolute path.
import { atom, Box, Button, Callout, IconButton, Input, plugin, read, Row, Select, set, Stack, Text, Tree, type OrcaNode, type PanelContext, type TreeItem } from 'orca'
import { t, wordError } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { Actions, Empty, ErrorState, Group, LabelledRow, ListRow, StateBadge, type StateTone } from '../../panel/ui'
import { messages, type MessageKey } from './i18n'
import type { BreakpointView, DebuggerState, Frame, SessionStatus, StepKind, Thread } from './protocol'

const state = atom<DebuggerState | null>(null)
/** The code of the last request that failed; the next one that succeeds clears it. */
const problem = atom<string | null>(null)
const busy = atom(false)
const query = atom('')
const matches = atom<{ files: string[]; truncated: boolean } | null>(null)
const picked = atom<string | null>(null)
const lineText = atom('')
const frameId = atom<number | null>(null)
/** The variables read so far, by tree key; dropped when the request moves on. */
type VariableNode = { label: string; description?: string; reference: number; children?: string[] }
const nodes = atom<Record<string, VariableNode>>({})
const scopes = atom<string[] | null>(null)
const expanded = atom<string[]>([])
const expression = atom('')
const result = atom<string | null>(null)
/** Which halt the variables belong to: thread and top frame. */
let haltKey = ''
let searchSeq = 0
let locale = 'en'

/** At most this much of a value is drawn; the rest is cut. */
const MAX_VALUE = 400

const STATUS: Record<SessionStatus, { key: MessageKey; tone: StateTone }> = {
  idle: { key: 'status.idle', tone: 'off' },
  connecting: { key: 'status.connecting', tone: 'busy' },
  attached: { key: 'status.attached', tone: 'ok' },
  halted: { key: 'status.halted', tone: 'attention' },
  ended: { key: 'status.ended', tone: 'off' },
  failed: { key: 'status.failed', tone: 'failed' }
}

const HINTS: Partial<Record<SessionStatus, MessageKey>> = {
  idle: 'idleHint',
  connecting: 'connectingHint',
  attached: 'attachedHint',
  halted: 'haltedHint',
  ended: 'endedHint'
}

function text(key: MessageKey, vars?: Record<string, string | number>): string {
  return t(messages, locale, key, vars)
}

/** A code worded: the piece's own `reason.*` text, else core's error text. */
export function wordReason(at: string, code: string): string {
  const key = `reason.${code}`
  return key in messages.en ? t(messages, at, key as MessageKey) : wordError(at, code)
}

function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'action_failed'
}

const isRunning = (status: SessionStatus) => status === 'connecting' || status === 'attached' || status === 'halted'

/** Runs a request; its failure is kept as `problem`, its success clears it. */
async function act<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    const answer = await work()
    set(problem, null)
    return answer
  } catch (error) {
    set(problem, codeOf(error))
    return undefined
  }
}

function resetVariables(): void {
  set(nodes, {})
  set(scopes, null)
  set(expanded, [])
  set(result, null)
}

/** A new state from the worker: on a new halt, the top frame is picked and its scopes read. */
function apply(next: DebuggerState): void {
  set(state, next)
  const key = next.status === 'halted' && next.frames.length > 0 ? `${next.threadId}:${next.frames[0].id}:${next.frames[0].line}` : ''
  if (key === haltKey) return
  haltKey = key
  resetVariables()
  set(frameId, key ? next.frames[0].id : null)
  if (key) void loadScopes(next.frames[0].id)
}

async function refresh(): Promise<void> {
  const answer = await act(() => plugin.request('debugger.state', {}))
  if (answer) apply(answer)
}

async function start(): Promise<void> {
  set(busy, true)
  const answer = await act(() => plugin.request('debugger.start', {}))
  if (answer) apply(answer)
  set(busy, false)
}

async function stop(): Promise<void> {
  set(busy, true)
  const answer = await act(() => plugin.request('debugger.stop', {}, { timeoutMs: 60_000 }))
  if (answer) apply(answer)
  set(busy, false)
}

async function step(kind: StepKind): Promise<void> {
  const answer = await act(() => plugin.request('debugger.step', { kind }))
  if (answer) apply(answer)
}

async function setLines(path: string, lines: number[]): Promise<void> {
  const answer = await act(() => plugin.request('debugger.setBreakpoints', { path, lines }))
  if (answer) apply(answer)
}

async function clearAll(): Promise<void> {
  const answer = await act(() => plugin.request('debugger.clearBreakpoints', {}))
  if (answer) apply(answer)
}

async function search(value: string): Promise<void> {
  set(query, value)
  const seq = ++searchSeq
  if (!value.trim()) {
    set(matches, null)
    set(picked, null)
    return
  }
  const answer = await act(() => plugin.request('debugger.files', { query: value }))
  if (!answer || seq !== searchSeq) return
  set(matches, answer)
  const current = read(picked)
  if (!current || !answer.files.includes(current)) set(picked, answer.files[0] ?? null)
}

async function addBreakpoint(): Promise<void> {
  const path = read(picked)
  const line = Number(read(lineText).trim())
  if (!path || !Number.isInteger(line) || line < 1) {
    set(problem, 'invalid_input')
    return
  }
  const existing = read(state)?.breakpoints.find((file) => file.path === path)?.lines.map((each) => each.line) ?? []
  await setLines(path, [...existing, line])
  if (!read(problem)) set(lineText, '')
}

async function open(input: { frameId?: number; path?: string; line?: number }): Promise<void> {
  await act(() => plugin.request('debugger.open', input))
}

async function selectThread(thread: Thread): Promise<void> {
  const frames = await act(() => plugin.request('debugger.stack', { threadId: thread.id }))
  if (!frames) return
  resetVariables()
  const top = frames[0]
  set(frameId, top ? top.id : null)
  if (top) void loadScopes(top.id)
}

async function selectFrame(frame: Frame): Promise<void> {
  if (read(frameId) !== frame.id) {
    resetVariables()
    set(frameId, frame.id)
    void loadScopes(frame.id)
  }
  if (frame.path) await open({ frameId: frame.id })
}

function cutValue(value: string): string {
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value
}

async function loadScopes(id: number): Promise<void> {
  const answer = await act(() => plugin.request('debugger.variables', { frameId: id }))
  if (!answer || read(frameId) !== id) return
  const next: Record<string, VariableNode> = {}
  const keys = answer.map((scope, i) => {
    const key = `f${id}/${i}`
    next[key] = { label: scope.name, reference: scope.reference }
    return key
  })
  set(nodes, next)
  set(scopes, keys)
}

/** Opening a scope or a variable reads its children, once; closing it only folds it. */
async function toggle(key: string, open: boolean): Promise<void> {
  const list = read(expanded)
  set(expanded, open ? [...list.filter((each) => each !== key), key] : list.filter((each) => each !== key))
  const node = read(nodes)[key]
  if (!open || !node || node.children || node.reference <= 0) return
  const answer = await act(() => plugin.request('debugger.variables', { reference: node.reference }))
  if (!answer) return
  const current = { ...read(nodes) }
  if (!current[key]) return
  const children = answer.map((variable, i) => {
    const child = `${key}/${i}`
    current[child] = { label: variable.name, description: cutValue(variable.value), reference: variable.reference }
    return child
  })
  current[key] = { ...current[key], children }
  set(nodes, current)
}

async function evaluate(): Promise<void> {
  const value = read(expression).trim()
  if (!value) return
  const answer = await act(() => plugin.request('debugger.evaluate', { expression: value, frameId: read(frameId) ?? undefined }))
  set(result, answer ? cutValue(answer.result) : null)
}

/** The tree items under `keys`, as far as they were read. */
function treeItems(keys: readonly string[], all: Record<string, VariableNode>, depth = 0): TreeItem[] {
  return keys.flatMap((key): TreeItem[] => {
    const node = all[key]
    if (!node) return []
    const item: TreeItem = { key, label: node.label, description: node.description }
    if (node.children && depth < 48) return [{ ...item, children: treeItems(node.children, all, depth + 1) }]
    return [{ ...item, hasChildren: node.reference > 0 }]
  })
}

/**
 * Each path as short as it can be told apart from the other files with breakpoints: `Page.js`,
 * or `app_one/…/Page.js` when two cartridges have one.
 */
export function shortNames(paths: readonly string[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const path of paths) {
    const parts = path.split('/')
    let take = 1
    while (take < parts.length && paths.some((other) => other !== path && other.split('/').slice(-take).join('/') === parts.slice(-take).join('/'))) take += 1
    // The part that tells it apart, then the file's own name: `app_one/…/Page.js`.
    names[path] = take <= 2 ? parts.slice(-take).join('/') : `${parts[parts.length - take]}/…/${parts[parts.length - 1]}`
  }
  return names
}

function verifiedOf(verified: boolean | null): { tone: StateTone; note: MessageKey } {
  if (verified === true) return { tone: 'ok', note: 'verified' }
  if (verified === false) return { tone: 'attention', note: 'notVerified' }
  return { tone: 'off', note: 'saved' }
}

function SessionGroup({ current, working }: { current: DebuggerState; working: boolean }) {
  const status = STATUS[current.status]
  const hint = HINTS[current.status]
  const ready = current.sandbox === 'ready'
  return (
    <Group title={text('session')}>
      <LabelledRow label={text('state')}>
        <StateBadge tone={status.tone}>{text(status.key)}</StateBadge>
      </LabelledRow>
      {ready ? null : (
        <Callout tone="warning" icon="warning" title={text('sandboxNotReadyTitle')}>
          <Text>{text('sandboxNotReadyBody')}</Text>
        </Callout>
      )}
      {current.status === 'failed' ? (
        <ErrorState
          title={text('failedTitle')}
          message={[wordReason(locale, current.reason ?? 'start_failed'), current.message ?? ''].filter(Boolean).join(' ')}
          retryLabel={ready ? text('startAgain') : undefined}
          onRetry={ready ? () => void start() : undefined}
          busy={working}
        />
      ) : current.status === 'ended' && current.reason ? (
        <Text size="sm" muted>
          {[wordReason(locale, current.reason), current.message ?? ''].filter(Boolean).join(' ')}
        </Text>
      ) : hint ? (
        <Text size="sm" muted>
          {text(hint)}
        </Text>
      ) : null}
      <Actions>
        {isRunning(current.status) ? (
          <Button size="sm" variant="outline" icon="stop" disabled={working} onPress={() => void stop()}>
            {text('stop')}
          </Button>
        ) : current.status === 'failed' ? null : (
          <Button size="sm" variant="solid" icon="bug" tooltip={text('startTooltip')} disabled={working || !ready} onPress={() => void start()}>
            {text('start')}
          </Button>
        )}
      </Actions>
    </Group>
  )
}

function Paused() {
  return (
    <Group title={text('paused')}>
      <Actions>
        <Button size="sm" variant="solid" icon="play" tooltip={text('continueTooltip')} onPress={() => void step('continue')}>
          {text('continue')}
        </Button>
        <Button size="sm" variant="outline" icon="next" onPress={() => void step('over')}>
          {text('stepOver')}
        </Button>
        <Button size="sm" variant="outline" icon="expand" onPress={() => void step('in')}>
          {text('stepIn')}
        </Button>
        <Button size="sm" variant="outline" icon="collapse" onPress={() => void step('out')}>
          {text('stepOut')}
        </Button>
      </Actions>
    </Group>
  )
}

function Threads({ current }: { current: DebuggerState }) {
  if (current.threads.length < 2) return null
  return (
    <Group title={text('threads')}>
      {current.threads.map((thread) => (
        <ListRow
          key={`thread-${thread.id}`}
          tone={thread.halted ? 'attention' : 'busy'}
          title={thread.name}
          note={text(thread.halted ? 'threadHalted' : 'threadRunning')}
          current={thread.id === current.threadId}
          onPress={thread.halted ? () => void selectThread(thread) : undefined}
        />
      ))}
    </Group>
  )
}

function CallStack({ current }: { current: DebuggerState }) {
  const selected = read(frameId)
  return (
    <Group title={text('callStack')}>
      {current.frames.length === 0 ? (
        <Text size="sm" muted>
          {text('noFrames')}
        </Text>
      ) : (
        current.frames.map((frame) => (
          <ListRow
            key={`frame-${frame.id}`}
            tone={frame.id === selected ? 'attention' : 'off'}
            title={frame.name || frame.file}
            note={`${frame.file}:${frame.line}`}
            current={frame.id === selected}
            onPress={() => void selectFrame(frame)}
          />
        ))
      )}
    </Group>
  )
}

function Variables() {
  const keys = read(scopes)
  const all = read(nodes)
  return (
    <Group title={text('variables')}>
      {keys === null ? null : keys.length === 0 ? (
        <Text size="sm" muted>
          {text('noScopes')}
        </Text>
      ) : (
        <Tree label={text('variables')} items={treeItems(keys, all)} expanded={read(expanded)} maxHeight="md" onToggle={(item) => void toggle(item.key, item.expanded)} />
      )}
      <Text size="sm" muted>
        {text('variablesHint')}
      </Text>
    </Group>
  )
}

function Evaluate() {
  const answer = read(result)
  return (
    <Group title={text('evaluate')}>
      <Input
        label={text('expression')}
        labelHidden
        placeholder={text('expressionPlaceholder')}
        value={read(expression)}
        maxLength={2000}
        onChange={(value) => set(expression, value)}
        onSubmit={() => void evaluate()}
      />
      <Actions>
        <Button size="sm" variant="outline" icon="play" disabled={!read(expression).trim()} onPress={() => void evaluate()}>
          {text('evaluate')}
        </Button>
      </Actions>
      {answer === null ? null : (
        <Stack gap="xs">
          <Text size="sm" muted>
            {text('result')}
          </Text>
          <Text>{answer}</Text>
        </Stack>
      )}
    </Group>
  )
}

function BreakpointRow({ file, line, verified, name }: { file: BreakpointView; line: number; verified: boolean | null; name: string }) {
  const { tone, note } = verifiedOf(verified)
  const title = `${name}:${line}`
  return (
    <Row align="center" gap="xs">
      <Box grow>
        <ListRow tone={tone} title={title} note={text(note)} noteTone={tone} onPress={() => void open({ path: file.path, line })} />
      </Box>
      <IconButton
        icon="delete"
        size="sm"
        variant="ghost"
        label={text('remove', { name: title })}
        onPress={() =>
          void setLines(
            file.path,
            file.lines.map((each) => each.line).filter((each) => each !== line)
          )
        }
      />
    </Row>
  )
}

function Breakpoints({ current }: { current: DebuggerState }) {
  const files = current.breakpoints
  const names = shortNames(files.map((file) => file.path))
  const unverified = files.some((file) => file.lines.some((each) => each.verified === false))
  return (
    <Group
      title={text('breakpoints')}
      action={
        files.length > 0 ? (
          <Button size="xs" variant="ghost" icon="delete" onPress={() => void clearAll()}>
            {text('removeAll')}
          </Button>
        ) : undefined
      }
    >
      {files.length === 0 ? (
        <Empty title={text('noBreakpointsTitle')} guidance={text('noBreakpointsBody')} icon="flag" />
      ) : (
        files.flatMap((file) => file.lines.map((each) => <BreakpointRow key={`bp-${file.path}:${each.line}`} file={file} line={each.line} verified={each.verified} name={names[file.path] ?? file.path} />))
      )}
      {unverified ? (
        <Text size="sm" muted>
          {text('notVerifiedHint')}
        </Text>
      ) : null}
    </Group>
  )
}

function AddBreakpoint() {
  const found = read(matches)
  const file = read(picked)
  return (
    <Group title={text('addBreakpoint')}>
      <Input label={text('findFile')} placeholder={text('findFilePlaceholder')} type="search" value={read(query)} maxLength={200} onChange={(value) => void search(value)} />
      {found && found.files.length > 0 ? (
        <Select label={text('file')} placeholder={text('pickFile')} value={file ?? undefined} options={found.files.map((path) => ({ value: path, label: path }))} onChange={(value) => set(picked, value)} />
      ) : null}
      {found && found.files.length === 0 ? (
        <Text size="sm" muted>
          {text('noMatches')}
        </Text>
      ) : null}
      {found?.truncated ? (
        <Text size="sm" muted>
          {text('moreMatches')}
        </Text>
      ) : null}
      <Input label={text('line')} placeholder="1" value={read(lineText)} maxLength={7} onChange={(value) => set(lineText, value)} onSubmit={() => void addBreakpoint()} />
      <Actions>
        <Button size="sm" variant="outline" icon="add" disabled={!file || !read(lineText).trim()} onPress={() => void addBreakpoint()}>
          {text('add')}
        </Button>
      </Actions>
    </Group>
  )
}

function View({ current }: { current: DebuggerState }): OrcaNode {
  if (current.workspace === 'none') return <Empty title={text('noWorkspaceTitle')} guidance={text('noWorkspaceBody')} icon="bug" />
  if (current.workspace === 'remote') return <Empty title={text('remoteWorkspaceTitle')} guidance={text('remoteWorkspaceBody')} icon="bug" />
  const failure = read(problem)
  const halted = current.status === 'halted'
  return (
    <Stack gap="md">
      <SessionGroup current={current} working={read(busy)} />
      {failure ? <ErrorState title={text('requestFailed')} message={wordReason(locale, failure)} /> : null}
      {halted ? <Paused /> : null}
      {halted ? <Threads current={current} /> : null}
      {halted ? <CallStack current={current} /> : null}
      {halted ? <Variables /> : null}
      {halted ? <Evaluate /> : null}
      <Breakpoints current={current} />
      <AddBreakpoint />
    </Stack>
  )
}

export const section: PanelSection = {
  id: 'debugger',
  icon: 'bug',
  title: (at) => t(messages, at, 'title'),
  delivered: true,
  hasView: true,
  setup(ctx: PanelContext) {
    haltKey = ''
    ctx.subscriptions.push(plugin.on('debugger.state', (next) => apply(next)))
    void refresh()
  },
  render(at) {
    locale = at
    const current = read(state)
    return current ? <View current={current} /> : null
  }
}
