// The panel's check scenarios are core's own plus every piece's: each piece keeps its own in
// src/pieces/<piece>/scenarios.ts and src/panel/checks.ts merges them with this, so a piece
// adds a capture without touching a shared file. Only the checks and tests load this module;
// Orca never does.
import type { CheckScenario } from 'orca/testing'
import type { PieceId } from '../core/piece'
import type { CoreStatus } from '../protocol'

export type PieceScenarios = Readonly<Record<string, CheckScenario>>

/**
 * The setup a piece's scenario is drawn over unless it stubs `core.status` itself: b2c found and
 * every environment ready. Without it the real worker would run whatever b2c this machine has.
 */
export const READY_STATUS: CoreStatus = {
  b2c: { found: true, version: '2.11.0' },
  config: 'ok',
  instances: { sandbox: 'ready', development: 'ready', staging: 'ready', production: 'ready' },
  pieces: ['isml', 'sandbox', 'errors', 'debugger', 'engine', 'editor']
}

/**
 * Core's scenarios, then each piece's in the order given. A piece's scenario must be named after
 * the piece (`sandbox`, `sandboxDeploying`): two pieces can then never claim one name, whatever
 * order they land in. A name used twice, or one that breaks the rule, throws naming the piece.
 */
export function mergeScenarios(core: PieceScenarios, pieces: readonly { id: PieceId; scenarios: PieceScenarios }[]): Record<string, CheckScenario> {
  const merged: Record<string, CheckScenario> = { ...core }
  for (const { id, scenarios } of pieces) {
    for (const [name, scenario] of Object.entries(scenarios)) {
      const own = name === id || (name.startsWith(id) && /^[A-Z0-9]/.test(name.slice(id.length)))
      if (!own) throw new Error(`${id}: the scenario "${name}" must be named ${id} or ${id}<Name>`)
      if (name in merged) throw new Error(`${id}: the scenario "${name}" already exists`)
      merged[name] = { ...scenario, requests: { 'core.status': () => READY_STATUS, ...scenario.requests } }
    }
  }
  return merged
}
