// The sandbox piece's panel section, listed in src/panel/sections.ts. A stub until phase 2:
// it draws nothing.
import { t } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { messages } from './i18n'

export const section: PanelSection = {
  id: 'sandbox',
  icon: 'cloud',
  title: (locale) => t(messages, locale, 'title'),
  render: () => null
}
