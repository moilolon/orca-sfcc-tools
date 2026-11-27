// The metadata of a site import folder: custom attributes per object type, from
// `meta/*.xml` (`system-objecttype-extensions.xml`, `custom-objecttype-definitions.xml` and the
// like). A system type's custom attributes are the `attribute-definition`s inside its
// `type-extension`'s `custom-attribute-definitions`; a custom object type's are those inside its
// `custom-type`'s `attribute-definitions`. `system-attribute-definitions` change system attributes
// and are not custom ones. Site preferences are the custom attributes of `SitePreferences`.
// Pure: no Node, no Orca.
import { lineAt, lineStarts } from './files'
import { attributeOf, decodeXml, scanXml } from './xml'

export const SITE_PREFERENCES = 'SitePreferences'

export type AttributeDefinition = {
  id: string
  /** The value type (`string`, `boolean`, `enum-of-string`, …); null when the file gives none. */
  type: string | null
  /** The file it is defined in, and the range of its id there. */
  path: string
  start: number
  end: number
  /** 1-based. */
  line: number
}

export type ObjectTypeKind = 'system' | 'custom'

export type ObjectTypeDefinition = {
  typeId: string
  kind: ObjectTypeKind
  attributes: AttributeDefinition[]
}

/** Whether a path is a metadata file of a site import folder: an XML file in a `meta` folder. */
export function isMetadataPath(path: string): boolean {
  return /(^|\/)meta\/[^/]+\.xml$/i.test(path)
}

/** The object types a metadata file defines or extends, with their custom attributes. */
export function parseMetadata(text: string, path: string): ObjectTypeDefinition[] {
  const types: ObjectTypeDefinition[] = []
  const starts = lineStarts(text)
  const stack: string[] = []
  let current: ObjectTypeDefinition | null = null
  let inCustom = false
  let attribute: AttributeDefinition | null = null
  let typeText: { start: number; end: number } | null = null
  let readingType = false
  scanXml(text, {
    open(tag) {
      if (!tag.selfClosing) stack.push(tag.local)
      if (tag.local === 'type-extension' || tag.local === 'custom-type') {
        const id = attributeOf(tag, 'type-id')
        current = id && id.value ? { typeId: id.value, kind: tag.local === 'type-extension' ? 'system' : 'custom', attributes: [] } : null
        if (current) types.push(current)
        inCustom = false
        return
      }
      if (!current) return
      if ((current.kind === 'system' && tag.local === 'custom-attribute-definitions') || (current.kind === 'custom' && tag.local === 'attribute-definitions')) {
        inCustom = !tag.selfClosing
        return
      }
      if (inCustom && tag.local === 'attribute-definition') {
        const id = attributeOf(tag, 'attribute-id')
        if (!id || !id.value) return
        attribute = { id: id.value, type: null, path, start: id.valueStart, end: id.valueEnd, line: lineAt(starts, id.valueStart) }
        current.attributes.push(attribute)
        if (tag.selfClosing) attribute = null
        return
      }
      // The attribute's own `<type>`, not one of a nested element.
      if (attribute && tag.local === 'type' && stack[stack.length - 2] === 'attribute-definition') {
        readingType = !tag.selfClosing
        typeText = null
      }
    },
    text(start, end) {
      if (readingType) typeText = typeText ? { start: typeText.start, end } : { start, end }
    },
    close(name) {
      const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
      // Pop to the matching open tag; a stray close tag pops nothing.
      const at = stack.lastIndexOf(local)
      if (at !== -1) stack.length = at
      if (local === 'type' && readingType) {
        readingType = false
        if (attribute && typeText) attribute.type = decodeXml(text.slice(typeText.start, typeText.end)).trim() || null
      } else if (local === 'attribute-definition') {
        attribute = null
      } else if (local === 'custom-attribute-definitions' || local === 'attribute-definitions') {
        inCustom = false
      } else if (local === 'type-extension' || local === 'custom-type') {
        current = null
        inCustom = false
      }
    }
  })
  return types
}
