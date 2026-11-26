// The sandbox piece's view, listed in src/panel/sections.ts: the sandbox's state with start and
// stop beside it, then the workspaces: the one that uploads first, with its code version, its
// upload state and its actions; the other workspaces of its project, each with a button to make it
// the one that uploads; the workspaces of other projects folded away. Built only from the blocks of
// src/panel/ui.tsx and Orca's components. It shows workspace names, branches and code versions,
// never a host, a path or anything b2c printed: failures arrive as codes and are worded here.
import { atom, Button, Code, Collapsible, IconButton, plugin, read, RelativeTime, Row, set, Stack, Text, type OrcaNode, type PanelContext } from 'orca'
import { t } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { openSetup } from '../../panel/navigation'
import { Actions, Empty, ErrorState, Group, ListRow, Notice, NoticeLine, PAGE_SIZE, ShowMore, StateMark, type NoticeAction, type StateTone } from '../../panel/ui'
import { messages, wordSandboxError, type SandboxMessageKey } from './i18n'
import type { SandboxAction, SandboxStatus, SandboxWorkspace, UploadState } from './protocol'

const status = atom<SandboxStatus | null>(null)
/** Why the first state could not be read: an error code. */
const loadError = atom<string | null>(null)
/** The request in flight, so its buttons wait. */
const pending = atom<string | null>(null)
/** The last action refused, with why (an error code), until the next action or a dismissal. */
const refused = atom<{ name: ActionName; code: string; workspaceId?: string } | null>(null)
/** The workspace whose *Use* was pressed, waiting for the confirming *Upload from here*. */
const chosen = atom<string | null>(null)
/** The left-behind version whose delete was pressed, waiting for the confirming *Delete*. */
const chosenLeftover = atom<string | null>(null)
/** How many workspaces of the project, and of other projects, are drawn: a long list is paged. */
const shownInProject = atom(PAGE_SIZE)
const shownElsewhere = atom(PAGE_SIZE)
/** The last state as JSON, so a post that changes nothing draws nothing. */
let lastJson = ''

/** Keeps a new state, unless it is the one already drawn. */
function keepStatus(next: SandboxStatus): void {
  const json = JSON.stringify(next)
  if (json === lastJson) return
  lastJson = json
  set(status, next)
}

type ActionRequest = 'sandbox.refresh' | 'sandbox.release' | 'sandbox.deploy' | 'sandbox.reload' | 'sandbox.start' | 'sandbox.stop'
type ActionName = ActionRequest | 'sandbox.pick' | 'sandbox.forget'

/** Refusals whose fix is in the setup view: their notice leads there. */
const SETUP_CODES: ReadonlySet<string> = new Set(['sandbox_not_ready', 'config_missing', 'config_invalid', 'credentials_missing', 'role_not_configured', 'value_invalid', 'b2c_not_found'])
/** Refusals that trying again cannot change: their notice is only dismissed. */
const FINAL_CODES: ReadonlySet<string> = new Set([
  'workspace_uploads',
  'workspace_listed',
  'workspace_hidden',
  'workspace_remote',
  'workspace_unknown',
  'sandbox_already_started',
  'sandbox_already_stopped',
  'no_owner',
  'superseded',
  'disposed',
  'upload_deploying'
])

function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'action_failed'
}

async function load(): Promise<void> {
  try {
    keepStatus(await plugin.request('sandbox.status', {}))
    set(loadError, null)
  } catch (error) {
    set(loadError, codeOf(error))
  }
}

async function act(name: ActionName, workspaceId?: string): Promise<void> {
  set(pending, name)
  set(refused, null)
  try {
    const next =
      name === 'sandbox.pick' || name === 'sandbox.forget'
        ? await plugin.request(name, { workspaceId: workspaceId ?? '' }, { timeoutMs: 90_000 })
        : await plugin.request(name, {}, { timeoutMs: 90_000 })
    keepStatus(next)
    if (name === 'sandbox.pick') set(chosen, null)
    if (name === 'sandbox.forget') set(chosenLeftover, null)
  } catch (error) {
    set(refused, { name, code: codeOf(error), workspaceId })
  } finally {
    set(pending, null)
  }
}

const SANDBOX_STATES: Record<SandboxStatus['sandbox']['state'], { key: SandboxMessageKey; tone: StateTone }> = {
  started: { key: 'stateStarted', tone: 'ok' },
  stopped: { key: 'stateStopped', tone: 'off' },
  busy: { key: 'stateBusy', tone: 'busy' },
  unknown: { key: 'stateUnknown', tone: 'attention' }
}

/** What the upload is doing, in a word beside the owner's name. */
const UPLOAD_STATES: Record<UploadState, { key: SandboxMessageKey; tone: StateTone }> = {
  none: { key: 'uploadNone', tone: 'off' },
  deploying: { key: 'uploadDeploying', tone: 'busy' },
  watching: { key: 'uploadWatching', tone: 'ok' },
  uploading: { key: 'uploadUploading', tone: 'busy' },
  failed: { key: 'uploadFailed', tone: 'failed' }
}

/** The upload's state: a failure that needs a deploy, or a lost workspace, in its own words. */
function uploadShown(current: SandboxStatus): { key: SandboxMessageKey; tone: StateTone } {
  const { state, reason } = current.upload
  if (state === 'failed' && reason === 'deploy_needed') return { key: 'uploadDeployNeeded', tone: 'attention' }
  if (state === 'failed' && (reason === 'workspace_not_found' || reason === 'workspace_list_unavailable')) return { key: 'uploadNotFound', tone: 'attention' }
  return UPLOAD_STATES[state]
}

/** The refused action, its notice: what failed, why, and the one button that helps. */
function Refusal({ refusal, locale }: { refusal: { name: ActionName; code: string; workspaceId?: string }; locale: string }) {
  const w = (key: SandboxMessageKey) => t(messages, locale, key)
  const action: NoticeAction = SETUP_CODES.has(refusal.code)
    ? { label: w('openSetup'), icon: 'settings', onPress: openSetup }
    : FINAL_CODES.has(refusal.code)
      ? { label: w('dismiss'), icon: 'close', onPress: () => set(refused, null) }
      : { label: w('retry'), icon: 'refresh', onPress: () => void act(refusal.name, refusal.workspaceId) }
  return <Notice tone="failed" title={w(`refused.${refusal.name}`)} detail={wordSandboxError(locale, refusal.code)} action={action} />
}

function SandboxGroup({ current, locale, ready, busy }: { current: SandboxStatus; locale: string; ready: boolean; busy: boolean }) {
  const w = (key: SandboxMessageKey) => t(messages, locale, key)
  const { state, following, reason, checkedAt } = current.sandbox
  const shown = following === 'start' ? { key: 'stateStarting' as const, tone: 'busy' as const } : following === 'stop' ? { key: 'stateStopping' as const, tone: 'busy' as const } : SANDBOX_STATES[state]
  const settled = ready && !following
  return (
    <Group title={w('groupSandbox')} action={<IconButton icon="refresh" size="sm" variant="ghost" label={w('refresh')} disabled={busy} onPress={() => void act('sandbox.refresh')} />}>
      <Row justify="between" align="center" gap="sm">
        <Row align="center" gap="sm">
          <StateMark tone={shown.tone} label={w(shown.key)} />
          <Text weight="medium">{w(shown.key)}</Text>
          {checkedAt ? (
            <Text size="sm" muted>
              <RelativeTime at={checkedAt} format="short" />
            </Text>
          ) : null}
        </Row>
        {settled && state === 'stopped' ? (
          <Button size="xs" variant="solid" icon="play" disabled={busy} onPress={() => void act('sandbox.start')}>
            {w('start')}
          </Button>
        ) : settled && state === 'started' ? (
          <Button size="xs" variant="outline" icon="stop" disabled={busy} onPress={() => void act('sandbox.stop')}>
            {w('stop')}
          </Button>
        ) : null}
      </Row>
      {state === 'unknown' && reason && ready ? (
        <NoticeLine tone="attention" text={wordSandboxError(locale, reason)} action={{ label: w('retry'), icon: 'refresh', disabled: busy, onPress: () => void act('sandbox.refresh') }} />
      ) : null}
    </Group>
  )
}

/** When the owner last uploaded, or deployed, in one muted line. */
function OwnerTimes({ current, locale }: { current: SandboxStatus; locale: string }) {
  const w = (key: SandboxMessageKey, vars?: Record<string, string | number>) => t(messages, locale, key, vars)
  const { lastUploadAt, lastDeployAt, files } = current.upload
  const at = lastUploadAt ?? lastDeployAt
  if (!at) return null
  return (
    <Text size="sm" muted truncate>
      {lastUploadAt ? w('lastUpload') : w('lastDeploy')} <RelativeTime at={at} format="short" />
      {files > 0 ? ` · ${w('files', { count: files })}` : ''}
    </Text>
  )
}

/** The workspace that uploads: its row, its state, what went wrong, and its actions. */
function Owner({ current, workspace, locale, ready, busy }: { current: SandboxStatus; workspace: SandboxWorkspace | null; locale: string; ready: boolean; busy: boolean }) {
  const w = (key: SandboxMessageKey) => t(messages, locale, key)
  const { upload } = current
  const shown = uploadShown(current)
  const deploying = upload.state === 'deploying'
  const failed = upload.state === 'failed'
  const lost = failed && (upload.reason === 'workspace_not_found' || upload.reason === 'workspace_list_unavailable')
  const needed = failed && upload.reason === 'deploy_needed'
  // Reloading activates the version: only one whose last full deploy ended, while it is watched.
  const reloadable = upload.deployed && (upload.state === 'watching' || upload.state === 'uploading')
  const deploy: NoticeAction = { label: w('deployAgain'), icon: 'upload', disabled: busy || !ready, onPress: () => void act('sandbox.deploy') }
  return (
    <Stack gap="xs">
      <ListRow
        tone={shown.tone}
        title={upload.workspaceName ?? workspace?.name ?? ''}
        detail={
          upload.codeVersion ? (
            <Text size="sm" muted truncate>
              <Code>{upload.codeVersion}</Code>
            </Text>
          ) : undefined
        }
        note={w(shown.key)}
        noteTone={shown.tone}
        current
      />
      <OwnerTimes current={current} locale={locale} />
      {lost ? (
        <Notice tone="attention" title={w('uploadNotFound')} detail={wordSandboxError(locale, upload.reason ?? 'action_failed')} action={{ label: w('release'), icon: 'stop', disabled: busy, onPress: () => void act('sandbox.release') }} />
      ) : needed ? (
        <Notice tone="attention" title={w('uploadDeployNeeded')} detail={wordSandboxError(locale, 'deploy_needed')} action={deploy} />
      ) : failed ? (
        <Notice tone="failed" title={w('failedTitle')} detail={wordSandboxError(locale, upload.reason ?? 'action_failed')} action={deploy} />
      ) : null}
      {upload.restored && (upload.state === 'watching' || upload.state === 'uploading') ? <NoticeLine tone="attention" text={w('restoredHint')} /> : null}
      <Actions>
        {failed ? null : (
          <Button size="xs" variant="outline" icon="upload" disabled={busy || deploying || !ready} onPress={() => void act('sandbox.deploy')}>
            {w('deployAgain')}
          </Button>
        )}
        {reloadable ? (
          <Button size="xs" variant="outline" icon="refresh" disabled={busy || upload.reloading || !ready} onPress={() => void act('sandbox.reload')}>
            {upload.reloading ? w('reloading') : w('reload')}
          </Button>
        ) : null}
        {lost ? null : (
          <Button size="xs" variant="outline" icon="stop" disabled={busy} onPress={() => void act('sandbox.release')}>
            {w('release')}
          </Button>
        )}
      </Actions>
    </Stack>
  )
}

/**
 * Any other workspace: its name, its branch, and a button to make it the one that uploads, which
 * asks once more before it deploys. A workspace on another machine is listed, never picked.
 */
function OtherRow({ workspace, locale, ready, busy }: { workspace: SandboxWorkspace; locale: string; ready: boolean; busy: boolean }) {
  const w = (key: SandboxMessageKey, vars?: Record<string, string | number>) => t(messages, locale, key, vars)
  const confirming = read(chosen) === workspace.id
  if (!workspace.local) return <ListRow tone="off" title={workspace.name} detail={workspace.branch ?? undefined} note={w('noteRemote')} />
  const actions = confirming ? (
    <Row align="center" gap="xs">
      <Button size="xs" variant="solid" icon="upload" disabled={busy || !ready} onPress={() => void act('sandbox.pick', workspace.id)}>
        {w('uploadFromThis')}
      </Button>
      <IconButton icon="close" size="xs" variant="ghost" label={w('cancel')} onPress={() => set(chosen, null)} />
    </Row>
  ) : (
    <Button size="xs" variant="outline" disabled={busy || !ready} tooltip={w('useTooltip', { name: workspace.name })} onPress={() => set(chosen, workspace.id)}>
      {w('use')}
    </Button>
  )
  return <ListRow tone="off" title={workspace.name} detail={workspace.branch ?? undefined} current={confirming} actions={actions} />
}

/** Local ones first, then those on another machine; by name within each. */
function ordered(list: readonly SandboxWorkspace[]): SandboxWorkspace[] {
  return [...list].sort((a, b) => Number(!a.local) - Number(!b.local) || a.name.localeCompare(b.name))
}

function WorkspacesGroup({ current, locale, ready, busy }: { current: SandboxStatus; locale: string; ready: boolean; busy: boolean }) {
  const w = (key: SandboxMessageKey, vars?: Record<string, string | number>) => t(messages, locale, key, vars)
  const owner = current.upload.workspaceId ? (current.workspaces.find((workspace) => workspace.id === current.upload.workspaceId) ?? null) : null
  const others = current.workspaces.filter((workspace) => workspace.id !== current.upload.workspaceId)
  const inProject = ordered(others.filter((workspace) => workspace.inProject))
  const elsewhere = ordered(others.filter((workspace) => !workspace.inProject))
  const rows = (list: readonly SandboxWorkspace[], shown: number) => list.slice(0, shown).map((workspace) => <OtherRow key={workspace.id} workspace={workspace} locale={locale} ready={ready} busy={busy} />)
  const more = (left: number) => w('showMore', { count: left })
  const inProjectShown = read(shownInProject)
  const elsewhereShown = read(shownElsewhere)
  return (
    <Group title={w('groupWorkspaces')}>
      {current.upload.workspaceId ? (
        <Owner current={current} workspace={owner} locale={locale} ready={ready} busy={busy} />
      ) : current.workspaces.length > 0 ? (
        <NoticeLine tone="off" text={w('noOwner')} />
      ) : null}
      {current.workspaces.length === 0 ? <Empty title={w('noWorkspacesTitle')} guidance={w('noWorkspacesGuidance')} icon="folder" /> : rows(inProject, inProjectShown)}
      <ShowMore shown={inProjectShown} total={inProject.length} label={more} onPress={() => set(shownInProject, inProjectShown + PAGE_SIZE)} />
      {elsewhere.length > 0 ? (
        <Collapsible title={w('otherProjects', { count: elsewhere.length })}>
          <Stack gap="xs">
            {rows(elsewhere, elsewhereShown)}
            <ShowMore shown={elsewhereShown} total={elsewhere.length} label={more} onPress={() => set(shownElsewhere, elsewhereShown + PAGE_SIZE)} />
          </Stack>
        </Collapsible>
      ) : null}
      {current.pendingDeletes > 0 ? <NoticeLine tone="off" text={w('pendingDeletes', { count: current.pendingDeletes })} /> : null}
    </Group>
  )
}

/**
 * Versions of workspaces no longer listed: deleted only by a press on its button, then on the
 * confirming one. One whose project is hidden from the sidebar (or may be) has no button: the
 * list may leave its workspace out.
 */
function LeftoversGroup({ current, locale, ready, busy }: { current: SandboxStatus; locale: string; ready: boolean; busy: boolean }) {
  const w = (key: SandboxMessageKey) => t(messages, locale, key)
  if (current.leftovers.length === 0) return null
  const picked = read(chosenLeftover)
  return (
    <Group title={w('groupLeftovers')}>
      {current.leftovers.map((leftover) => {
        if (!leftover.checkable) return <ListRow key={leftover.workspaceId} tone="off" title={leftover.codeVersion} note={w('noteHiddenProject')} />
        const confirming = picked === leftover.workspaceId
        const actions = confirming ? (
          <Row align="center" gap="xs">
            <Button size="xs" variant="solid" icon="delete" disabled={busy || !ready} onPress={() => void act('sandbox.forget', leftover.workspaceId)}>
              {w('deleteVersion')}
            </Button>
            <IconButton icon="close" size="xs" variant="ghost" label={w('cancel')} onPress={() => set(chosenLeftover, null)} />
          </Row>
        ) : (
          <IconButton icon="delete" size="xs" variant="ghost" label={w('deleteVersion')} disabled={busy || !ready} onPress={() => set(chosenLeftover, leftover.workspaceId)} />
        )
        return <ListRow key={leftover.workspaceId} tone={confirming ? 'attention' : 'off'} title={leftover.codeVersion} note={w('noteNotListed')} current={confirming} actions={actions} />
      })}
    </Group>
  )
}

/** What helps after a side action failed on its own: trying it again, or a deploy for a lost change. */
function problemFix(action: SandboxAction, locale: string, busy: boolean): NoticeAction | undefined {
  const w = (key: SandboxMessageKey) => t(messages, locale, key)
  const again: Partial<Record<SandboxAction, ActionRequest>> = { start: 'sandbox.start', stop: 'sandbox.stop', reload: 'sandbox.reload', upload: 'sandbox.deploy' }
  const request = again[action]
  if (!request) return undefined
  return { label: request === 'sandbox.deploy' ? w('deployAgain') : w('retry'), icon: request === 'sandbox.deploy' ? 'upload' : 'refresh', disabled: busy, onPress: () => void act(request) }
}

/** The view, or null until the first state arrives. */
export function renderSandbox(locale: string): OrcaNode {
  const w = (key: SandboxMessageKey) => t(messages, locale, key)
  const current = read(status)
  const failure = read(loadError)
  if (!current) {
    return failure ? <ErrorState title={w('loadFailedTitle')} message={wordSandboxError(locale, failure)} retryLabel={w('retry')} onRetry={() => void load()} /> : null
  }
  const ready = current.config === 'ok' && current.role === 'ready'
  const busy = read(pending) !== null
  const refusal = read(refused)
  const problem = current.problem
  return (
    <Stack gap="md">
      {refusal ? <Refusal refusal={refusal} locale={locale} /> : null}
      {!ready ? <NoticeLine tone="attention" text={w('notReady')} action={{ label: w('openSetup'), icon: 'settings', onPress: openSetup }} /> : null}
      {ready && problem && problem.action !== 'status' ? (
        <Notice tone="attention" title={w(`problem.${problem.action}`)} detail={wordSandboxError(locale, problem.code)} action={problemFix(problem.action, locale, busy)} />
      ) : null}
      <SandboxGroup current={current} locale={locale} ready={ready} busy={busy} />
      <WorkspacesGroup current={current} locale={locale} ready={ready} busy={busy} />
      <LeftoversGroup current={current} locale={locale} ready={ready} busy={busy} />
    </Stack>
  )
}

export const section: PanelSection = {
  id: 'sandbox',
  icon: 'cloud',
  title: (locale) => t(messages, locale, 'title'),
  delivered: true,
  hasView: true,
  setup(ctx: PanelContext) {
    lastJson = ''
    ctx.subscriptions.push(plugin.on('sandbox.changed', (next) => keepStatus(next)))
    void load()
  },
  render: renderSandbox
}
