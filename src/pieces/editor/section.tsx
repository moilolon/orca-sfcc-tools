// The editor piece's half of the panel, listed in src/panel/sections.ts. A stub until phase 7:
// it draws nothing, and `delivered` is false, so the panel lists the piece as coming.
import { t } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { messages } from './i18n'

export const section: PanelSection = {
  id: 'editor',
  icon: 'edit',
  title: (locale) => t(messages, locale, 'title'),
  delivered: false,
  hasView: true,
  render: () => null
}
