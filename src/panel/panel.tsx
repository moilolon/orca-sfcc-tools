// The SFCC sidebar panel: a bar with one view per delivered piece that has something to show,
// a compact line with the state of the four environments and of b2c, the active view under it,
// and a setup view that explains that state and how to fix it. While no piece has a view, the
// setup view is the whole panel and there is no bar. Every text comes from src/core/i18n.ts or
// the piece's own table, in Orca's language. It never shows a host, a path or a credential.
//
// What the panel knows of a piece is its section (src/panel/sections.ts): the name, whether it is
// delivered and has a view, what it listens to and what it draws. Nothing here names a piece.
import {
  atom,
  Button,
  Callout,
  env,
  Heading,
  IconButton,
  plugin,
  read,
  Row,
  set,
  settings,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Text,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { CORE_MESSAGES, t, wordError, type CoreMessageKey } from '../core/i18n'
import { ROLES, type ConfigState, type Role, type RoleState } from '../core/instances'
import type { PanelSection, PieceId } from '../core/piece'
import type { CoreStatus } from '../protocol'
import { SECTIONS } from './sections'
import { Empty, ErrorState, Group, LabelledRow, ListRow, StateBadge, type StateTone } from './ui'

/** The value of the setup view in the bar; every other view is a piece id. */
const SETUP_VIEW = 'setup'

const status = atom<CoreStatus | null>(null)
const loading = atom(false)
/** An error code, the worker's or the host's, worded when drawn. The next good answer clears it. */
const problem = atom<string | null>(null)
/**
 * The pieces whose section could not start. Nothing clears it but opening the panel again: a
 * section that did not start listens to nothing, so what it would draw is not to be trusted.
 */
const broken = atom<readonly PieceId[]>([])
/** Whether a setting names the configuration file; null when the setting could not be read. */
const customFile = atom<boolean | null>(null)
/** The view last picked in the bar, kept across runs of the plugin. Read through `activeView`. */
const lastView = atom<string | null>('view', null, { persist: 'plugin' })

const ROLE_KEYS: Record<Role, CoreMessageKey> = {
  sandbox: 'roleSandbox',
  development: 'roleDevelopment',
  staging: 'roleStaging',
  production: 'roleProduction'
}

const ROLE_SHORT_KEYS: Record<Role, CoreMessageKey> = {
  sandbox: 'roleShortSandbox',
  development: 'roleShortDevelopment',
  staging: 'roleShortStaging',
  production: 'roleShortProduction'
}

const ROLE_STATES: Record<RoleState, { key: CoreMessageKey; tone: StateTone }> = {
  ready: { key: 'roleReady', tone: 'ok' },
  incomplete: { key: 'roleIncomplete', tone: 'attention' },
  absent: { key: 'roleAbsent', tone: 'off' }
}

const CONFIG_STATES: Record<ConfigState, { key: CoreMessageKey; tone: StateTone }> = {
  ok: { key: 'configOk', tone: 'ok' },
  missing: { key: 'configMissing', tone: 'attention' },
  invalid: { key: 'configInvalid', tone: 'failed' }
}

function text(key: CoreMessageKey, vars?: Record<string, string | number>): string {
  return t(CORE_MESSAGES, env.locale, key, vars)
}

/** The code of a rejection; one without a code is the panel's own `action_failed`. */
function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'action_failed'
}

/** Whether the person named another configuration file in Settings; only that, never the path. */
async function readCustomFile(): Promise<boolean | null> {
  try {
    const value = await settings.get('configFile')
    return typeof value === 'string' && value.trim() !== ''
  } catch {
    return null
  }
}

async function load(): Promise<void> {
  set(loading, true)
  const file = readCustomFile()
  try {
    set(status, await plugin.request('core.status', { locale: env.locale }, { timeoutMs: 60_000 }))
    set(problem, null)
  } catch (error) {
    set(problem, codeOf(error))
  } finally {
    set(customFile, await file)
    set(loading, false)
  }
}

/** What needs the person's attention first, worded in a few words for the status line. */
type Attention = { key: CoreMessageKey; tone: 'danger' | 'warning' }

function attentionOf(current: CoreStatus | null, failure: string | null, failedPieces: number): Attention | null {
  if (failure) return { key: 'attentionUnreadable', tone: 'danger' }
  if (current?.config === 'invalid') return { key: 'attentionConfigInvalid', tone: 'danger' }
  if (current && !current.b2c.found) return { key: 'attentionB2c', tone: 'danger' }
  if (failedPieces > 0) return { key: 'attentionPiece', tone: 'danger' }
  if (current?.config === 'missing') return { key: 'attentionConfigMissing', tone: 'warning' }
  if (current && ROLES.some((role) => current.instances[role] === 'incomplete')) return { key: 'attentionIncomplete', tone: 'warning' }
  return null
}

function RefreshButton({ busy }: { busy: boolean }) {
  return <IconButton icon="refresh" size="sm" variant="ghost" label={text('refresh')} disabled={busy} onPress={() => void load()} />
}

/**
 * The line under the bar: each environment by tone, the b2c version, and, when something needs
 * attention, a button that says what and opens the setup view.
 */
function StatusLine({ current, failure, busy, attention, onAttention }: { current: CoreStatus | null; failure: string | null; busy: boolean; attention: Attention | null; onAttention?: () => void }) {
  let state: OrcaNode = null
  if (current) {
    const b2c = current.b2c.found ? (
      <Text key="b2c" size="sm" muted>
        {text('b2cShort', { version: current.b2c.version ?? '' }).trim()}
      </Text>
    ) : (
      <StateBadge key="b2c" tone="failed">
        {text('b2cShort', { version: '' }).trim()}
      </StateBadge>
    )
    state = [
      ...ROLES.map((role) => (
        <StateBadge key={role} tone={ROLE_STATES[current.instances[role]].tone}>
          {text(ROLE_SHORT_KEYS[role])}
        </StateBadge>
      )),
      b2c
    ]
  } else if (!failure) {
    state = <Skeleton lines={1} label={text('loading')} />
  }
  return (
    <Row justify="between" align="center" gap="sm" wrap>
      <Row align="center" gap="xs" wrap>
        {state}
      </Row>
      <Row align="center" gap="xs">
        {attention && onAttention ? (
          <Button size="xs" variant="ghost" tone={attention.tone} icon="warning" onPress={onAttention}>
            {text(attention.key)}
          </Button>
        ) : null}
        <RefreshButton busy={busy} />
      </Row>
    </Row>
  )
}

function FailedSection({ section, locale }: { section: PanelSection; locale: string }) {
  return (
    <Callout tone="danger" icon="error" title={text('sectionFailedTitle', { piece: section.title(locale) })}>
      <Text>{text('sectionFailedBody')}</Text>
    </Callout>
  )
}

function Environments({ current }: { current: CoreStatus }) {
  const states = ROLES.map((role) => current.instances[role])
  return (
    <Group title={text('instances')}>
      {ROLES.map((role) => (
        <LabelledRow key={role} label={text(ROLE_KEYS[role])}>
          <StateBadge tone={ROLE_STATES[current.instances[role]].tone}>{text(ROLE_STATES[current.instances[role]].key)}</StateBadge>
        </LabelledRow>
      ))}
      {states.includes('incomplete') ? (
        <Text size="sm" muted>
          {text('incompleteHint')}
        </Text>
      ) : null}
      {current.config === 'ok' && states.includes('absent') ? (
        <Text size="sm" muted>
          {text('absentHint')}
        </Text>
      ) : null}
    </Group>
  )
}

function ConfigFile({ config, custom }: { config: ConfigState; custom: boolean | null }) {
  const hint = custom === null ? 'configFromUnknownHint' : custom ? 'configFromSettingHint' : 'configFromWorkspaceHint'
  return (
    <Group title={text('configFile')}>
      {custom === null ? null : <LabelledRow label={text('configReadFrom')}>{text(custom ? 'configFromSetting' : 'configFromWorkspace')}</LabelledRow>}
      <LabelledRow label={text('configState')}>
        <StateBadge tone={CONFIG_STATES[config].tone}>{text(CONFIG_STATES[config].key)}</StateBadge>
      </LabelledRow>
      <Text size="sm" muted>
        {`${text(hint)} ${text('neverShown')}`}
      </Text>
      {config === 'invalid' ? (
        <Callout tone="danger" icon="error" title={text('configInvalidTitle')}>
          <Text>{text('configInvalidBody')}</Text>
        </Callout>
      ) : null}
      {config === 'missing' ? (
        <Callout tone="warning" icon="info" title={text('configMissingTitle')}>
          <Text>{text('configMissingBody')}</Text>
        </Callout>
      ) : null}
    </Group>
  )
}

function B2cState({ value }: { value: CoreStatus['b2c'] }) {
  const state = value.found ? (value.version ? text('b2cFound', { version: value.version }) : text('b2cFoundNoVersion')) : text('b2cMissing')
  return (
    <Group title={text('b2c')}>
      <LabelledRow label={text('configState')}>
        <StateBadge tone={value.found ? 'ok' : 'failed'}>{state}</StateBadge>
      </LabelledRow>
      {value.found ? null : (
        <Callout tone="warning" icon="warning" title={text('b2cMissingTitle')}>
          <Stack gap="xs">
            <Text>{wordError(env.locale, value.reason ?? 'b2c_not_found')}</Text>
            <Text>{text('b2cMissingBody')}</Text>
          </Stack>
        </Callout>
      )}
    </Group>
  )
}

/** The delivered pieces, and any whose section did not start, listed discreetly. */
function Pieces({ sections, failed, locale }: { sections: readonly PanelSection[]; failed: readonly PieceId[]; locale: string }) {
  const listed = sections.filter((section) => section.delivered || failed.includes(section.id))
  if (listed.length === 0) return null
  return (
    <Group title={text('pieces')}>
      {listed.map((section) =>
        failed.includes(section.id) ? (
          <ListRow key={section.id} tone="failed" title={section.title(locale)} note={text('pieceFailed')} noteTone="failed" />
        ) : (
          <ListRow key={section.id} tone="ok" title={section.title(locale)} note={text('pieceDelivered')} />
        )
      )}
    </Group>
  )
}

function SetupView({ sections, failed, locale, busy }: { sections: readonly PanelSection[]; failed: readonly PieceId[]; locale: string; busy: boolean }) {
  const current = read(status)
  const failure = read(problem)
  const custom = read(customFile)
  return (
    <Stack gap="md">
      {failure ? <ErrorState title={text('errorTitle')} message={wordError(locale, failure)} retryLabel={text('tryAgain')} busy={busy} onRetry={() => void load()} /> : null}
      {sections
        .filter((section) => failed.includes(section.id))
        .map((section) => (
          <FailedSection key={section.id} section={section} locale={locale} />
        ))}
      {current ? (
        <Stack gap="md">
          <Environments current={current} />
          <ConfigFile config={current.config} custom={custom} />
          <B2cState value={current.b2c} />
          <Pieces sections={sections} failed={failed} locale={locale} />
        </Stack>
      ) : failure ? null : (
        <Skeleton lines={4} label={text('loading')} />
      )}
    </Stack>
  )
}

/** A piece's view: its body, an empty state while it has nothing, or why it did not start. */
function PieceView({ section, failed, locale }: { section: PanelSection; failed: boolean; locale: string }) {
  if (failed) return <FailedSection section={section} locale={locale} />
  const body = section.render(locale)
  return body === null || body === undefined || body === false ? <Empty title={text('emptyTitle')} guidance={text('emptyGuidance')} icon={section.icon} /> : body
}

/** The view to draw: the one last picked while it still exists, else the first piece's. */
function activeView(views: readonly PanelSection[], stored: string | null): string {
  if (stored === SETUP_VIEW || views.some((section) => section.id === stored)) return stored as string
  return views[0]?.id ?? SETUP_VIEW
}

/**
 * The panel over a list of sections: `setup` and the component Orca mounts. The plugin's panel is
 * `createPanel(SECTIONS)`; tests build one over sections of their own.
 */
export function createPanel(sections: readonly PanelSection[]): { setup(ctx: PanelContext): void; Panel(): OrcaNode } {
  const views = sections.filter((section) => section.delivered && section.hasView)
  return {
    setup(ctx) {
      ctx.subscriptions.push(plugin.on('core.changed', () => void load()))
      const failed: PieceId[] = []
      for (const section of sections) {
        // A section that fails to start must not take the panel, or the other sections, with it.
        try {
          const cleanup = section.setup?.(ctx)
          if (typeof cleanup === 'function') ctx.subscriptions.push({ dispose: cleanup })
        } catch {
          failed.push(section.id)
        }
      }
      set(broken, failed)
      void load()
    },
    Panel() {
      const current = read(status)
      const busy = read(loading)
      const failure = read(problem)
      const failed = read(broken)
      const locale = env.locale

      // No piece to show: the setup view alone, with no bar that would offer one choice.
      if (views.length === 0) {
        return (
          <Stack gap="md">
            <Row justify="between" align="center">
              <Heading level={2}>{text('setup')}</Heading>
              <RefreshButton busy={busy} />
            </Row>
            <SetupView sections={sections} failed={failed} locale={locale} busy={busy} />
          </Stack>
        )
      }

      const active = activeView(views, read(lastView))
      const attention = attentionOf(current, failure, failed.length)
      const line = (onAttention?: () => void) => <StatusLine current={current} failure={failure} busy={busy} attention={attention} onAttention={onAttention} />
      const toSetup = () => set(lastView, SETUP_VIEW)
      return (
        <Tabs label={text('views')} value={active} onChange={(value) => set(lastView, value)}>
          {views.map((section) => (
            <Tab key={section.id} value={section.id} label={section.title(locale)} icon={section.icon}>
              {section.id === active ? (
                <Stack gap="md">
                  {line(toSetup)}
                  <PieceView section={section} failed={failed.includes(section.id)} locale={locale} />
                </Stack>
              ) : null}
            </Tab>
          ))}
          <Tab key={SETUP_VIEW} value={SETUP_VIEW} label={text('setup')} icon="settings">
            {active === SETUP_VIEW ? (
              <Stack gap="md">
                {line()}
                <SetupView sections={sections} failed={failed} locale={locale} busy={busy} />
              </Stack>
            ) : null}
          </Tab>
        </Tabs>
      )
    }
  }
}

const panel = createPanel(SECTIONS)

export const setup = panel.setup
export default panel.Panel
