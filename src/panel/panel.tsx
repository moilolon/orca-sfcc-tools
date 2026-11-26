// The SFCC sidebar panel: the setup (b2c, what dw.json configures, the pieces), then one section
// per piece (src/panel/sections.ts). Every text comes from src/core/i18n.ts or the piece's own
// table, in Orca's language. It never shows a host, a path or a credential.
//
// What the panel knows of a piece is its section: the name, whether it is delivered, what it
// listens to and what it draws. Nothing here names a piece.
import {
  atom,
  Badge,
  Callout,
  Card,
  env,
  Heading,
  IconButton,
  plugin,
  read,
  Row,
  set,
  Skeleton,
  Stack,
  Text,
  type OrcaNode,
  type PanelContext,
  type Tone
} from 'orca'
import { CORE_MESSAGES, t, wordError, type CoreMessageKey } from '../core/i18n'
import { ROLES, type Role, type RoleState } from '../core/instances'
import type { PanelSection, PieceId } from '../core/piece'
import type { CoreStatus } from '../protocol'
import { SECTIONS } from './sections'

const status = atom<CoreStatus | null>(null)
const loading = atom(false)
/** An error code, the worker's or the host's, worded when drawn. The next good answer clears it. */
const problem = atom<string | null>(null)
/**
 * The pieces whose section could not start. Nothing clears it but opening the panel again: a
 * section that did not start listens to nothing, so what it would draw is not to be trusted.
 */
const broken = atom<readonly PieceId[]>([])

const ROLE_KEYS: Record<Role, CoreMessageKey> = {
  sandbox: 'roleSandbox',
  development: 'roleDevelopment',
  staging: 'roleStaging',
  production: 'roleProduction'
}

const STATE_BADGES: Record<RoleState, { key: CoreMessageKey; tone: Tone }> = {
  ready: { key: 'roleReady', tone: 'success' },
  incomplete: { key: 'roleIncomplete', tone: 'warning' },
  absent: { key: 'roleAbsent', tone: 'neutral' }
}

function text(key: CoreMessageKey, vars?: Record<string, string | number>): string {
  return t(CORE_MESSAGES, env.locale, key, vars)
}

/** The code of a rejection; one without a code is the panel's own `action_failed`. */
function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'action_failed'
}

async function load(): Promise<void> {
  set(loading, true)
  try {
    set(status, await plugin.request('core.status', { locale: env.locale }, { timeoutMs: 60_000 }))
    set(problem, null)
  } catch (error) {
    set(problem, codeOf(error))
  } finally {
    set(loading, false)
  }
}

function B2cState({ value }: { value: CoreStatus['b2c'] }) {
  const state = value.found
    ? value.version
      ? text('b2cFound', { version: value.version })
      : text('b2cFoundNoVersion')
    : text('b2cMissing')
  return (
    <Stack gap="sm">
      <Row justify="between">
        <Text weight="medium">{text('b2c')}</Text>
        <Badge tone={value.found ? 'success' : 'danger'}>{state}</Badge>
      </Row>
      {value.found ? null : (
        <Callout tone="warning" icon="warning" title={text('b2cMissingTitle')}>
          <Stack gap="xs">
            <Text>{wordError(env.locale, value.reason ?? 'b2c_not_found')}</Text>
            <Text>{text('b2cMissingBody')}</Text>
          </Stack>
        </Callout>
      )}
    </Stack>
  )
}

function Instances({ config, value }: { config: CoreStatus['config']; value: CoreStatus['instances'] }) {
  return (
    <Card title={text('instances')} description={text('instancesHint')}>
      <Stack gap="xs">
        {config === 'invalid' ? (
          <Callout tone="danger" icon="error" title={text('configInvalidTitle')}>
            <Text>{text('configInvalidBody')}</Text>
          </Callout>
        ) : null}
        {config === 'missing' ? (
          <Callout tone="neutral" icon="info" title={text('configMissingTitle')}>
            <Text>{text('configMissingBody')}</Text>
          </Callout>
        ) : null}
        {ROLES.map((role) => (
          <Row key={role} justify="between">
            <Text>{text(ROLE_KEYS[role])}</Text>
            <Badge tone={STATE_BADGES[value[role]].tone}>{text(STATE_BADGES[value[role]].key)}</Badge>
          </Row>
        ))}
        {ROLES.some((role) => value[role] === 'incomplete') ? <Text muted>{text('incompleteHint')}</Text> : null}
      </Stack>
    </Card>
  )
}

function Pieces({ sections, failed, locale }: { sections: readonly PanelSection[]; failed: readonly PieceId[]; locale: string }) {
  return (
    <Card title={text('pieces')}>
      <Stack gap="xs">
        {sections.map((section) => {
          // A piece whose section did not start is not available, whatever it says of itself.
          const state = failed.includes(section.id) ? 'failed' : section.delivered ? 'delivered' : 'coming'
          const badge = { failed: ['pieceFailed', 'danger'], delivered: ['pieceDelivered', 'success'], coming: ['pieceComing', 'neutral'] } as const
          return (
            <Row key={section.id} justify="between">
              <Text>{section.title(locale)}</Text>
              <Badge tone={badge[state][1]}>{text(badge[state][0])}</Badge>
            </Row>
          )
        })}
      </Stack>
    </Card>
  )
}

/**
 * The panel over a list of sections: `setup` and the component Orca mounts. The plugin's panel is
 * `createPanel(SECTIONS)`; tests build one over sections of their own.
 */
export function createPanel(sections: readonly PanelSection[]): { setup(ctx: PanelContext): void; Panel(): OrcaNode } {
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
      return (
        <Stack gap="md">
          <Row justify="between" align="center">
            <Heading level={2}>{text('setup')}</Heading>
            <IconButton icon="refresh" label={text('refresh')} disabled={busy} onPress={() => void load()} />
          </Row>
          {failure ? (
            <Callout tone="danger" icon="error" title={text('errorTitle')}>
              <Text>{wordError(locale, failure)}</Text>
            </Callout>
          ) : null}
          {sections
            .filter((section) => failed.includes(section.id))
            .map((section) => (
              <Callout key={section.id} tone="danger" icon="error" title={text('sectionFailedTitle', { piece: section.title(locale) })}>
                <Text>{text('sectionFailedBody')}</Text>
              </Callout>
            ))}
          {current ? (
            <Stack gap="md">
              <B2cState value={current.b2c} />
              <Instances config={current.config} value={current.instances} />
              <Pieces sections={sections} failed={failed} locale={locale} />
            </Stack>
          ) : failure ? null : (
            <Skeleton lines={4} label={text('loading')} />
          )}
          {sections.map((section) => {
            const body = failed.includes(section.id) ? null : section.render(locale)
            return body === null || body === undefined ? null : (
              <Card key={section.id} title={section.title(locale)}>
                {body}
              </Card>
            )
          })}
        </Stack>
      )
    }
  }
}

const panel = createPanel(SECTIONS)

export const setup = panel.setup
export default panel.Panel
