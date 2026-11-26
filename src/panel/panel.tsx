// The SFCC sidebar panel: the setup (b2c, the environments dw.json configures, the pieces), then
// one section per piece (src/panel/sections.ts). Every text comes from src/core/i18n.ts or the
// piece's own table, in Orca's language. It never shows a host, a path or a credential.
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
  type PanelContext
} from 'orca'
import { CORE_MESSAGES, t, wordError, type CoreMessageKey } from '../core/i18n'
import { ROLES, type Role } from '../core/instances'
import type { PieceId } from '../core/piece'
import type { CoreStatus } from '../protocol'
import { SECTIONS } from './sections'

const status = atom<CoreStatus | null>(null)
const loading = atom(false)
/** A worker error code, worded when drawn. */
const problem = atom<string | null>(null)

const ROLE_KEYS: Record<Role, CoreMessageKey> = {
  sandbox: 'roleSandbox',
  development: 'roleDevelopment',
  staging: 'roleStaging',
  production: 'roleProduction'
}

const PIECE_KEYS: Record<PieceId, CoreMessageKey> = {
  isml: 'pieceIsml',
  sandbox: 'pieceSandbox',
  errors: 'pieceErrors',
  debugger: 'pieceDebugger',
  engine: 'pieceEngine',
  editor: 'pieceEditor'
}

function text(key: CoreMessageKey, vars?: Record<string, string | number>): string {
  return t(CORE_MESSAGES, env.locale, key, vars)
}

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

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('core.changed', () => void load()))
  void load()
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

function Instances({ value }: { value: CoreStatus['instances'] }) {
  return (
    <Card title={text('instances')} description={text('instancesHint')}>
      <Stack gap="xs">
        {ROLES.map((role) => (
          <Row key={role} justify="between">
            <Text>{text(ROLE_KEYS[role])}</Text>
            <Badge tone={value[role] ? 'success' : 'neutral'}>{value[role] ? text('configured') : text('notConfigured')}</Badge>
          </Row>
        ))}
      </Stack>
    </Card>
  )
}

function Pieces({ value }: { value: PieceId[] }) {
  return (
    <Card title={text('pieces')}>
      <Stack gap="xs">
        {value.map((id) => (
          <Row key={id} justify="between">
            <Text>{text(PIECE_KEYS[id])}</Text>
            <Badge>{text('pieceComing')}</Badge>
          </Row>
        ))}
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const current = read(status)
  const busy = read(loading)
  const failure = read(problem)
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
      {current ? (
        <Stack gap="md">
          <B2cState value={current.b2c} />
          <Instances value={current.instances} />
          <Pieces value={current.pieces} />
        </Stack>
      ) : failure ? null : (
        <Skeleton lines={4} label={text('loading')} />
      )}
      {SECTIONS.map((section) => {
        const body = section.render(locale)
        return body === null || body === undefined ? null : (
          <Card key={section.id} title={section.title(locale)}>
            {body}
          </Card>
        )
      })}
    </Stack>
  )
}
