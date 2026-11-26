// The plugin's worker: builds what src/core offers, answers `core.status`, then starts every piece
// listed in src/worker/pieces.ts with its own context.
import type { OrcaWorkerApi } from 'orca/worker'
import { createB2c, B2cError, type B2cDeps } from '../core/b2c'
import { translator } from '../core/i18n'
import { PIECE_IDS, type Disposable, type PieceContext } from '../core/piece'
import { createSettings } from '../core/settings'
import { createStore } from '../core/store'
import { createWorkspaces } from '../core/workspaces'
import type { CoreStatus } from '../protocol'
import { WORKER_PIECES } from './pieces'

/** What tests replace: how processes start and what the machine looks like. */
export type WorkerOverrides = Pick<B2cDeps, 'spawn' | 'platform' | 'env' | 'isFile' | 'isDirectory' | 'killTree' | 'homedir'>

let disposables: Disposable[] = []

export function createActivate(overrides: WorkerOverrides = {}) {
  return async function activate(orca: OrcaWorkerApi): Promise<void> {
    const coreStore = createStore(orca.storage, 'core')
    const settings = createSettings(orca.settings)
    const workspaces = createWorkspaces(orca.host, coreStore)
    let locale = await coreStore.get<string>('locale', 'en')
    const log = (message: string) => orca.log(message)
    const b2c = createB2c({ ...overrides, settings, configRoot: () => workspaces.configRoot(), log: (message) => log(`[core] ${message}`) })
    const t = translator(() => locale)

    disposables.push(
      orca.panels.handle('core.status', async (input) => {
        if (typeof input?.locale === 'string' && input.locale && input.locale !== locale) {
          locale = input.locale
          await coreStore.set('locale', locale)
        }
        return status()
      }),
      settings.onDidChange((key) => orca.panels.post('core.changed', { key }))
    )

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

    for (const piece of WORKER_PIECES) {
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
        if (disposable) disposables.push(disposable)
      } catch (error) {
        log(`[${piece.id}] failed to start: ${error instanceof Error && 'code' in error ? String(error.code) : 'error'}`)
      }
    }
  }
}

export default createActivate()

export function deactivate(): void {
  const current = disposables
  disposables = []
  for (const disposable of current.reverse()) {
    try {
      disposable.dispose()
    } catch {
      // A piece that fails to stop must not keep the others running.
    }
  }
}
