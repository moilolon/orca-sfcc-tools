// The editor piece's check scenarios, drawn by `orca plugin check` and captured with
// `orca plugin shot . --scenario <name>`. src/panel/checks.ts merges them; every name starts with
// `editor`. The piece has no view in the panel, so its one state there is the setup view listing
// it as available. The editor itself draws in its own tab: it is captured with
// `orca plugin shot <plugin-key> --editor src/pieces/editor/fixtures/showcase.isml` once the plugin
// is loaded, which is the live check's step.
import type { PieceScenarios } from '../../panel/scenarios'

export const scenarios: PieceScenarios = {
  /** A ready setup, with the editor listed as available. */
  editor: {}
}
