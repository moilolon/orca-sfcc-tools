// Every check scenario of the panel: core's own, below, and each piece's, which it keeps in
// src/pieces/<piece>/scenarios.ts. src/panel/panel.check.ts hands them to Orca; they live here
// because a test cannot import a `*.check.ts` file. Nothing reads a real dw.json: no workspace is
// focused, so the real worker finds no file.
import { scenarios as debuggerScenarios } from '../pieces/debugger/scenarios'
import { scenarios as editor } from '../pieces/editor/scenarios'
import { scenarios as engine } from '../pieces/engine/scenarios'
import { scenarios as errors } from '../pieces/errors/scenarios'
import { scenarios as isml } from '../pieces/isml/scenarios'
import { scenarios as sandbox } from '../pieces/sandbox/scenarios'
import type { CoreStatus } from '../protocol'
import { mergeScenarios, READY_STATUS, type PieceScenarios } from './scenarios'

const NO_INSTANCES: CoreStatus['instances'] = { sandbox: 'absent', development: 'absent', staging: 'absent', production: 'absent' }

const CORE_SCENARIOS: PieceScenarios = {
  /** The real worker running the b2c installed on this machine. */
  found: {},
  /** The real worker with a b2c path that does not exist. */
  wrongPath: { settings: { b2cPath: 'C:\\does-not-exist\\b2c.cmd' } },
  /** A stubbed answer: b2c found; two environments ready, one incomplete, one absent. */
  configured: {
    requests: {
      'core.status': (): CoreStatus => ({
        ...READY_STATUS,
        instances: { sandbox: 'ready', development: 'ready', staging: 'incomplete', production: 'absent' }
      })
    }
  },
  /** A stubbed answer: b2c missing and no dw.json. */
  missing: {
    requests: {
      'core.status': (): CoreStatus => ({ ...READY_STATUS, b2c: { found: false, version: null, reason: 'b2c_not_found' }, config: 'missing', instances: NO_INSTANCES })
    }
  },
  /** A stubbed answer: a dw.json that is not JSON. */
  invalidConfig: {
    requests: { 'core.status': (): CoreStatus => ({ ...READY_STATUS, config: 'invalid', instances: NO_INSTANCES }) }
  }
}

export const CHECKS = mergeScenarios(CORE_SCENARIOS, [
  { id: 'isml', scenarios: isml },
  { id: 'sandbox', scenarios: sandbox },
  { id: 'errors', scenarios: errors },
  { id: 'debugger', scenarios: debuggerScenarios },
  { id: 'engine', scenarios: engine },
  { id: 'editor', scenarios: editor }
])
