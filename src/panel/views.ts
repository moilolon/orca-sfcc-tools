// The names the panel keeps its views under, shared by src/panel/panel.tsx and the check
// scenarios (src/panel/scenarios.ts), which open a scenario on a view by persisting it. No
// imports, so both load it.

/** The view of the setup; every other view is a piece id. */
export const SETUP_VIEW = 'setup'

/** The persisted atom (`persist: 'plugin'`) holding the view last picked in the bar. */
export const VIEW_KEY = 'view'

/** The persisted atom holding the view whose `render` threw last, so the next open avoids it. */
export const FAILED_VIEW_KEY = 'viewFailed'

/** The key of the box that holds the open view: `view-setup`, `view-sandbox`. Tests find it. */
export function viewBoxKey(view: string): string {
  return `view-${view}`
}
