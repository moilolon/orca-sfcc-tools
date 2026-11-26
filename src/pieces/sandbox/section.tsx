// The sandbox piece's view, listed in src/panel/sections.ts: the sandbox's state with start and
// stop, the upload (which workspace, its code version, when it last deployed and uploaded) with
// its actions, and the list of workspaces to pick the one that uploads. Built only from the blocks
// of src/panel/ui.tsx and Orca's components. It shows workspace names and code versions, never a
// host, a path or anything b2c printed: failures arrive as codes and are worded here.
import { atom, Button, Callout, IconButton, plugin, read, RelativeTime, set, Stack, Text, type OrcaNode, type PanelContext } from 'orca'
import { t } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { Actions, Empty, ErrorState, Group, LabelledRow, ListRow, StateBadge, type StateTone } from '../../panel/ui'
import { messages, wordSandboxError, type SandboxMessageKey } from './i18n'
import type { SandboxStatus, SandboxWorkspace, UploadState } from './protocol'

const status = atom<SandboxStatus | null>(null)
/** Why the first state could not be read: an error code. */
const loadError = atom<string | null>(null)
/** The request in flight, so its buttons wait. */
const pending = atom<string | null>(null)
/** Why the last action was refused: an error code, until the next action. */
const refused = atom<string | null>(null)
/** The workspace pressed in the list, waiting for *Upload from this one*. */
const chosen = atom<string | null>(null)

type ActionRequest = 'sandbox.refresh' | 'sandbox.release' | 'sandbox.deploy' | 'sandbox.reload' | 'sandbox.start' | 'sandbox.stop'

function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'action_failed'
}

async function load(): Promise<void> {
  try {
    set(status, await plugin.request('sandbox.status', {}))
    set(loadError, null)
  } catch (error) {
    set(loadError, codeOf(error))
  }
}

async function act(name: ActionRequest | 'sandbox.pick', workspaceId?: string): Promise<void> {
  set(pending, name)
  set(refused, null)
  try {
    const next = name === 'sandbox.pick' ? await plugin.request('sandbox.pick', { workspaceId: workspaceId ?? '' }, { timeoutMs: 60_000 }) : await plugin.request(name, {}, { timeoutMs: 90_000 })
    set(status, next)
    if (name === 'sandbox.pick') set(chosen, null)
  } catch (error) {
    set(refused, codeOf(error))
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

const UPLOAD_STATES: Record<UploadState, { key: SandboxMessageKey; tone: StateTone }> = {
  none: { key: 'uploadNone', tone: 'off' },
  deploying: { key: 'uploadDeploying', tone: 'busy' },
  watching: { key: 'uploadWatching', tone: 'ok' },
  uploading: { key: 'uploadUploading', tone: 'busy' },
  failed: { key: 'uploadFailed', tone: 'failed' }
}

function when(at: number | null, never: string): OrcaNode {
  return at ? <RelativeTime at={at} /> : never
}

function SandboxGroup({ current, locale, ready, busy }: { current: SandboxStatus; locale: string; ready: boolean; busy: boolean }) {
  const w = (key: SandboxMessageKey) => t(messages, locale, key)
  const { state, following, reason, checkedAt } = current.sandbox
  const shown = following === 'start' ? { key: 'stateStarting' as const, tone: 'busy' as const } : following === 'stop' ? { key: 'stateStopping' as const, tone: 'busy' as const } : SANDBOX_STATES[state]
  return (
    <Group
      title={w('groupSandbox')}
      action={<IconButton icon="refresh" size="sm" variant="ghost" label={w('refresh')} disabled={busy} onPress={() => void act('sandbox.refresh')} />}
    >
      <LabelledRow label={w('state')}>
        <StateBadge tone={shown.tone}>{w(shown.key)}</StateBadge>
      </LabelledRow>
      <LabelledRow label={w('checked')}>{when(checkedAt, w('neverChecked'))}</LabelledRow>
      {state === 'unknown' && reason && ready ? (
        <Text size="sm" muted>
          {wordSandboxError(locale, reason)}
        </Text>
      ) : null}
      {ready && !following && (state === 'stopped' || state === 'started') ? (
        <Actions>
          {state === 'stopped' ? (
            <Button size="sm" variant="solid" icon="play" tooltip={w('tipStart')} disabled={busy} onPress={() => void act('sandbox.start')}>
              {w('start')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" icon="stop" disabled={busy} onPress={() => void act('sandbox.stop')}>
              {w('stop')}
            </Button>
          )}
        </Actions>
      ) : null}
    </Group>
  )
}

function UploadGroup({ current, locale, ready, busy }: { current: SandboxStatus; locale: string; ready: boolean; busy: boolean }) {
  const w = (key: SandboxMessageKey) => t(messages, locale, key)
  const { upload } = current
  if (!upload.workspaceId) {
    return (
      <Group title={w('groupUpload')}>
        <Empty title={w('noOwnerTitle')} guidance={w('noOwnerGuidance')} icon="upload" />
      </Group>
    )
  }
  const shown = UPLOAD_STATES[upload.state]
  const deploying = upload.state === 'deploying'
  return (
    <Group title={w('groupUpload')}>
      <LabelledRow label={w('state')}>
        <StateBadge tone={shown.tone}>{w(shown.key)}</StateBadge>
      </LabelledRow>
      <LabelledRow label={w('from')}>{upload.workspaceName ?? ''}</LabelledRow>
      <LabelledRow label={w('codeVersion')}>{upload.codeVersion ?? ''}</LabelledRow>
      <LabelledRow label={w('lastDeploy')}>{when(upload.lastDeployAt, w('never'))}</LabelledRow>
      <LabelledRow label={w('lastUpload')}>{when(upload.lastUploadAt, w('never'))}</LabelledRow>
      {upload.files > 0 ? <LabelledRow label={w('filesSent')}>{String(upload.files)}</LabelledRow> : null}
      {upload.state === 'failed' ? <ErrorState title={w('failedTitle')} message={wordSandboxError(locale, upload.reason ?? 'action_failed')} /> : null}
      {upload.state === 'watching' || upload.state === 'uploading' ? (
        <Text size="sm" muted>
          {w('restoredHint')}
        </Text>
      ) : null}
      <Actions>
        <Button size="sm" variant="solid" icon="upload" tooltip={w('tipDeploy')} disabled={busy || deploying || !ready} onPress={() => void act('sandbox.deploy')}>
          {w('deployAgain')}
        </Button>
        <Button size="sm" variant="outline" icon="refresh" disabled={busy || deploying || upload.reloading || !ready} onPress={() => void act('sandbox.reload')}>
          {upload.reloading ? w('reloading') : w('reload')}
        </Button>
        <Button size="sm" variant="outline" icon="stop" disabled={busy} onPress={() => void act('sandbox.release')}>
          {w('release')}
        </Button>
      </Actions>
    </Group>
  )
}

/** The owner first, then the other local workspaces, then those on another machine. */
function ordered(list: readonly SandboxWorkspace[]): SandboxWorkspace[] {
  const rank = (workspace: SandboxWorkspace) => (workspace.owner ? 0 : workspace.local ? 1 : 2)
  return [...list].sort((a, b) => rank(a) - rank(b))
}

function WorkspacesGroup({ current, locale, ready, busy }: { current: SandboxStatus; locale: string; ready: boolean; busy: boolean }) {
  const w = (key: SandboxMessageKey, vars?: Record<string, string | number>) => t(messages, locale, key, vars)
  const picked = read(chosen)
  const candidate = current.workspaces.find((workspace) => workspace.id === picked && workspace.local && !workspace.owner) ?? null
  return (
    <Group title={w('groupWorkspaces')}>
      {current.workspaces.length === 0 ? (
        <Empty title={w('noWorkspacesTitle')} guidance={w('noWorkspacesGuidance')} icon="folder" />
      ) : (
        ordered(current.workspaces).map((workspace) =>
          workspace.owner ? (
            <ListRow key={workspace.id} tone={UPLOAD_STATES[current.upload.state].tone} title={workspace.name} note={w('noteUploads')} noteTone="ok" current />
          ) : !workspace.local ? (
            <ListRow key={workspace.id} tone="off" title={workspace.name} note={w('noteRemote')} />
          ) : (
            <ListRow
              key={workspace.id}
              tone="off"
              title={workspace.name}
              note={workspace.id === candidate?.id ? w('notePicked') : undefined}
              noteTone="busy"
              current={workspace.id === candidate?.id}
              onPress={() => set(chosen, workspace.id === picked ? null : workspace.id)}
            />
          )
        )
      )}
      {candidate ? (
        <Actions>
          <Button size="sm" variant="solid" icon="upload" tooltip={w('tipPick')} disabled={busy || !ready} onPress={() => void act('sandbox.pick', candidate.id)}>
            {w('uploadFromThis')}
          </Button>
        </Actions>
      ) : current.workspaces.some((workspace) => workspace.local && !workspace.owner) ? (
        <Text size="sm" muted>
          {w('pickGuidance')}
        </Text>
      ) : null}
      {current.pendingDeletes > 0 ? (
        <Text size="sm" muted>
          {w('pendingDeletes', { count: current.pendingDeletes })}
        </Text>
      ) : null}
    </Group>
  )
}

/** The view, or null until the first state arrives. */
export function renderSandbox(locale: string): OrcaNode {
  const w = (key: SandboxMessageKey) => t(messages, locale, key)
  const current = read(status)
  const failure = read(loadError)
  if (!current) {
    return failure ? <ErrorState title={w('actionFailedTitle')} message={wordSandboxError(locale, failure)} retryLabel={w('refresh')} onRetry={() => void load()} /> : null
  }
  const ready = current.config === 'ok' && current.role === 'ready'
  const busy = read(pending) !== null
  const refusal = read(refused)
  const problem = current.problem
  return (
    <Stack gap="md">
      {refusal ? (
        <Callout tone="danger" icon="error" title={w('actionFailedTitle')}>
          <Text>{wordSandboxError(locale, refusal)}</Text>
        </Callout>
      ) : null}
      {!ready ? (
        <Callout tone="warning" icon="warning" title={w('notReadyTitle')}>
          <Text>{w('notReadyBody')}</Text>
        </Callout>
      ) : null}
      {ready && problem && problem.action !== 'status' ? (
        <Callout tone="warning" icon="warning" title={w(`problem.${problem.action}`)}>
          <Text>{wordSandboxError(locale, problem.code)}</Text>
        </Callout>
      ) : null}
      <SandboxGroup current={current} locale={locale} ready={ready} busy={busy} />
      <UploadGroup current={current} locale={locale} ready={ready} busy={busy} />
      <WorkspacesGroup current={current} locale={locale} ready={ready} busy={busy} />
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
    ctx.subscriptions.push(plugin.on('sandbox.changed', (next) => set(status, next)))
    void load()
  },
  render: renderSandbox
}
