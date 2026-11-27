// The errors piece's check scenarios: each state of its view worth a look, drawn by
// `orca plugin check` and captured with `orca plugin shot . --scenario <name>`. src/panel/checks.ts
// merges them; every name starts with `errors`. Each stubs the piece's requests with invented
// rows, so no b2c runs and no log is read.
import type { PieceScenarios } from '../../panel/scenarios'
import type { Role } from '../../core/instances'
import type { ErrorRow, RoleErrors } from './protocol'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Invented signatures: a script error in the cart, a custom logger's error, a job's. */
function rows(now: number): ErrorRow[] {
  return [
    {
      signature: 'a1b2c3d4e5f6a7b8c9d0',
      firstSeen: now - 3 * HOUR,
      lastSeen: now - 4 * MINUTE,
      count: 27,
      markedAt: null,
      message: "<code> Error executing script 'app_example/cartridge/controllers/Cart.js': TypeError: Cannot read property <q> of undefined (app_example/cartridge/scripts/helpers/cartHelper.js) at /on/demandware.store/<site>/<locale>/Cart-AddProduct",
      logger: 'system.core',
      pipeline: 'Cart-AddProduct',
      level: 'ERROR',
      frames: [
        { file: 'app_example/cartridge/scripts/helpers/cartHelper.js', function: 'calculateLineTotal', line: 118, openable: true, path: 'cartridges/app_example/cartridge/scripts/helpers/cartHelper.js' },
        { file: 'app_example/cartridge/scripts/helpers/cartHelper.js', function: 'addProductToCart', line: 64, openable: true, path: 'cartridges/app_example/cartridge/scripts/helpers/cartHelper.js' },
        { file: 'app_example/cartridge/controllers/Cart.js', function: 'addProduct', line: 42, openable: true, path: 'cartridges/app_example/cartridge/controllers/Cart.js' },
        { file: 'modules/server/route.js', function: 'next', line: 83, openable: false, path: null }
      ]
    },
    {
      signature: 'b2c3d4e5f6a7b8c9d0e1',
      firstSeen: now - 50 * MINUTE,
      lastSeen: now - 12 * MINUTE,
      count: 3,
      markedAt: null,
      message: 'Payment authorization failed for order #, customer <email>, amount #.# EUR, reference <hex>',
      logger: 'custom.PaymentService',
      pipeline: 'CheckoutServices-PlaceOrder',
      level: 'ERROR',
      frames: []
    },
    {
      signature: 'c3d4e5f6a7b8c9d0e1f2',
      firstSeen: now - 30 * HOUR,
      lastSeen: now - 2 * HOUR,
      count: 140,
      markedAt: now - 26 * HOUR,
      message: 'Job step failed: java.lang.IllegalStateException: Export file /remote/IMPEX/src/export_#_#.xml is locked',
      logger: 'system.job',
      pipeline: null,
      level: 'FATAL',
      frames: [
        { file: 'ExportStep.java', function: 'example.jobs.ExportStep.run', line: 88, openable: false, path: null },
        { file: 'JobExecutor.java', function: 'example.jobs.JobExecutor.execute', line: 120, openable: false, path: null }
      ]
    }
  ]
}

function answer(role: Role, overrides: Partial<RoleErrors> = {}): RoleErrors {
  const now = Date.now()
  return { role, state: 'ready', reading: false, lastRead: now - 2 * MINUTE, error: null, missedSince: null, intervalMinutes: role === 'sandbox' ? 5 : 0, rows: rows(now), ...overrides }
}

/** Answers every request of the piece with one state, whatever the environment asked. */
function requests(state: (role: Role) => RoleErrors) {
  return {
    'errors.list': ({ role }: { role: Role }) => state(role),
    'errors.refresh': ({ role }: { role: Role }) => state(role),
    'errors.mark': ({ role }: { role: Role }) => state(role),
    'errors.forget': ({ role }: { role: Role }) => state(role),
    'errors.open': () => ({ opened: true })
  }
}

/** The signatures of the three invented errors: a script error, a payment one, a job's. */
const SCRIPT_ERROR = 'a1b2c3d4e5f6a7b8c9d0'
const NO_STACK = 'b2c3d4e5f6a7b8c9d0e1'
const JOB_ERROR = 'c3d4e5f6a7b8c9d0e1f2'

export const scenarios: PieceScenarios = {
  /** New errors on the sandbox, and one seen, read every five minutes. */
  errors: { requests: requests((role) => answer(role)) },
  /** Only seen errors: nothing new. */
  errorsSeen: {
    requests: requests((role) => {
      const now = Date.now()
      return answer(role, { rows: rows(now).map((row) => ({ ...row, markedAt: row.markedAt ?? now - HOUR })) })
    })
  },
  /** A log read with no error in it yet; the timer off. */
  errorsNone: { requests: requests((role) => answer(role, { rows: [], intervalMinutes: 0 })) },
  /** The environment picked is not configured in dw.json. */
  errorsNotReady: {
    persisted: { plugin: { errorsRole: 'production' } },
    requests: requests((role) => answer(role, { state: 'absent', rows: [], lastRead: null }))
  },
  /** The last read failed: b2c ended with an error. The rows read before stay. */
  errorsReadFailed: { requests: requests((role) => answer(role, { error: 'b2c_failed', lastRead: Date.now() - 3 * HOUR })) },
  /** The last read may have missed entries: b2c returned as many as it keeps. */
  errorsMissed: { requests: requests((role) => answer(role, { missedSince: Date.now() - 6 * HOUR })) },
  /** A read is running. */
  errorsReading: { requests: requests((role) => answer(role, { reading: true })) },
  /**
   * The detail of a new script error: its state, count and times, its actions, the fields of its
   * first line, its message with placeholders as code, and its frames, three in the workspace and
   * one that is not.
   */
  errorsDetail: { persisted: { plugin: { errorsDetail: SCRIPT_ERROR } }, requests: requests((role) => answer(role)) },
  /** The detail of a new error whose entry has no stack trace. */
  errorsDetailNoStack: { persisted: { plugin: { errorsDetail: NO_STACK } }, requests: requests((role) => answer(role)) },
  /** The detail of a seen error of the platform: its frames muted, none to open. */
  errorsDetailSeen: { persisted: { plugin: { errorsDetail: JOB_ERROR } }, requests: requests((role) => answer(role)) }
}
