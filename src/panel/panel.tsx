// The SFCC sidebar panel: a bar with one view per delivered piece that has something to show,
// a compact line with the state of the four environments (and of b2c, only when it is missing),
// the active view under it, and a setup view that says that state and how to fix it. While no
// piece has a view, the setup view is the whole panel and there is no bar. Every text comes from
// src/core/i18n.ts or the piece's own table, in Orca's language. It never shows a host, a path or
// a credential.
//
// What the panel knows of a piece is its section (src/panel/sections.ts): the name, whether it is
// delivered and has a view, what it listens to and what it draws. Nothing here names a piece.
import {
  atom,
  Box,
  Button,
  env,
  Heading,
  IconButton,
  plugin,
  read,
  Row,
  set,
  settings,
  Skeleton,
  Separator,
  Stack,
  Text,
  type IconName,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { CORE_MESSAGES, t, wordError, type CoreMessageKey } from '../core/i18n'
import { ROLES, type ConfigState, type Role, type RoleState } from '../core/instances'
import type { PanelSection, PieceId } from '../core/piece'
import type { CoreStatus } from '../protocol'
import { lastView } from './navigation'
import { SECTIONS } from './sections'
import { ErrorState, Group, LabelledRow, ListRow, Notice, StateBadge, TONES, type StateTone } from './ui'
import { BAR_KEY, FAILED_VIEW_KEY, SETUP_VIEW, viewBoxKey } from './views'

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
/**
 * The view whose `render` threw last, kept across runs: opening the panel on it again would only
 * show the same failure, so the next open goes to the setup view instead. A good render clears it.
 */
const failedView = atom<string | null>(FAILED_VIEW_KEY, null, { persist: 'plugin' })
/** Raised by *Try again* on a view whose render threw, so the view is drawn again. */
const attempt = atom(0)

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

/**
 * Each state of an environment: its words, its tone, so colour is never the only sign its icon,
 * and, when it is not ready, why in a few words.
 */
const ROLE_STATES: Record<RoleState, { key: CoreMessageKey; tone: StateTone; icon: IconName; reason: CoreMessageKey | null }> = {
  ready: { key: 'roleReady', tone: 'ok', icon: 'check', reason: null },
  incomplete: { key: 'roleIncomplete', tone: 'attention', icon: 'warning', reason: 'incompleteReason' },
  absent: { key: 'roleAbsent', tone: 'off', icon: 'remove', reason: 'absentReason' }
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
type Attention = { key: CoreMessageKey; tone: StateTone }

function attentionOf(current: CoreStatus | null, failure: string | null, failedPieces: number): Attention | null {
  if (failure) return { key: 'attentionUnreadable', tone: 'failed' }
  if (current?.config === 'invalid') return { key: 'attentionConfigInvalid', tone: 'failed' }
  if (current && !current.b2c.found) return { key: 'attentionB2c', tone: 'failed' }
  if (failedPieces > 0) return { key: 'attentionPiece', tone: 'failed' }
  if (current?.config === 'missing') return { key: 'attentionConfigMissing', tone: 'attention' }
  if (current && ROLES.some((role) => current.instances[role] === 'incomplete')) return { key: 'attentionIncomplete', tone: 'attention' }
  return null
}

function RefreshButton({ busy }: { busy: boolean }) {
  return <IconButton icon="refresh" size="sm" variant="ghost" label={text('refresh')} disabled={busy} onPress={() => void load()} />
}

/**
 * One fact of the status line as a small button that opens the setup view: an icon and a short
 * name, with the whole state in its tooltip (`Development: Not configured`). The icon says the
 * state without colour; the tone adds it where Orca draws one.
 */
function StatusChip({ name, tooltip, icon, tone, onPress }: { name: string; tooltip: string; icon: IconName; tone: StateTone; onPress: () => void }) {
  return (
    <Button size="xs" variant="ghost" tone={TONES[tone]} icon={icon} tooltip={tooltip} onPress={onPress}>
      {name}
    </Button>
  )
}

/**
 * The line under the bar: each environment as a `StatusChip`; b2c only when it is missing (its
 * version is in the setup view); and, when something needs attention, what in a few words and a
 * button to the setup view (Orca's buttons take no warning tone, so the words go in a badge).
 */
function StatusLine({ current, failure, busy, attention, onAttention }: { current: CoreStatus | null; failure: string | null; busy: boolean; attention: Attention | null; onAttention?: () => void }) {
  const toSetup = () => set(lastView, SETUP_VIEW)
  let state: OrcaNode = null
  if (current) {
    state = [
      ...ROLES.map((role) => {
        const roleState = ROLE_STATES[current.instances[role]]
        return (
          <StatusChip
            key={role}
            name={text(ROLE_SHORT_KEYS[role])}
            tooltip={text('stateTooltip', { name: text(ROLE_KEYS[role]), state: text(roleState.key) })}
            icon={roleState.icon}
            tone={roleState.tone}
            onPress={toSetup}
          />
        )
      }),
      current.b2c.found ? null : (
        <StatusChip
          key="b2c"
          name={text('b2cShort')}
          tooltip={text('stateTooltip', { name: text('b2c'), state: text('b2cMissing') })}
          icon="close"
          tone="failed"
          onPress={toSetup}
        />
      )
    ]
  } else if (!failure) {
    // A skeleton has no width of its own: the box gives it room in the line.
    state = (
      <Box key="loading" grow minWidth={96}>
        <Skeleton lines={1} label={text('loading')} />
      </Box>
    )
  }
  // One row that wraps item by item; the growing box keeps the buttons on the right.
  return (
    <Row align="center" gap="xs" wrap>
      {state}
      <Box grow />
      {attention ? <StateBadge tone={attention.tone}>{text(attention.key)}</StateBadge> : null}
      {attention && onAttention ? <IconButton icon="settings" size="sm" variant="ghost" label={text('openSetup')} onPress={onAttention} /> : null}
      <RefreshButton busy={busy} />
    </Row>
  )
}

function FailedSection({ section, locale }: { section: PanelSection; locale: string }) {
  return <Notice tone="failed" title={text('sectionFailedTitle', { piece: section.title(locale) })} detail={text('sectionFailedBody')} />
}

/** Each environment: a mark, its name and its state; when it is not ready, why, in a few words. */
function Environments({ current, busy }: { current: CoreStatus; busy: boolean }) {
  const notReady = ROLES.some((role) => current.instances[role] !== 'ready')
  return (
    <Group
      title={text('instances')}
      action={
        notReady ? (
          <Button size="xs" variant="ghost" icon="refresh" disabled={busy} onPress={() => void load()}>
            {text('recheck')}
          </Button>
        ) : undefined
      }
    >
      {ROLES.map((role) => {
        const state = ROLE_STATES[current.instances[role]]
        // Without a file, every environment is absent for the same reason, said once below.
        const reason = state.reason && current.config === 'ok' ? text(state.reason) : undefined
        return <ListRow key={role} tone={state.tone} title={text(ROLE_KEYS[role])} detail={reason} note={text(state.key)} noteTone={state.tone} />
      })}
    </Group>
  )
}

/** Where dw.json is read from, in a word, and its state; when it cannot be used, how to fix it. */
function ConfigFile({ config, custom, busy }: { config: ConfigState; custom: boolean | null; busy: boolean }) {
  const recheck = { label: text('recheck'), icon: 'refresh' as const, disabled: busy, onPress: () => void load() }
  return (
    <Group title={text('configFile')}>
      {custom === null ? null : <LabelledRow label={text('configReadFrom')}>{text(custom ? 'configFromSetting' : 'configFromWorkspace')}</LabelledRow>}
      <LabelledRow label={text('configState')}>
        <StateBadge tone={CONFIG_STATES[config].tone}>{text(CONFIG_STATES[config].key)}</StateBadge>
      </LabelledRow>
      {config === 'invalid' ? <Notice tone="failed" title={text('configInvalidTitle')} detail={text('configInvalidFix')} action={recheck} /> : null}
      {config === 'missing' ? <Notice tone="attention" title={text('configMissingTitle')} detail={text('configMissingFix')} action={recheck} /> : null}
    </Group>
  )
}

/** b2c found, with its version; or not found, why, and how to fix it. */
function B2cState({ value, busy }: { value: CoreStatus['b2c']; busy: boolean }) {
  const state = value.found ? (value.version ? text('b2cFound', { version: value.version }) : text('b2cFoundNoVersion')) : text('b2cMissing')
  return (
    <Group title={text('b2c')}>
      <LabelledRow label={text('configState')}>
        <StateBadge tone={value.found ? 'ok' : 'failed'}>{state}</StateBadge>
      </LabelledRow>
      {value.found ? null : (
        <Notice
          tone="failed"
          title={text('b2cMissingTitle')}
          detail={`${wordError(env.locale, value.reason ?? 'b2c_not_found')} ${text('b2cMissingFix')}`}
          action={{ label: text('recheck'), icon: 'refresh', disabled: busy, onPress: () => void load() }}
        />
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
          <ListRow key={section.id} tone="ok" title={section.title(locale)} note={text('pieceDelivered')} noteTone="ok" />
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
          <Environments current={current} busy={busy} />
          <ConfigFile config={current.config} custom={custom} busy={busy} />
          <B2cState value={current.b2c} busy={busy} />
          <Pieces sections={sections} failed={failed} locale={locale} />
          <Text size="sm" muted>
            {text('settingsHint')}
          </Text>
        </Stack>
      ) : failure ? null : (
        <Skeleton lines={4} label={text('loading')} />
      )}
    </Stack>
  )
}

/** An element as Orca's runtime builds it: what `drawNow` needs of it. */
type DrawnElement = { readonly $$typeof: symbol; readonly type: unknown; readonly props: Record<string, unknown>; readonly key?: unknown }

function isDrawnElement(node: unknown): node is DrawnElement {
  return typeof node === 'object' && node !== null && '$$typeof' in node && 'type' in node && 'props' in node
}

/**
 * The tree a section returned, with the components in it already called. Orca calls them only
 * once the panel's draw has returned, so a component that throws would escape `PieceView`'s guard
 * and blank the whole panel; calling them here, as Orca would (components have no hooks), lets the
 * guard catch it. Anything that does not look like an element is left for Orca to judge.
 */
function drawNow(node: OrcaNode, depth = 0): OrcaNode {
  if (depth > 256) return node
  if (Array.isArray(node)) return node.map((child: OrcaNode) => drawNow(child, depth + 1))
  if (!isDrawnElement(node)) return node
  if (typeof node.type === 'function') {
    const drawn = drawNow((node.type as (props: Record<string, unknown>) => OrcaNode)(node.props), depth + 1)
    // A key given to the component (a row of a list) stays on what it drew.
    return node.key !== undefined && node.key !== null && isDrawnElement(drawn) && (drawn.key === undefined || drawn.key === null) ? ({ ...drawn, key: node.key } as OrcaNode) : drawn
  }
  if (!('children' in node.props)) return node
  return { ...node, props: { ...node.props, children: drawNow(node.props.children as OrcaNode, depth + 1) } } as OrcaNode
}

/** Records, after this draw, which view's render threw last; atoms cannot change while drawing. */
function noteFailedRender(view: string | null): void {
  void Promise.resolve().then(() => {
    if (read(failedView) !== view) set(failedView, view)
  })
}

/**
 * A piece's view: its body; a loading placeholder until the piece has its first answer (`render`
 * returns null); why it did not start; or, when its `render` throws, an error state with a retry,
 * so the bar and the status line stay and the person can go elsewhere.
 */
function PieceView({ section, failed, locale }: { section: PanelSection; failed: boolean; locale: string }) {
  if (failed) return <FailedSection section={section} locale={locale} />
  read(attempt)
  let body: OrcaNode
  try {
    body = drawNow(section.render(locale))
  } catch {
    noteFailedRender(section.id)
    return (
      <ErrorState
        title={text('viewFailedTitle', { piece: section.title(locale) })}
        message={text('viewFailedBody')}
        retryLabel={text('tryAgain')}
        onRetry={() => set(attempt, read(attempt) + 1)}
      />
    )
  }
  if (read(failedView) === section.id) noteFailedRender(null)
  return body === null || body === undefined || body === false ? <Skeleton lines={3} label={text('viewLoading', { piece: section.title(locale) })} /> : body
}

/**
 * The bar: one button per view, the open one solid, wrapping onto a second line when the sidebar
 * is narrow (a tab strip would scroll the whole panel sideways). The setup view is the last.
 */
function Bar({ views, active, locale }: { views: readonly PanelSection[]; active: string; locale: string }) {
  const pick = (view: string) => () => set(lastView, view)
  return (
    <Row align="center" gap="xs" wrap>
      {views.map((section) => (
        <Button key={`bar-${section.id}`} size="sm" variant={section.id === active ? 'solid' : 'ghost'} icon={section.icon} onPress={pick(section.id)}>
          {section.title(locale)}
        </Button>
      ))}
      <Button key={`bar-${SETUP_VIEW}`} size="sm" variant={active === SETUP_VIEW ? 'solid' : 'ghost'} icon="settings" onPress={pick(SETUP_VIEW)}>
        {text('setup')}
      </Button>
    </Row>
  )
}

/**
 * The view to draw: the first piece's until one is picked; then the one picked while it still
 * exists, else the setup view.
 */
function activeView(views: readonly PanelSection[], stored: string | null): string {
  if (stored === null) return views[0]?.id ?? SETUP_VIEW
  if (stored === SETUP_VIEW || views.some((section) => section.id === stored)) return stored
  return SETUP_VIEW
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
      // The view whose render threw on the last open is not opened again: the setup view is.
      const lastFailed = read(failedView)
      if (lastFailed !== null) {
        if (read(lastView) === lastFailed) set(lastView, SETUP_VIEW)
        set(failedView, null)
      }
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
          <Stack key={viewBoxKey(SETUP_VIEW)} gap="md">
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
      const open = views.find((section) => section.id === active)
      return (
        <Stack gap="sm">
          <Bar key={BAR_KEY} views={views} active={active} locale={locale} />
          <Separator />
          <StatusLine current={current} failure={failure} busy={busy} attention={attention} onAttention={open ? () => set(lastView, SETUP_VIEW) : undefined} />
          <Box key={viewBoxKey(active)} paddingY="xs">
            {open ? (
              <PieceView section={open} failed={failed.includes(open.id)} locale={locale} />
            ) : (
              <SetupView sections={sections} failed={failed} locale={locale} busy={busy} />
            )}
          </Box>
        </Stack>
      )
    }
  }
}

const panel = createPanel(SECTIONS)

export const setup = panel.setup
export default panel.Panel
