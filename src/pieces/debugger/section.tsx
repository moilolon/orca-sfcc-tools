// The debugger piece's view, listed in src/panel/sections.ts: the session and its state; while a
// request is halted, continue and step, its threads, call stack (each frame with *Add breakpoint
// here*), scopes and variables (read when opened, never kept) and an expression to evaluate; the
// breakpoints of the debugged workspace; and its scripts, by cartridge or by search, where opening
// one shows its lines and a click on a line sets or removes a breakpoint there. Built only from
// src/panel/ui.tsx and Orca's components. Every text that came from b2c, and every line of a
// script, was masked by the worker; this view never sees a host or an absolute path.
import {
  atom,
  Box,
  Button,
  Code,
  Collapsible,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  set,
  Stack,
  Table,
  Text,
  Tree,
  type OrcaNode,
  type PanelContext,
  type TableRow,
  type TreeItem
} from 'orca'
import { languageOf, t, wordError } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { openSetup } from '../../panel/navigation'
import { Empty, ErrorState, Group, ListRow, memo, Notice, NoticeLine, PAGE_SIZE, ShowMore, StateMark, type StateTone } from '../../panel/ui'
import { messages, type MessageKey } from './i18n'
import type { BreakpointView, DebuggerScripts, DebuggerSource, DebuggerState, Frame, SessionStatus, StepKind, Thread } from './protocol'

/**
 * How many lines of a script the table holds at once: a window moved by page, by a line number or
 * by a search, never a list that grows. 200 lines of 240 characters stay far under a view's budget.
 */
export const WINDOW_LINES = 200

const state = atom<DebuggerState | null>(null)
/** The code of the last request that failed; the next one that succeeds clears it. */
const problem = atom<string | null>(null)
const busy = atom(false)
const frameId = atom<number | null>(null)
/** The variables read so far, by tree key; dropped when the request moves on. */
type VariableNode = { label: string; description?: string; reference: number; children?: string[] }
const nodes = atom<Record<string, VariableNode>>({})
const scopes = atom<string[] | null>(null)
const expanded = atom<string[]>([])
const expression = atom('')
const result = atom<string | null>(null)
/** The scripts of the workspace's cartridges, and why they could not be read. */
const scripts = atom<DebuggerScripts | null>(null)
const scriptsError = atom<string | null>(null)
const scriptQuery = atom('')
/** The cartridges and folders open in the list of scripts, kept across runs by their paths in the workspace. */
const scriptsOpen = atom<string[]>('debuggerScriptsOpen', [], { persist: 'plugin' })
/** The script whose lines are shown, kept across runs by its path in the workspace (never its lines). */
const openScript = atom<string | null>('debuggerScript', null, { persist: 'plugin' })
/**
 * The workspace the open script and open folders belong to: when another one is debugged, they are
 * let go, so a path of one workspace is never opened in another.
 */
const scriptsWorkspace = atom<string | null>('debuggerWorkspace', null, { persist: 'plugin' })
/** Its lines, read when it is opened and never kept beyond this panel run. */
const source = atom<DebuggerSource | null>(null)
const sourceError = atom<string | null>(null)
/** What the lines are filtered by: words, or a line number to go to. */
const lineFilter = atom('')
/** How many lines are drawn while nothing filters them; scrolling to the end draws more. */
const windowStart = atom(1)
/**
 * How many entries each open folder of the list of scripts draws, by its key, past `FOLDER_ENTRIES`
 * once its *more* item was pressed. Not kept: reopening the panel draws each folder's first ones.
 */
const folderShown = atom<Record<string, number>>({})
/** How many breakpoints are drawn: a long list is paged. */
const shownBreakpoints = atom(PAGE_SIZE)

/** How many entries an open folder (or the list of cartridges) draws at first, and adds per press. */
export const FOLDER_ENTRIES = 50
/**
 * The most items the list of scripts holds in all, however many folders are open: well under the
 * 2,000 Orca draws in one Tree and far under a view's budget. Past it, a folder says to search.
 */
export const TREE_ITEMS = 600
/** Which halt the variables belong to: thread and top frame. */
let haltKey = ''
let locale = 'en'

/** At most this many children of a scope or variable are drawn. */
export const MAX_CHILDREN = 200
/** At most this much of a value is drawn; the rest is cut. */
const MAX_VALUE = 400
/** At most this many scripts are listed for a search. */
const MAX_MATCHES = 50

const STATUS: Record<SessionStatus, { key: MessageKey; tone: StateTone; hint?: MessageKey }> = {
  idle: { key: 'status.idle', tone: 'off' },
  connecting: { key: 'status.connecting', tone: 'busy', hint: 'hint.connecting' },
  attached: { key: 'status.attached', tone: 'ok', hint: 'hint.attached' },
  halted: { key: 'status.halted', tone: 'attention', hint: 'hint.halted' },
  ended: { key: 'status.ended', tone: 'off' },
  failed: { key: 'status.failed', tone: 'failed' }
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

/** The last state as JSON, so a post that changes nothing draws nothing. */
let lastJson = ''

/** Another workspace is debugged: what was open in the list of scripts is of the last one. */
function followWorkspace(id: string): void {
  const known = read(scriptsWorkspace) !== null
  set(scriptsWorkspace, id)
  if (!known) return
  set(scriptsOpen, [])
  set(scriptQuery, '')
  closeScript()
  set(scripts, null)
  void loadScripts()
}

/** A new state from the worker: on a new halt, the top frame is picked and its scopes read. */
function apply(next: DebuggerState): void {
  const json = JSON.stringify(next)
  if (json === lastJson) return
  lastJson = json
  set(state, next)
  if (next.workspaceId !== null && read(scriptsWorkspace) !== next.workspaceId) followWorkspace(next.workspaceId)
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

/** Sets or removes one breakpoint, leaving the file's others as they are. */
async function toggleBreakpoint(path: string, line: number, on: boolean): Promise<void> {
  const answer = await act(() => plugin.request('debugger.breakpoint', { path, line, on }))
  if (answer) apply(answer)
}

async function clearAll(): Promise<void> {
  const answer = await act(() => plugin.request('debugger.clearBreakpoints', {}))
  if (answer) apply(answer)
}

async function open(input: { frameId?: number; path?: string; line?: number }): Promise<void> {
  await act(() => plugin.request('debugger.open', input))
}

async function loadScripts(): Promise<void> {
  try {
    set(scripts, await plugin.request('debugger.scripts', {}))
    set(scriptsError, null)
  } catch (error) {
    set(scriptsError, codeOf(error))
  }
}

async function loadSource(path: string): Promise<void> {
  set(source, null)
  set(sourceError, null)
  try {
    const answer = await plugin.request('debugger.source', { path })
    if (read(openScript) === path) set(source, answer)
  } catch (error) {
    if (read(openScript) === path) set(sourceError, codeOf(error))
  }
}

/** Shows a script's lines, at `line` when given. */
function showScript(path: string, line?: number): void {
  set(lineFilter, line ? String(line) : '')
  set(windowStart, 1)
  if (read(openScript) === path && read(source)) return
  set(openScript, path)
  void loadSource(path)
}

function closeScript(): void {
  set(openScript, null)
  set(source, null)
  set(sourceError, null)
  set(lineFilter, '')
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
async function toggle(key: string, isOpen: boolean): Promise<void> {
  const list = read(expanded)
  set(expanded, isOpen ? [...list.filter((each) => each !== key), key] : list.filter((each) => each !== key))
  const node = read(nodes)[key]
  if (!isOpen || !node || node.children || node.reference <= 0) return
  const answer = await act(() => plugin.request('debugger.variables', { reference: node.reference }))
  if (!answer) return
  const current = { ...read(nodes) }
  if (!current[key]) return
  // A scope or an array of thousands: the first MAX_CHILDREN are drawn, then one item that says how
  // many more there are, so opening it never takes the view past its budget.
  const children = answer.slice(0, MAX_CHILDREN).map((variable, i) => {
    const child = `${key}/${i}`
    current[child] = { label: variable.name, description: cutValue(variable.value), reference: variable.reference }
    return child
  })
  if (answer.length > MAX_CHILDREN) {
    const rest = `${key}/more`
    current[rest] = { label: text('moreVariables', { count: answer.length - MAX_CHILDREN }), reference: 0 }
    children.push(rest)
  }
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
function treeItems(keys: readonly string[], all: Record<string, VariableNode>, open: ReadonlySet<string>, depth = 0): TreeItem[] {
  return keys.flatMap((key): TreeItem[] => {
    const node = all[key]
    if (!node) return []
    const item: TreeItem = { key, label: node.label, description: node.description }
    // Only an open item carries its children: what was read and folded again sends nothing. Orca
    // nests a Tree 16 deep at most.
    if (node.children && open.has(key) && depth < 15) return [{ ...item, children: treeItems(node.children, all, open, depth + 1) }]
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

/** The last part of a path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function verifiedOf(verified: boolean | null): { tone: StateTone; note: MessageKey } {
  if (verified === true) return { tone: 'ok', note: 'verified' }
  if (verified === false) return { tone: 'attention', note: 'notVerified' }
  return { tone: 'off', note: 'saved' }
}

/** The lines of `path` that hold a breakpoint now. */
function breakpointLines(current: DebuggerState, path: string): number[] {
  return current.breakpoints.find((file) => file.path === path)?.lines.map((each) => each.line) ?? []
}

// ---------------------------------------------------------------------------------------------
// The list of scripts and a script's lines

/**
 * What a click on a table of lines changed, as the line to set or remove. A plain click selects
 * only the row clicked (`[key]`), so a single key toggles that line; a click with Ctrl adds or
 * drops one row from the selection. Anything else (a range, a cleared selection) changes nothing.
 */
export function toggledLine(before: readonly string[], keys: readonly string[]): string | null {
  if (keys.length === 0) return null
  if (keys.length === 1) return keys[0]
  const was = new Set(before)
  const now = new Set(keys)
  const added = keys.filter((key) => !was.has(key))
  const removed = before.filter((key) => !now.has(key))
  if (added.length === 1 && removed.length === 0) return added[0]
  if (removed.length === 1 && added.length === 0) return removed[0]
  return null
}

/**
 * The lines to draw, at most `size`: those holding every word of `filter` (`matches` says how
 * many hold them in all), or a window opening a few lines before a line number, or the window
 * starting at `start`.
 */
export function visibleLines(lines: readonly string[], filter: string, start: number, size = WINDOW_LINES): { numbers: number[]; matches: number | null } {
  const wanted = filter.trim()
  const range = (first: number) => {
    const from = Math.max(1, Math.min(first, lines.length - size + 1))
    const last = Math.min(lines.length, from + size - 1)
    return Array.from({ length: Math.max(0, last - from + 1) }, (_, i) => from + i)
  }
  if (/^\d+$/.test(wanted)) return { numbers: range(Math.max(1, Math.min(lines.length, Number(wanted)) - 5)), matches: null }
  if (wanted) {
    const words = wanted.toLowerCase().split(/\s+/)
    const numbers: number[] = []
    let matches = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase()
      if (!words.every((word) => line.includes(word))) continue
      matches += 1
      if (numbers.length < size) numbers.push(i + 1)
    }
    return { numbers, matches }
  }
  return { numbers: range(start), matches: null }
}

/** Moves the window of lines by a page, back (`-1`) or on (`1`); a line number typed is let go. */
function page(direction: -1 | 1, first: number): void {
  const filter = read(lineFilter).trim()
  if (filter && !/^\d+$/.test(filter)) return
  set(lineFilter, '')
  set(windowStart, Math.max(1, first + direction * WINDOW_LINES))
}

/** A line as a cell shows it: its indentation kept (a cell folds spaces), an empty line not a dash. */
function codeCell(line: string): string {
  const indent = /^[\t ]*/.exec(line)?.[0] ?? ''
  const rest = line.slice(indent.length)
  const kept = indent.replace(/\t/g, '  ').replace(/ /g, ' ')
  return kept + rest || ' '
}

/** The open script: its name, a way back, a filter, and its lines, a click on one toggling a breakpoint. */
function SourceView({ path }: { path: string }) {
  const lines = read(source)
  const failure = read(sourceError)
  const filter = read(lineFilter)
  const drawn = sourceRows()
  const header = (
    <Row align="center" justify="between" gap="xs">
      <Row align="center" gap="xs">
        <IconButton icon="collapse" size="sm" variant="ghost" label={text('back')} onPress={closeScript} />
        <Text weight="semibold" truncate>
          {baseName(path)}
        </Text>
      </Row>
      <IconButton icon="open-external" size="sm" variant="ghost" label={text('openInEditor')} onPress={() => void open({ path, line: Number(filter) || undefined })} />
    </Row>
  )
  if (failure) {
    return (
      <Stack gap="xs">
        {header}
        <ErrorState title={text('sourceFailed')} message={wordReason(locale, failure)} retryLabel={text('retry')} onRetry={() => void loadSource(path)} />
      </Stack>
    )
  }
  if (!lines || !drawn) {
    return (
      <Stack gap="xs">
        {header}
        <NoticeLine tone="busy" text={baseName(path)} />
      </Stack>
    )
  }
  const { rows, markedKeys, first, last, total, matches } = drawn
  return (
    <Stack gap="xs">
      {header}
      <Input label={text('findLine')} labelHidden type="search" placeholder={text('findLine')} value={filter} maxLength={200} onChange={(value) => set(lineFilter, value)} />
      {matches !== null ? (
        <Text size="sm" muted>
          {matches > rows.length ? text('matchesCut', { shown: rows.length, count: matches }) : text('matches', { count: matches })}
        </Text>
      ) : (
        <Row align="center" justify="between" gap="xs">
          <Text size="sm" muted>
            {text('window', { first, last, total })}
          </Text>
          <Row align="center" gap="none">
            <IconButton icon="collapse" size="xs" variant="ghost" label={text('previousLines')} disabled={first <= 1} onPress={() => page(-1, first)} />
            <IconButton icon="expand" size="xs" variant="ghost" label={text('nextLines')} disabled={last >= total} onPress={() => page(1, first)} />
          </Row>
        </Row>
      )}
      <Table
        label={text('lines', { name: baseName(path) })}
        columns={[
          { key: 'mark', label: text('colBreak'), width: 'xs', align: 'center' },
          { key: 'line', label: text('colLine'), width: 'xs', align: 'end' },
          { key: 'code', label: text('colCode'), width: 'auto' }
        ]}
        rows={rows}
        selectionMode="multiple"
        selected={markedKeys}
        maxHeight="lg"
        emptyText={text('noLines')}
        onSelectionChange={({ keys }) => {
          const line = toggledLine(markedKeys, keys)
          if (line !== null) void toggleBreakpoint(path, Number(line), !markedKeys.includes(line))
        }}
      />
      <Text size="sm" muted>
        {text('lineHint')}
      </Text>
      {lines.truncated ? <NoticeLine tone="attention" text={text('sourceTruncated')} /> : null}
    </Stack>
  )
}

/** How many times the open script's rows and the list of scripts were built, for the tests. */
export const builds = { rows: 0, scripts: 0 }

/**
 * The open script's lines as table rows, built once per change of the script, the filter or the
 * window, never on each draw (`memo`: Orca's `derived` would build them on every draw). Their marks
 * come apart, from `markedLines`.
 */
const codeRows = memo(
  () => [read(source), read(openScript), read(lineFilter), read(windowStart)],
  () => {
    const lines = read(source)
    if (!lines || lines.path !== read(openScript)) return null
    const { numbers, matches } = visibleLines(lines.lines, read(lineFilter), read(windowStart))
    return { numbers, matches, total: lines.lines.length, code: numbers.map((line) => codeCell(lines.lines[line - 1] ?? '')) }
  }
)

/** The lines of the open script that hold a breakpoint, as one text, so an unchanged set changes nothing. */
function markedLines(): string {
  const current = read(state)
  const path = read(openScript)
  return current && path ? breakpointLines(current, path).join(',') : ''
}

/** The table's rows: the code rows with their marks, built again only when either changed. */
const sourceRows = memo(
  () => [codeRows(), markedLines()],
  () => {
    const code = codeRows()
    const marked = markedLines()
    if (!code) return null
    builds.rows += 1
    const keys = marked ? marked.split(',') : []
    const set = new Set(keys)
    const rows: TableRow[] = code.numbers.map((line, i) => ({ key: String(line), cells: { mark: set.has(String(line)), line, code: code.code[i] } }))
    return { rows, markedKeys: keys, matches: code.matches, total: code.total, first: code.numbers[0] ?? 0, last: code.numbers.at(-1) ?? 0 }
  }
)

/** How many breakpoints each file holds, as one text, so an unchanged set changes nothing. */
function breakpointCounts(): string {
  const current = read(state)
  return current ? current.breakpoints.map((file) => `${file.path}\u0000${file.lines.length}`).join('\u0001') : ''
}

/** Which files hold breakpoints, and how many: the list says so beside each file. */
function counts(encoded: string): Map<string, number> {
  if (!encoded) return new Map()
  return new Map(
    encoded.split('\u0001').map((pair) => {
      const [path, count] = pair.split('\u0000')
      return [path, Number(count)]
    })
  )
}

/** A cartridge's files as a tree of folders, opened folders with their children. */
/** What the list of scripts draws from: the folders open, how many entries each shows, what is left. */
type TreeDraw = { open: readonly string[]; shown: Readonly<Record<string, number>>; marks: Map<string, number>; at: string; left: number }

/**
 * A level of the list of scripts, at most its share: the first `FOLDER_ENTRIES` of a folder (more
 * once its *more* item is pressed), then one item saying how many more; and nothing past
 * `TREE_ITEMS` in all, where one item says to search instead. `entries` are the level's items, built
 * only when drawn.
 */
function capped(key: string, entries: readonly (() => TreeItem)[], draw: TreeDraw): TreeItem[] {
  const wanted = Math.min(entries.length, draw.shown[key] ?? FOLDER_ENTRIES)
  const items: TreeItem[] = []
  for (let i = 0; i < wanted; i++) {
    if (draw.left <= 0) {
      items.push({ key: `s:${key}`, label: t(messages, draw.at, 'searchForMore', { count: entries.length - i }), icon: 'search', disabled: true })
      return items
    }
    draw.left -= 1
    items.push(entries[i]())
  }
  if (wanted < entries.length) items.push({ key: `m:${key}`, label: t(messages, draw.at, 'moreEntries', { count: entries.length - wanted }), icon: 'more' })
  return items
}

function folderItems(prefix: string, files: readonly string[], draw: TreeDraw): TreeItem[] {
  const { open, marks, at } = draw
  const folders = new Map<string, string[]>()
  const leaves: string[] = []
  for (const file of files) {
    const rest = prefix ? file.slice(prefix.length + 1) : file
    const slash = rest.indexOf('/')
    if (slash < 0) leaves.push(file)
    else {
      const folder = prefix ? `${prefix}/${rest.slice(0, slash)}` : rest.slice(0, slash)
      // Pushed in place: copying the folder's list for each file made a folder of n files cost n².
      const inside = folders.get(folder)
      if (inside) inside.push(file)
      else folders.set(folder, [file])
    }
  }
  const entries: (() => TreeItem)[] = [...folders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, inside]) => () => {
    const key = `d:${folder}`
    return open.includes(key)
      ? { key, label: baseName(folder), icon: 'folder', children: folderItems(folder, inside, draw) }
      : { key, label: baseName(folder), icon: 'folder', hasChildren: true }
  })
  for (const file of leaves.sort((a, b) => a.localeCompare(b))) {
    entries.push(() => {
      const count = marks.get(file) ?? 0
      return { key: `f:${file}`, label: baseName(file), icon: 'file', description: count > 0 ? t(messages, at, 'bpCount', { count }) : undefined }
    })
  }
  return capped(`d:${prefix}`, entries, draw)
}

/** The scripts whose path holds every word of `query`, the file's own name matching first. */
export function findScripts(all: readonly string[], query: string): { files: string[]; more: boolean } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { files: [], more: false }
  const name = (file: string) => baseName(file).toLowerCase()
  const found = all.filter((file) => words.every((word) => file.toLowerCase().includes(word)))
  found.sort((a, b) => Number(words.every((w) => name(b).includes(w))) - Number(words.every((w) => name(a).includes(w))) || a.length - b.length || a.localeCompare(b))
  return { files: found.slice(0, MAX_MATCHES), more: found.length > MAX_MATCHES }
}

/**
 * The list of scripts as tree items in a language, built once per change of the scripts, the
 * search, the open folders, how much of each is drawn or the breakpoints' counts, never on each
 * draw (`memo`: Orca's `derived` would build it on every draw, and a cartridge of 10,000 scripts
 * took a tenth of a second each time). One per language, so a change of Orca's language words the
 * notes again at once.
 */
type ScriptItems = { items: TreeItem[]; more: boolean }
const scriptItemsByLanguage = new Map<string, () => ScriptItems>()
function scriptItems(at: string): ScriptItems {
  const language = languageOf(at)
  let items = scriptItemsByLanguage.get(language)
  if (!items) {
    items = memo(
      () => [read(scripts), read(scriptQuery), breakpointCounts(), read(scriptsOpen), read(folderShown)],
      () => scriptItemsIn(language, read(scripts), read(scriptQuery), breakpointCounts(), read(scriptsOpen), read(folderShown))
    )
    scriptItemsByLanguage.set(language, items)
  }
  return items()
}

function scriptItemsIn(at: string, list: DebuggerScripts | null, query: string, marked: string, open: readonly string[], shown: Readonly<Record<string, number>>): ScriptItems {
  if (!list) return { items: [], more: false }
  builds.scripts += 1
  const marks = counts(marked)
  let items: TreeItem[]
  let more = false
  if (query.trim()) {
    const found = findScripts(
      list.cartridges.flatMap((cartridge) => cartridge.files),
      query
    )
    more = found.more
    items = found.files.map((file) => {
      const count = marks.get(file) ?? 0
      const folder = file.slice(0, file.lastIndexOf('/'))
      return { key: `f:${file}`, label: baseName(file), icon: 'file', description: count > 0 ? t(messages, at, 'bpCount', { count }) : baseName(folder) }
    })
  } else {
    const draw: TreeDraw = { open, shown, marks, at, left: TREE_ITEMS }
    items = capped(
      'root',
      list.cartridges.map((cartridge) => () => {
        const key = `c:${cartridge.path}`
        return open.includes(key)
          ? { key, label: cartridge.name, icon: 'package', children: folderItems(cartridge.path, cartridge.files, draw) }
          : { key, label: cartridge.name, icon: 'package', hasChildren: cartridge.files.length > 0 }
      }),
      draw
    )
  }
  return { items, more }
}

/** The scripts of the workspace's cartridges: a tree by cartridge, or the matches of a search. */
function ScriptBrowser() {
  const list = read(scripts)
  const failure = read(scriptsError)
  const query = read(scriptQuery)
  if (failure && !list) return <ErrorState title={text('scriptsFailed')} message={wordReason(locale, failure)} retryLabel={text('retry')} onRetry={() => void loadScripts()} />
  if (!list) return <NoticeLine tone="busy" text={text('scripts')} />
  if (list.cartridges.length === 0) return <Empty title={text('noScriptsTitle')} guidance={text('noScriptsBody')} icon="file" />
  const open = read(scriptsOpen)
  const { items, more } = scriptItems(locale)
  const pick = (key: string) => {
    if (key.startsWith('f:')) showScript(key.slice(2))
    // A folder's *more* item draws a page more of it.
    if (key.startsWith('m:')) {
      const folder = key.slice(2)
      const shown = read(folderShown)
      set(folderShown, { ...shown, [folder]: (shown[folder] ?? FOLDER_ENTRIES) + FOLDER_ENTRIES })
    }
  }
  return (
    <Stack gap="xs">
      <Input label={text('findScript')} labelHidden type="search" placeholder={text('findScriptPlaceholder')} value={query} maxLength={200} onChange={(value) => set(scriptQuery, value)} />
      {items.length === 0 ? (
        <Text size="sm" muted>
          {text('noMatches')}
        </Text>
      ) : (
        <Tree
          label={text('scripts')}
          items={items}
          expanded={open}
          maxHeight="md"
          onToggle={({ key, expanded: isOpen }) => set(scriptsOpen, isOpen ? [...open.filter((each) => each !== key), key] : open.filter((each) => each !== key))}
          onSelect={({ key }) => pick(key)}
          onAction={({ key }) => pick(key)}
        />
      )}
      {more ? <NoticeLine tone="off" text={text('moreMatches')} /> : null}
      {list.truncated ? <NoticeLine tone="attention" text={text('scriptsTruncated')} /> : null}
    </Stack>
  )
}

function Scripts() {
  const path = read(openScript)
  return <Group title={text('scripts')}>{path ? <SourceView path={path} /> : <ScriptBrowser />}</Group>
}

// ---------------------------------------------------------------------------------------------
// The session and a halted request

function SessionGroup({ current, working }: { current: DebuggerState; working: boolean }) {
  const status = STATUS[current.status]
  const ready = current.sandbox === 'ready'
  return (
    <Group title={text('session')}>
      <Row justify="between" align="center" gap="sm">
        <Row align="center" gap="sm">
          <StateMark tone={status.tone} label={text(status.key)} />
          <Text weight="medium">{text(status.key)}</Text>
          {status.hint ? (
            <Text size="sm" muted truncate>
              {text(status.hint)}
            </Text>
          ) : null}
        </Row>
        {isRunning(current.status) ? (
          <Button size="xs" variant="outline" icon="stop" disabled={working} onPress={() => void stop()}>
            {text('stop')}
          </Button>
        ) : current.status === 'failed' ? null : (
          <Button size="xs" variant="solid" icon="bug" tooltip={text('startTooltip')} disabled={working || !ready} onPress={() => void start()}>
            {text('start')}
          </Button>
        )}
      </Row>
      {ready ? null : <NoticeLine tone="attention" text={text('sandboxNotReady')} action={{ label: text('openSetup'), icon: 'settings', onPress: openSetup }} />}
      {current.status === 'failed' ? (
        <Stack gap="xs">
          <ErrorState
            title={text('failedTitle')}
            message={wordReason(locale, current.reason ?? 'start_failed')}
            retryLabel={ready ? text('retry') : undefined}
            onRetry={ready ? () => void start() : undefined}
            busy={working}
          />
          {current.message ? (
            <Collapsible title={text('details')}>
              <Text size="sm" muted>
                {current.message}
              </Text>
            </Collapsible>
          ) : null}
        </Stack>
      ) : current.status === 'ended' && current.reason ? (
        <NoticeLine tone="off" text={[wordReason(locale, current.reason), current.message ?? ''].filter(Boolean).join(' ')} />
      ) : null}
    </Group>
  )
}

function Paused() {
  return (
    <Group title={text('paused')}>
      <Row align="center" gap="xs" wrap>
        <Button size="xs" variant="solid" icon="play" tooltip={text('continueTooltip')} onPress={() => void step('continue')}>
          {text('continue')}
        </Button>
        <IconButton icon="next" size="sm" variant="outline" label={text('stepOver')} onPress={() => void step('over')} />
        <IconButton icon="expand" size="sm" variant="outline" label={text('stepIn')} onPress={() => void step('in')} />
        <IconButton icon="collapse" size="sm" variant="outline" label={text('stepOut')} onPress={() => void step('out')} />
      </Row>
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

/** A frame's button to put a breakpoint on its line; shown as set when one is there already. */
function AddHere({ current, path, line }: { current: DebuggerState; path: string | null; line: number | null }) {
  const set = path !== null && line !== null && breakpointLines(current, path).includes(line)
  return (
    <IconButton
      icon="flag"
      size="xs"
      variant="ghost"
      tone={set ? 'success' : undefined}
      label={text(set ? 'bpHere' : 'addHere')}
      disabled={path === null || line === null || set}
      onPress={() => (path !== null && line !== null ? void toggleBreakpoint(path, line, true) : undefined)}
    />
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
            detail={
              <Text size="sm" muted>
                <Code>{`${frame.file}:${frame.line}`}</Code>
              </Text>
            }
            current={frame.id === selected}
            onPress={() => void selectFrame(frame)}
            actions={<AddHere current={current} path={frame.path} line={frame.line} />}
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
        <Tree label={text('variables')} items={treeItems(keys, all, new Set(read(expanded)))} expanded={read(expanded)} maxHeight="md" onToggle={(item) => void toggle(item.key, item.expanded)} />
      )}
    </Group>
  )
}

function Evaluate() {
  const answer = read(result)
  return (
    <Group title={text('evaluate')}>
      <Row align="center" gap="xs">
        <Box grow>
          <Input
            label={text('expression')}
            labelHidden
            placeholder={text('expressionPlaceholder')}
            value={read(expression)}
            maxLength={2000}
            onChange={(value) => set(expression, value)}
            onSubmit={() => void evaluate()}
          />
        </Box>
        <IconButton icon="play" size="sm" variant="outline" label={text('evaluate')} disabled={!read(expression).trim()} onPress={() => void evaluate()} />
      </Row>
      {answer === null ? null : <Text size="sm">{answer}</Text>}
    </Group>
  )
}

function BreakpointRow({ file, line, verified, name }: { file: BreakpointView; line: number; verified: boolean | null; name: string }) {
  const { tone, note } = verifiedOf(verified)
  const title = `${name}:${line}`
  return (
    <ListRow
      tone={tone}
      title={title}
      note={text(note)}
      noteTone={tone}
      onPress={() => showScript(file.path, line)}
      actions={
        <IconButton
          icon="delete"
          size="xs"
          variant="ghost"
          label={text('remove', { name: title })}
          onPress={() =>
            void setLines(
              file.path,
              file.lines.map((each) => each.line).filter((each) => each !== line)
            )
          }
        />
      }
    />
  )
}

function Breakpoints({ current }: { current: DebuggerState }) {
  const files = current.breakpoints
  const names = shortNames(files.map((file) => file.path))
  const rows = files.flatMap((file) => file.lines.map((each) => ({ file, line: each.line, verified: each.verified })))
  const shown = read(shownBreakpoints)
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
        rows.slice(0, shown).map(({ file, line, verified }) => <BreakpointRow key={`bp-${file.path}:${line}`} file={file} line={line} verified={verified} name={names[file.path] ?? file.path} />)
      )}
      <ShowMore
        shown={shown}
        total={rows.length}
        label={(left) => text('showMore', { count: left })}
        capped={(left) => text('notShown', { count: left })}
        onPress={() => set(shownBreakpoints, shown + PAGE_SIZE)}
      />
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
      {failure ? <Notice tone="failed" title={text('requestFailed')} detail={wordReason(locale, failure)} action={{ label: text('dismiss'), icon: 'close', onPress: () => set(problem, null) }} /> : null}
      <SessionGroup current={current} working={read(busy)} />
      {halted ? <Paused /> : null}
      {halted ? <Threads current={current} /> : null}
      {halted ? <CallStack current={current} /> : null}
      {halted ? <Variables /> : null}
      {halted ? <Evaluate /> : null}
      <Breakpoints current={current} />
      <Scripts />
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
    lastJson = ''
    ctx.subscriptions.push(plugin.on('debugger.state', (next) => apply(next)))
    void refresh()
    void loadScripts()
    // The script open when the panel was last closed is read again: its lines are never kept.
    const path = read(openScript)
    if (path) void loadSource(path)
  },
  render(at) {
    locale = at
    const current = read(state)
    return current ? <View current={current} /> : null
  },
  reset: resetView
}

/**
 * Closes whatever is open in the view, kept or not: the folders of the list of scripts and how much
 * of each is drawn, the open script with its window and search, the search of scripts, the open
 * variables (read again folded, from the frame shown), and the pages of breakpoints drawn. The
 * breakpoints themselves stay.
 */
export function resetView(): void {
  set(scriptsOpen, [])
  set(folderShown, {})
  set(scriptQuery, '')
  closeScript()
  set(windowStart, 1)
  set(shownBreakpoints, PAGE_SIZE)
  const frame = read(frameId)
  resetVariables()
  if (frame !== null) void loadScopes(frame)
}
