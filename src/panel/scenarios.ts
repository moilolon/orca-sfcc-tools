// The panel's check scenarios are core's own plus every piece's: each piece keeps its own in
// src/pieces/<piece>/scenarios.ts and src/panel/checks.ts merges them with this, so a piece
// adds a capture without touching a shared file. Only the checks and tests load this module;
// Orca never does.
import type { CheckScenario } from 'orca/testing'
import type { PanelSection, PieceId } from '../core/piece'
import type { CoreStatus } from '../protocol'
import { SETUP_VIEW, VIEW_KEY } from './views'

export type PieceScenarios = Readonly<Record<string, CheckScenario>>

/**
 * The setup a piece's scenario is drawn over unless it stubs `core.status` itself: b2c found and
 * every environment ready. Without it the real worker would run whatever b2c this machine has.
 */
export const READY_STATUS: CoreStatus = {
  b2c: { found: true, version: '2.11.0' },
  config: 'ok',
  instances: { sandbox: 'ready', development: 'ready', staging: 'ready', production: 'ready' },
  pieces: ['isml', 'sandbox', 'errors', 'debugger', 'engine', 'editor'],
  workspace: { name: 'garden-shop', reason: 'focused' }
}

/**
 * A piece as the merge needs it: its scenarios, and whether they open its own view, which is
 * `opensOwnView` of its section.
 */
export type ScenarioSource = { id: PieceId; scenarios: PieceScenarios; opensOwnView: boolean }

/**
 * Whether a piece's scenarios open its own view: only once its section is delivered and has a
 * view, as the panel puts it in the bar only then. Before that they open the setup view, which is
 * what the panel draws, so a phase can write its scenarios before it flips `delivered`.
 */
export function opensOwnView(sections: readonly PanelSection[], id: PieceId): boolean {
  return sections.some((section) => section.id === id && section.delivered && section.hasView)
}

/** The view a scenario opens: the one it persists itself, else `view`. */
function openingOn(scenario: CheckScenario, view: string): CheckScenario {
  const plugin = scenario.persisted?.plugin ?? {}
  if (VIEW_KEY in plugin) return scenario
  return { ...scenario, persisted: { ...scenario.persisted, plugin: { ...plugin, [VIEW_KEY]: view } } }
}

/** The view a merged scenario names: `persisted.plugin.view`. Every merged scenario has one. */
export function viewOf(scenario: CheckScenario): string | undefined {
  const view = scenario.persisted?.plugin?.[VIEW_KEY]
  return typeof view === 'string' ? view : undefined
}

/**
 * Core's scenarios, then each piece's in the order given. A piece's scenario must be named after
 * the piece (`sandbox`, `sandboxDeploying`): two pieces can then never claim one name, whatever
 * order they land in. A name used twice, or one that breaks the rule, throws naming the piece.
 *
 * Every scenario names the view it draws, in `persisted.plugin.view`: core's open the setup view,
 * and a piece's open its own view (the setup view until its section is delivered with a view),
 * unless the scenario persists another. A test mounts each one and fails when it draws a
 * different view.
 */
export function mergeScenarios(core: PieceScenarios, pieces: readonly ScenarioSource[]): Record<string, CheckScenario> {
  const merged: Record<string, CheckScenario> = {}
  for (const [name, scenario] of Object.entries(core)) merged[name] = openingOn(scenario, SETUP_VIEW)
  for (const { id, scenarios, opensOwnView: toOwnView } of pieces) {
    for (const [name, scenario] of Object.entries(scenarios)) {
      const named = name === id || (name.startsWith(id) && /^[A-Z0-9]/.test(name.slice(id.length)))
      if (!named) throw new Error(`${id}: the scenario "${name}" must be named ${id} or ${id}<Name>`)
      if (name in merged) throw new Error(`${id}: the scenario "${name}" already exists`)
      merged[name] = openingOn({ ...scenario, requests: { 'core.status': () => READY_STATUS, ...scenario.requests } }, toOwnView ? id : SETUP_VIEW)
    }
  }
  return merged
}
