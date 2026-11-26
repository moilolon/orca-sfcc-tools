// The editor piece's check scenarios: each state of its section worth a look, drawn by
// `orca plugin check` and captured with `orca plugin shot . --scenario <name>`. None until phase
// 7. src/panel/checks.ts merges them; every name starts with `editor`.
import type { PieceScenarios } from '../../panel/scenarios'

export const scenarios: PieceScenarios = {}
