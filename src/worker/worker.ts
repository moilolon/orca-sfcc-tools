// The plugin's worker: builds what src/core offers, answers `core.status`, then starts every piece
// listed in src/worker/pieces.ts with its own context. On deactivation it waits for every piece to
// stop, each within its own bound, then stops its own handlers.
import type { OrcaWorkerApi } from 'orca/worker'
import { createB2c, B2cError, type B2cDeps } from '../core/b2c'
import { translator } from '../core/i18n'
import { PIECE_IDS, type Disposable, type PieceContext, type PieceId, type WorkerPiece } from '../core/piece'
import { createSettings } from '../core/settings'
import { createStore } from '../core/store'
import { createWorkspaces, isLocal } from '../core/workspaces'
import type { CoreStatus } from '../protocol'
import { WORKER_PIECES } from './pieces'

/**
 * What tests replace: how processes start and what the machine looks like; the pieces started
 * (default: src/worker/pieces.ts); and how long deactivation waits for each one to stop.
 */
export type WorkerOverrides = Pick<B2cDeps, 'spawn' | 'platform' | 'env' | 'isFile' | 'isDirectory' | 'killTree' | 'homedir'> & {
  pieces?: readonly WorkerPiece[]
  disposeBoundMs?: number
}

/** How long deactivation waits for one piece to stop before it goes on without it. */
export const DISPOSE_BOUND_MS = 5_000

/** What to stop on deactivation, by who started it: core's own handlers, or a piece. */
type Owned = { owner: PieceId | 'core'; disposable: Disposable }

let owned: Owned[] = []
let disposeBoundMs = DISPOSE_BOUND_MS
let logLine: (message: string) => void = () => {}

/** An error's code when it has a plain one, else `error`: never its message, which may hold anything. */
function codeOf(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'error'
}

export function createActivate(overrides: WorkerOverrides = {}) {
  return async function activate(orca: OrcaWorkerApi): Promise<void> {
    disposeBoundMs = overrides.disposeBoundMs ?? DISPOSE_BOUND_MS
    const coreStore = createStore(orca.storage, 'core')
    const settings = createSettings(orca.settings)
    const workspaces = createWorkspaces(orca.host, coreStore)
    let locale = await coreStore.get<string>('locale', 'en')
    const log = (message: string) => orca.log(message)
    logLine = log
    // The bound was read above; the rest of the overrides describe the machine b2c runs on.
    const { pieces = WORKER_PIECES, disposeBoundMs: _bound, ...machine } = overrides
    // A call may name only the folder of a local workspace Orca lists (or its main checkout).
    const knownRoots = async () => (await workspaces.list()).filter(isLocal).map((workspace) => workspace.path)
    const b2c = createB2c({ ...machine, settings, configRoot: () => workspaces.configRoot(), knownRoots, log: (message) => log(`[core] ${message}`) })
    const t = translator(() => locale)

    const handlers: Disposable[] = [
      orca.panels.handle('core.status', async (input) => {
        if (typeof input?.locale === 'string' && input.locale && input.locale !== locale) {
          locale = input.locale
          await coreStore.set('locale', locale)
        }
        return status()
      }),
      settings.onDidChange((key) => orca.panels.post('core.changed', { key }))
    ]
    for (const disposable of handlers) owned.push({ owner: 'core', disposable })

    /** b2c counts as found once `--version` printed a version; never throws. */
    async function probe(): Promise<CoreStatus['b2c']> {
      try {
        const version = await b2c.version()
        return version ? { found: true, version } : { found: false, version: null, reason: 'no_version' }
      } catch (error) {
        return { found: false, version: null, reason: error instanceof B2cError ? error.code : 'b2c_failed' }
      }
    }

    async function status(): Promise<CoreStatus> {
      const found = await probe()
      const { config, instances } = await b2c.instances()
      return { b2c: found, config, instances, pieces: [...PIECE_IDS] }
    }

    for (const piece of pieces) {
      const ctx: PieceContext = {
        orca,
        b2c,
        settings,
        store: createStore(orca.storage, piece.id),
        workspaces,
        t,
        log: (message) => log(`[${piece.id}] ${message}`)
      }
      try {
        const disposable = await piece.activate(ctx)
        if (disposable) owned.push({ owner: piece.id, disposable })
      } catch (error) {
        log(`[${piece.id}] failed to start: ${codeOf(error)}`)
      }
    }
  }
}

export default createActivate()

/**
 * Stops one thing within `ms`. A dispose that throws, rejects or never settles is logged by its
 * owner and its error code only, and never keeps the caller waiting past the bound.
 */
async function stopWithin({ owner, disposable }: Owned, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => disposable.dispose())
        .then(() => 'stopped' as const),
      new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), ms)
      })
    ])
    if (outcome === 'late') logLine(`[${owner}] did not stop within ${ms} ms`)
  } catch (error) {
    logLine(`[${owner}] failed to stop: ${codeOf(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Orca awaits this before the worker stops. Every piece stops at once, side by side, each within
 * its own bound, newest first; then core's own handlers, so a piece can still be answered while it
 * stops. A piece that hangs or fails keeps none of the others from stopping.
 */
export async function deactivate(): Promise<void> {
  const current = owned
  owned = []
  const pieces = current.filter((each) => each.owner !== 'core').reverse()
  await Promise.all(pieces.map((each) => stopWithin(each, disposeBoundMs)))
  for (const each of current.filter((item) => item.owner === 'core').reverse()) await stopWithin(each, disposeBoundMs)
}
