// `orca plugin check` renders the panel once per scenario with the worker on a fresh host, and
// `orca plugin shot . --scenario <name>` captures one. Nothing here reads a real dw.json: no
// workspace is focused, so every environment shows as not configured unless stubbed.
import { defineCheck } from 'orca/testing'
import type { CoreStatus } from '../protocol'

const PIECES: CoreStatus['pieces'] = ['isml', 'sandbox', 'errors', 'debugger', 'engine', 'editor']

export default defineCheck({
  /** The real worker running the b2c installed on this machine. */
  found: {},
  /** The real worker with a b2c path that does not exist. */
  wrongPath: { settings: { b2cPath: 'C:\\does-not-exist\\b2c.cmd' } },
  /** A stubbed answer: b2c found, sandbox and development configured. */
  configured: {
    requests: {
      'core.status': (): CoreStatus => ({
        b2c: { found: true, version: '2.11.0' },
        instances: { sandbox: true, development: true, staging: false, production: false },
        pieces: PIECES
      })
    }
  },
  /** A stubbed answer: b2c missing. */
  missing: {
    requests: {
      'core.status': (): CoreStatus => ({
        b2c: { found: false, version: null, reason: 'b2c_not_found' },
        instances: { sandbox: false, development: false, staging: false, production: false },
        pieces: PIECES
      })
    }
  }
})
