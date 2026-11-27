// Which view of the panel is open, and how a view leads to another. The panel keeps the view last
// picked in the bar here; a piece's view calls `openSetup()` from a notice whose fix is in the
// setup view, so no piece needs to know how the panel keeps its views.
import { atom, set } from 'orca'
import { SETUP_VIEW, VIEW_KEY } from './views'

/** The view last picked in the bar, kept across runs of the plugin. The panel reads it. */
export const lastView = atom<string | null>(VIEW_KEY, null, { persist: 'plugin' })

/** Opens a view: a piece id or the setup view. */
export function openView(view: string): void {
  set(lastView, view)
}

/** Opens the setup view: where a missing environment, dw.json or b2c is explained. */
export function openSetup(): void {
  set(lastView, SETUP_VIEW)
}
