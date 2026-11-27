// The editor piece's check scenarios, drawn by `orca plugin check` and captured with
// `orca plugin shot . --scenario <name>`. src/panel/checks.ts merges them; every name starts with
// `editor`. The piece has no view in the panel, so its one state there is the setup view listing
// it as available. The editor itself draws in its own tab, which a scenario cannot draw: it is
// captured with `orca plugin shot <plugin-key> --editor <file>` once the plugin is loaded, which is
// the live check's step. The language features (7.2) need keys and a file of the indexed
// workspace: `--in-place --act` on such a file, with `{"key":" ","modifiers":["control"]}` for the
// completion list, `{"key":"i","modifiers":["control"]}` for a hover, `{"key":"F12"}` for a
// definition's places; the squiggles draw on their own once the file is named.
import type { PieceScenarios } from '../../panel/scenarios'

export const scenarios: PieceScenarios = {
  /** A ready setup, with the editor listed as available. */
  editor: {}
}
