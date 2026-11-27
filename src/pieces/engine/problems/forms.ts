// The problems of a form definition (`cartridge/forms/<locale>/*.xml`), as the platform reads it.
// Pure: no Node, no Orca.
//
// The rules:
//
// - Well-formed XML (`xml.ts`), or one `form_malformed` at the first fault, and nothing else.
// - The root is `<form>`, and each element is one its parent holds in the schema (`FORM_SCHEMA`);
//   any other is `form_unknown_element`, and what is inside it is not read. An element with a
//   namespace prefix belongs to another schema and is not read either.
// - An attribute is one its element takes in the schema, or one the platform is known to accept
//   outside it (`ACCEPTED_OUTSIDE_SCHEMA`), else `form_unknown_attribute`. Namespace declarations
//   and prefixed attributes (`xmlns`, `xml:lang`, `xsi:…`) are not read.
// - Two children of one `form`, `group` or `list` with the same `formid`: `form_duplicate_id` on
//   the second, as the platform keeps one element per id in a container.
// - `<include formid="…" name="x">` names the form definition `x` (`forms/<locale>/x.xml`): looked
//   for along the storefronts like a template (`lookup.ts`), `form_include_missing` when no
//   cartridge of any path that counts has it, `form_include_partial` when some lack it.
import type { Lookup } from './lookup'
import { Lines, problem, sortProblems, storefrontList, type Problem, type Spot } from './problem'
import { localName, readXml, type XmlElement } from './xml'

export type FormElement = { attributes: readonly string[]; children: readonly string[] }

// The form definition schema of the namespace `http://www.demandware.com/xml/form/2008-04-19`, as
// `b2c docs schema form` gives it (`form.xsd`, read with b2c 2.11.0): its elements, the attributes
// each takes and the elements each holds, names and structure only. `form`, `group` and `list` are
// its `complexType.Container`, which holds any number of `group`, `list`, `field`, `action` and
// `include` and takes the five attributes of `CONTAINER_ATTRIBUTES`.
const CONTAINER_ATTRIBUTES = ['object-def', 'binding', 'description', 'form-error', 'validation']
const CONTAINER_CHILDREN = ['group', 'list', 'field', 'action', 'include']

/** The elements of the form schema: the attributes each takes and the elements each holds. */
export const FORM_SCHEMA: Readonly<Record<string, FormElement>> = {
  form: { attributes: [...CONTAINER_ATTRIBUTES, 'formid', 'secure'], children: CONTAINER_CHILDREN },
  group: { attributes: [...CONTAINER_ATTRIBUTES, 'formid'], children: CONTAINER_CHILDREN },
  list: { attributes: [...CONTAINER_ATTRIBUTES, 'formid', 'selectmany-fieldid', 'selectone-fieldid'], children: CONTAINER_CHILDREN },
  field: {
    attributes: [
      'formid',
      'attribute-def',
      'binding',
      'type',
      'mandatory',
      'label',
      'description',
      'missing-error',
      'parse-error',
      'range-error',
      'value-error',
      'format',
      'whitespace',
      'masked',
      'min-length',
      'max-length',
      'default-value',
      'regexp',
      'validation',
      'timezoned',
      'min',
      'max',
      'checked-value',
      'unchecked-value'
    ],
    children: ['options']
  },
  options: { attributes: ['value-binding', 'optionid-binding', 'label-binding'], children: ['option'] },
  option: { attributes: ['value', 'optionid', 'label', 'default'], children: [] },
  action: { attributes: ['formid', 'valid-form', 'label', 'description', 'binding'], children: [] },
  include: { attributes: ['formid', 'name', 'binding'], children: [] }
}

/**
 * Attributes outside the schema that the platform accepts, because SFRA's own form definitions
 * carry them: `checked` on a boolean `field`.
 */
export const ACCEPTED_OUTSIDE_SCHEMA: Readonly<Record<string, readonly string[]>> = { field: ['checked'] }

/** The elements whose children each carry a `formid` of their own. */
const CONTAINERS: ReadonlySet<string> = new Set(['form', 'group', 'list'])

export type FormUses = {
  kind: 'form'
  /** What the file alone shows: well-formedness, elements, attributes, duplicate ids. */
  own: Problem[]
  /** The form definitions its `<include>` tags name. */
  includes: (Spot & { name: string })[]
}

/** Whether a path is a form definition of a cartridge. */
export function isFormPath(path: string): boolean {
  return /(^|\/)cartridge\/forms\/[^/]+\/.+\.xml$/i.test(path)
}

function isForeign(name: string): boolean {
  return name.includes(':') || name === 'xmlns'
}

export function formUses(text: string): FormUses {
  const uses: FormUses = { kind: 'form', own: [], includes: [] }
  const lines = new Lines(text)
  const read = readXml(text)
  if (read.fault) {
    uses.own.push(problem('form_malformed', lines.spot(read.fault.start, read.fault.end), { reason: read.fault.reason }))
    return uses
  }
  const root = read.root
  if (root.name.includes(':')) return uses
  if (root.name !== 'form') {
    uses.own.push(problem('form_unknown_element', lines.spot(root.nameStart, root.nameEnd), { element: root.name }))
    return uses
  }
  const stack: XmlElement[] = [root]
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement
    const schema = FORM_SCHEMA[element.name]
    const accepted = ACCEPTED_OUTSIDE_SCHEMA[element.name] ?? []
    for (const attribute of element.attributes) {
      if (isForeign(attribute.name) || schema.attributes.includes(attribute.name) || accepted.includes(attribute.name)) continue
      uses.own.push(problem('form_unknown_attribute', lines.spot(attribute.nameStart, attribute.nameEnd), { attribute: attribute.name, element: element.name }))
    }
    if (element.name === 'include') {
      const name = element.attributes.find((attribute) => attribute.name === 'name')
      const plain = name ? name.value.trim().replace(/\.xml$/i, '') : ''
      if (name && plain && !plain.includes('${')) uses.includes.push({ ...lines.spot(name.valueStart, name.valueEnd), name: plain })
    }
    const ids = new Set<string>()
    for (const child of element.children) {
      if (child.name.includes(':')) continue
      if (!schema.children.includes(child.name)) {
        uses.own.push(problem('form_unknown_element', lines.spot(child.nameStart, child.nameEnd), { element: localName(child.name) }))
        continue
      }
      if (CONTAINERS.has(element.name)) {
        const id = child.attributes.find((attribute) => attribute.name === 'formid')
        if (id && id.value) {
          if (ids.has(id.value)) uses.own.push(problem('form_duplicate_id', lines.spot(id.valueStart, id.valueEnd), { id: id.value }))
          ids.add(id.value)
        }
      }
      stack.push(child)
    }
  }
  sortProblems(uses.own)
  return uses
}

export function checkForm(lookup: Lookup, path: string, uses: FormUses): Problem[] {
  const out = [...uses.own]
  for (const include of uses.includes) {
    const found = lookup.presence(path, (cartridge) => lookup.hasForm(cartridge, include.name))
    if (found.kind === 'missing') out.push(problem('form_include_missing', include, { name: include.name }))
    else if (found.kind === 'partial') out.push(problem('form_include_partial', include, { name: include.name, storefronts: storefrontList(found.storefronts) }))
  }
  return out
}
