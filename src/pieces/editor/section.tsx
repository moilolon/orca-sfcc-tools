// The editor piece's half of the panel, listed in src/panel/sections.ts. The editor works in its
// own tab (main.ts, Orca's editor frame), not in the panel: the piece is delivered with no view of
// its own and is only listed in the setup view, like ISML.
import { t } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { messages } from './i18n'

export const section: PanelSection = {
  id: 'editor',
  icon: 'edit',
  title: (locale) => t(messages, locale, 'title'),
  delivered: true,
  hasView: false,
  render: () => null
}
