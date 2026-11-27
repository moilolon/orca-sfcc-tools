// The engine piece's half of the panel, listed in src/panel/sections.ts: the Problems view. At the
// top, how many problems of each severity the checkout has and when it was analysed; then a
// severity filter and a search; then the files with problems, a page at a time, each with its
// first problems as rows (the message, its line, and a button that opens the file there). A file
// with more opens its detail in place of the list, with a way back.
//
// What it shows comes from the worker, masked: a file's path in the workspace and the names a
// problem's message is made of (an attribute, a template, a key). Never a host or a value of
// dw.json. The words are this piece's (`i18n.ts`), from each problem's code.
import { atom, Box, Button, Code, env, IconButton, Input, plugin, read, RelativeTime, Row, Select, Skeleton, Stack, Text, update, type OrcaNode, type PanelContext } from 'orca'
import { t } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { Empty, ErrorState, ListRow, Notice, NoticeLine, PAGE_SIZE, ShowMore, StateBadge, StateMark, MAX_ROWS, type StateTone } from '../../panel/ui'
import { messages, openFailureKey, problemMessage, type EngineMessageKey } from './i18n'
import type { Problem, ProblemCounts, ProblemFile, ProblemsList, ProblemsOfFile, Severity, SeverityFilter } from './protocol'

/** The severity shown, kept across runs of the plugin. */
const severityFilter = atom<string>('engineSeverity', 'all', { persist: 'plugin' })
/** The search typed. */
const searchText = atom<string>('engineSearch', '')
/** How many problems the list asks for: a page more with each *Show more*. */
const listLimit = atom<number>('engineLimit', PAGE_SIZE)
/** The file whose detail is open, by its path in the workspace; null for the list. */
const openFile = atom<string | null>('engineFile', null, { persist: 'plugin' })
/** How many of the open file's problems are drawn. */
const fileLimit = atom<number>('engineFileLimit', PAGE_SIZE)
/** The last answers, and the code of a request that failed (the next good answer clears it). */
const listAnswer = atom<ProblemsList | null>('engineList', null)
const fileAnswer = atom<ProblemsOfFile | null>('engineFileAnswer', null)
const failure = atom<string | null>('engineFailure', null)
/** Why the last file pressed did not open. */
const openProblem = atom<string | null>('engineOpenProblem', null)

/** Each request gets a number: an answer to an older one, which can arrive late, is dropped. */
let asked = 0
let askedFile = 0
let lastJson = ''
let lastFileJson = ''

const TONE: Readonly<Record<Severity, StateTone>> = { error: 'failed', warning: 'attention', info: 'off' }

function text(locale: string, key: EngineMessageKey, vars?: Record<string, string | number>): string {
  return t(messages, locale, key, vars)
}

function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'action_failed'
}

function currentSeverity(): SeverityFilter {
  const value = read(severityFilter)
  return value === 'error' || value === 'warning' || value === 'info' ? value : 'all'
}

/** The last part of a path: the name a person recognises. */
function fileName(path: string): string {
  return path.split('/').pop() || path
}

async function loadList(): Promise<void> {
  const mine = ++asked
  try {
    const answer = await plugin.request('engine.problems.list', { severity: currentSeverity(), search: read(searchText), limit: read(listLimit) })
    if (mine !== asked) return
    const json = JSON.stringify(answer)
    if (json !== lastJson) {
      lastJson = json
      update(listAnswer, () => answer)
    }
    if (read(failure) !== null) update(failure, () => null)
  } catch (error) {
    if (mine === asked) update(failure, () => codeOf(error))
  }
}

async function loadFile(): Promise<void> {
  const path = read(openFile)
  if (path === null) return
  const mine = ++askedFile
  try {
    const answer = await plugin.request('engine.problems.file', { path, severity: currentSeverity(), search: read(searchText), limit: read(fileLimit) })
    if (mine !== askedFile) return
    const json = JSON.stringify(answer)
    if (json !== lastFileJson) {
      lastFileJson = json
      update(fileAnswer, () => answer)
    }
  } catch (error) {
    if (mine === askedFile) update(failure, () => codeOf(error))
  }
}

function reload(): void {
  void loadList()
  void loadFile()
}

function pickSeverity(value: string): void {
  update(severityFilter, () => value)
  update(listLimit, () => PAGE_SIZE)
  update(fileLimit, () => PAGE_SIZE)
  reload()
}

function search(value: string): void {
  update(searchText, () => value)
  update(listLimit, () => PAGE_SIZE)
  update(fileLimit, () => PAGE_SIZE)
  reload()
}

function showFile(path: string | null): void {
  update(openFile, () => path)
  update(fileLimit, () => PAGE_SIZE)
  update(fileAnswer, () => null)
  update(openProblem, () => null)
  lastFileJson = ''
  void loadFile()
}

async function retry(): Promise<void> {
  try {
    const answer = await plugin.request('engine.problems.refresh', {})
    lastJson = JSON.stringify(answer)
    update(listAnswer, () => answer)
    update(failure, () => null)
  } catch (error) {
    update(failure, () => codeOf(error))
  }
}

async function openAt(path: string, problem: Problem): Promise<void> {
  update(openProblem, () => null)
  try {
    const result = await plugin.request('engine.problems.open', { path, line: problem.line, column: problem.column })
    if (!result.opened) update(openProblem, () => result.reason ?? 'action_failed')
  } catch (error) {
    update(openProblem, () => codeOf(error))
  }
}

/** The severity of a file's worst problem. */
function worst(counts: ProblemCounts): Severity {
  return counts.error > 0 ? 'error' : counts.warning > 0 ? 'warning' : 'info'
}

function total(counts: ProblemCounts): number {
  return counts.error + counts.warning + counts.info
}

// ---------------------------------------------------------------------------------------------
// Blocks

/** One badge per severity that has problems, each saying how many. */
function CountBadges({ counts, locale }: { counts: ProblemCounts; locale: string }) {
  const badges: OrcaNode[] = []
  const add = (severity: Severity, one: EngineMessageKey, many: EngineMessageKey) => {
    const count = counts[severity]
    if (count > 0) badges.push(<StateBadge key={severity} tone={TONE[severity]}>{count === 1 ? text(locale, one) : text(locale, many, { count })}</StateBadge>)
  }
  add('error', 'countErrorOne', 'countError')
  add('warning', 'countWarningOne', 'countWarning')
  add('info', 'countInfoOne', 'countInfo')
  return (
    <Row gap="xs" wrap>
      {badges}
    </Row>
  )
}

/** One problem: its mark, its message (wrapping), its line, and a button that opens the file there. */
function ProblemRow({ path, problem, locale }: { path: string; problem: Problem; locale: string }) {
  const where = problem.args.storefronts ? text(locale, 'lineOn', { line: problem.line, storefronts: problem.args.storefronts }) : text(locale, 'line', { line: problem.line })
  const severity = text(locale, problem.severity === 'error' ? 'severityError' : problem.severity === 'warning' ? 'severityWarning' : 'severityInfo')
  return (
    <Row justify="between" align="start" gap="sm">
      <Row align="start" gap="sm">
        <StateMark tone={TONE[problem.severity]} label={severity} />
        <Stack gap="none">
          <Text size="sm">{problemMessage(locale, problem)}</Text>
          <Text size="sm" muted>
            {where}
          </Text>
        </Stack>
      </Row>
      <IconButton icon="open-external" size="xs" variant="ghost" label={text(locale, 'openAt', { line: problem.line })} onPress={() => openAt(path, problem)} />
    </Row>
  )
}

/** A file of the list: its name (pressing it opens its detail), its path, how many problems; then its first problems. */
function FileBlock({ file, locale }: { file: ProblemFile; locale: string }) {
  return (
    <Stack gap="xs">
      <ListRow
        tone={TONE[worst(file.counts)]}
        title={fileName(file.path)}
        detail={
          <Text size="sm" muted>
            <Code>{file.path}</Code>
          </Text>
        }
        note={String(total(file.counts))}
        noteTone={TONE[worst(file.counts)]}
        onPress={() => showFile(file.path)}
      />
      <Box paddingX="md">
        <Stack gap="xs">
          {file.problems.map((problem, index) => (
            <ProblemRow key={`${problem.start}-${problem.code}-${index}`} path={file.path} problem={problem} locale={locale} />
          ))}
          {file.more > 0 ? (
            <Row>
              <Button size="xs" variant="ghost" icon="next" onPress={() => showFile(file.path)}>
                {text(locale, 'moreInFile', { count: file.more })}
              </Button>
            </Row>
          ) : null}
        </Stack>
      </Box>
    </Stack>
  )
}

/** The severity filter, with each severity's count, and the search. */
function Filters({ answer, locale }: { answer: ProblemsList; locale: string }) {
  const { counts } = answer
  return (
    <Stack gap="xs">
      <Select
        label={text(locale, 'filterLabel')}
        labelHidden
        value={currentSeverity()}
        options={[
          { value: 'all', label: text(locale, 'filterAll', { count: total(counts) }) },
          { value: 'error', label: text(locale, 'filterError', { count: counts.error }) },
          { value: 'warning', label: text(locale, 'filterWarning', { count: counts.warning }) },
          { value: 'info', label: text(locale, 'filterInfo', { count: counts.info }) }
        ]}
        onChange={pickSeverity}
      />
      <Input label={text(locale, 'searchLabel')} labelHidden type="search" placeholder={text(locale, 'searchPlaceholder')} value={read(searchText)} maxLength={200} onChange={search} />
    </Stack>
  )
}

/** When the checkout was analysed, or that it is being analysed again, in one muted line. */
function AnalysedLine({ answer, locale }: { answer: ProblemsList; locale: string }) {
  if (answer.busy) return <NoticeLine tone="busy" text={text(locale, 'analysingAgain')} />
  if (answer.analysedAt === null) return null
  return (
    <Text size="sm" muted>
      {text(locale, 'analysedAt')} <RelativeTime at={answer.analysedAt} format="short" />
    </Text>
  )
}

function OpenNotice({ locale }: { locale: string }) {
  const problem = read(openProblem)
  if (!problem) return null
  return <Notice tone="failed" title={text(locale, 'openFailedTitle')} detail={text(locale, openFailureKey(problem))} action={{ label: text(locale, 'dismiss'), icon: 'close', onPress: () => update(openProblem, () => null) }} />
}

// ---------------------------------------------------------------------------------------------
// The view

function FileDetail({ path, locale }: { path: string; locale: string }) {
  const answer = read(fileAnswer)
  const header = (
    <Row key="back" align="center" gap="xs">
      <IconButton icon="collapse" size="sm" variant="ghost" label={text(locale, 'back')} onPress={() => showFile(null)} />
      <Stack gap="none">
        <Text weight="semibold" truncate>
          {fileName(path)}
        </Text>
        <Text size="sm" muted>
          <Code>{path}</Code>
        </Text>
      </Stack>
    </Row>
  )
  if (!answer || answer.path !== path) return <Stack gap="md">{[header, <Skeleton key="loading" lines={3} label={text(locale, 'fileProblems')} />]}</Stack>
  const blocks: OrcaNode[] = [header, <OpenNotice key="open" locale={locale} />]
  if (answer.total === 0) {
    blocks.push(<Empty key="clean" icon="check" title={text(locale, read(searchText) || currentSeverity() !== 'all' ? 'noMatchTitle' : 'cleanTitle')} guidance={text(locale, read(searchText) || currentSeverity() !== 'all' ? 'noMatchGuidance' : 'cleanGuidance')} />)
    return <Stack gap="md">{blocks}</Stack>
  }
  blocks.push(
    <Stack key="problems" gap="xs">
      {answer.problems.map((problem, index) => (
        <ProblemRow key={`${problem.start}-${problem.code}-${index}`} path={answer.path} problem={problem} locale={locale} />
      ))}
      <ShowMore
        shown={answer.problems.length}
        total={answer.total}
        label={(left) => text(locale, 'showMore', { count: left })}
        capped={(left) => text(locale, 'notShown', { count: left })}
        onPress={() => {
          update(fileLimit, (limit) => Math.min(MAX_ROWS, limit + PAGE_SIZE))
          void loadFile()
        }}
      />
    </Stack>
  )
  return <Stack gap="md">{blocks}</Stack>
}

function ProblemsView({ answer, locale }: { answer: ProblemsList; locale: string }) {
  if (answer.state === 'none') return <Empty icon="search" title={text(locale, 'noneTitle')} guidance={text(locale, 'noneGuidance')} />
  if (answer.state === 'failed') {
    const reason = answer.error === 'index_failed' ? 'index_failed' : 'analysis_failed'
    return <ErrorState title={text(locale, 'failedTitle')} message={text(locale, reason)} retryLabel={text(locale, 'retry')} onRetry={retry} />
  }
  if (answer.state === 'indexing' || answer.state === 'analysing') {
    return (
      <Stack gap="md">
        <NoticeLine tone="busy" text={text(locale, answer.state === 'indexing' ? 'stateIndexing' : 'stateAnalysing')} />
        <Skeleton lines={4} label={text(locale, answer.state === 'indexing' ? 'stateIndexing' : 'stateAnalysing')} />
      </Stack>
    )
  }
  const open = read(openFile)
  if (open !== null) return <FileDetail path={open} locale={locale} />
  const blocks: OrcaNode[] = [<CountBadges key="counts" counts={answer.counts} locale={locale} />, <AnalysedLine key="analysed" answer={answer} locale={locale} />]
  if (total(answer.counts) === 0) {
    blocks.push(<Empty key="clean" icon="check" title={text(locale, 'cleanTitle')} guidance={text(locale, 'cleanGuidance')} />)
    return <Stack gap="md">{blocks}</Stack>
  }
  blocks.push(<Filters key="filters" answer={answer} locale={locale} />, <OpenNotice key="open" locale={locale} />)
  if (answer.matching.problems === 0) {
    blocks.push(<Empty key="none" icon="filter" title={text(locale, 'noMatchTitle')} guidance={text(locale, 'noMatchGuidance')} />)
    return <Stack gap="md">{blocks}</Stack>
  }
  const listed = answer.page.reduce((sum, file) => sum + file.problems.length, 0)
  blocks.push(
    <Stack key="files" gap="sm">
      {answer.page.map((file) => (
        <FileBlock key={file.path} file={file} locale={locale} />
      ))}
      <ShowMore
        shown={listed}
        total={answer.matching.listable}
        label={(left) => text(locale, 'showMore', { count: left })}
        capped={(left) => text(locale, 'notShown', { count: left })}
        onPress={() => {
          update(listLimit, (limit) => Math.min(MAX_ROWS, limit + PAGE_SIZE))
          void loadList()
        }}
      />
    </Stack>
  )
  return <Stack gap="md">{blocks}</Stack>
}

export const section: PanelSection = {
  id: 'engine',
  icon: 'search',
  title: (locale) => t(messages, locale, 'title'),
  delivered: true,
  hasView: true,
  setup(ctx: PanelContext) {
    ctx.subscriptions.push(plugin.on('engine.problems.changed', () => reload()))
    lastJson = ''
    lastFileJson = ''
    reload()
  },
  render(locale) {
    const answer = read(listAnswer)
    const failed = read(failure)
    const words = locale ?? env.locale
    if (!answer) {
      if (!failed) return null
      return <ErrorState title={text(words, 'failedTitle')} message={text(words, 'analysis_failed')} retryLabel={text(words, 'retry')} onRetry={() => loadList()} />
    }
    return <ProblemsView answer={answer} locale={words} />
  },
  reset: resetEngineView
}

/** Closes what is open in the view: a file's detail, the pages drawn, the search, its note. */
export function resetEngineView(): void {
  update(openFile, () => null)
  update(listLimit, () => PAGE_SIZE)
  update(fileLimit, () => PAGE_SIZE)
  update(searchText, () => '')
  update(openProblem, () => null)
  reload()
}
