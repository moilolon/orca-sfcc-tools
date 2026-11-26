// The engine piece's check scenarios: each state of its section worth a look, drawn by
// `orca plugin check` and captured with `orca plugin shot . --scenario <name>`. None until phase
// 6. src/panel/checks.ts merges them; every name starts with `engine`.
import type { PieceScenarios } from '../../panel/scenarios'

export const scenarios: PieceScenarios = {}
