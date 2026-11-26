// The isml piece's half of the panel, listed in src/panel/sections.ts. The piece is the grammar
// of isml.tmLanguage.json, which Orca's editor loads from the manifest: it runs nothing and has
// nothing to show beyond being listed as available.
import { t } from '../../core/i18n'
import type { PanelSection } from '../../core/piece'
import { messages } from './i18n'

export const section: PanelSection = {
  id: 'isml',
  icon: 'code',
  title: (locale) => t(messages, locale, 'title'),
  delivered: true,
  render: () => null
}
