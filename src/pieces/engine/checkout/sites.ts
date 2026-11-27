// Where a storefront's cartridge path comes from, in this order of preference: the plugin's
// `cartridgePath` setting (one path, colon-separated, for every storefront); else the site
// archives of the checkout (`sites/<site>/site.xml` of a site import folder, its
// `<custom-cartridges>`), one path per site; else the same files at a git ref the owner names
// (`metadataRef`), read without checking it out. Pure: no Node, no Orca.
import { lineAt, lineStarts } from './files'
import { attributeOf, decodeXml, scanXml } from './xml'

export type PathSource = 'setting' | 'site-archive' | 'git-ref'

/** The id of the one storefront the setting describes. */
export const SETTING_STOREFRONT = 'setting'

export type SiteArchive = {
  siteId: string
  cartridges: string[]
  /** The file, and the range of the `<custom-cartridges>` text in it. */
  path: string
  start: number
  end: number
  line: number
}

/** Whether a path is a site archive's `site.xml`: `…/sites/<site>/site.xml`. */
export function isSiteArchivePath(path: string): boolean {
  return /(^|\/)sites\/[^/]+\/site\.xml$/i.test(path)
}

/** The cartridges of a path written `a:b:c` (white space and empty parts dropped). */
export function splitCartridgePath(value: string): string[] {
  return value
    .split(':')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * A site archive's id and cartridge path: the `site-id` of its `<site>` (else its folder's name)
 * and the text of its `<custom-cartridges>`. Null when the file names no cartridges.
 */
export function parseSiteArchive(text: string, path: string): SiteArchive | null {
  let siteId: string | null = null
  let inCartridges = false
  let range: { start: number; end: number } | null = null
  scanXml(text, {
    open(tag) {
      if (tag.local === 'site' && siteId === null) siteId = attributeOf(tag, 'site-id')?.value || null
      if (tag.local === 'custom-cartridges' && range === null) inCartridges = !tag.selfClosing
    },
    text(start, end) {
      if (inCartridges) range = range ? { start: range.start, end } : { start, end }
    },
    close(name) {
      if (name.endsWith('custom-cartridges')) inCartridges = false
    }
  })
  if (!range) return null
  const { start, end } = range
  const cartridges = splitCartridgePath(decodeXml(text.slice(start, end)))
  if (cartridges.length === 0) return null
  const folder = path.split('/').slice(-2, -1)[0] ?? ''
  return { siteId: siteId || folder, cartridges, path, start, end, line: lineAt(lineStarts(text), start) }
}
