// The isml piece's half of the panel, listed in src/panel/sections.ts. A stub until phase 1:
// it draws nothing, and `delivered` is false, so the panel lists the piece as coming.
import { t } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { messages } from './i18n'

export const section: PanelSection = {
  id: 'isml',
  icon: 'code',
  title: (locale) => t(messages, locale, 'title'),
  delivered: false,
  render: () => null
}
