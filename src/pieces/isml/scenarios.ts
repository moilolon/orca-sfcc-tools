// The isml piece's check scenarios, drawn by `orca plugin check` and captured with
// `orca plugin shot . --scenario <name>`. src/panel/checks.ts merges them; every name starts with
// `isml`. The piece draws no body, so its one state is the panel listing it as available. What it
// highlights is seen in Orca's editor, on src/pieces/isml/fixtures/showcase.isml.
import type { PieceScenarios } from '../../panel/scenarios'

export const scenarios: PieceScenarios = {
  /** A ready setup, with ISML listed as available. */
  isml: {}
}
