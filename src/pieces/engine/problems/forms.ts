// The problems of a form definition (`cartridge/forms/<locale>/*.xml`), as the platform reads it
// (the `http://www.demandware.com/xml/form/2008-04-19` schema). Pure: no Node, no Orca.
//
// The rules:
//
// - Well-formed XML (`xml.ts`), or one `form_malformed` at the first fault, and nothing else.
// - The root is `<form>`; an element of the schema is one of `FORM_ELEMENTS`; any other is
//   `form_unknown_element`, and what is inside it is not read. An element with a namespace prefix
//   belongs to another schema and is not read either.
// - An attribute is one its element takes (`FORM_ELEMENTS`), else `form_unknown_attribute`.
//   Namespace declarations and prefixed attributes (`xmlns`, `xsi:…`) are not read.
// - Two children of one `form`, `group` or `list` with the same `formid`: `form_duplicate_id` on
//   the second, as the platform keeps one field per id in a group.
// - `<include formid="…" name="x">` names the form definition `x` (`forms/<locale>/x.xml`): looked
//   for along the storefronts like a template (`lookup.ts`), `form_include_missing` when no
//   cartridge of any path that counts has it, `form_include_partial` when some lack it.
import type { Lookup } from './lookup'
import { Lines, problem, sortProblems, storefrontList, type Problem, type Spot } from './problem'
import { localName, readXml, type XmlElement } from './xml'

/** The elements of the form schema and the attributes each takes. */
export const FORM_ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  form: ['secure', 'validation', 'formid'],
  field: [
    'formid',
    'label',
    'description',
    'type',
    'binding',
    'mandatory',
    'min-length',
    'max-length',
    'min',
    'max',
    'regexp',
    'format',
    'default-value',
    'checked-value',
    'unchecked-value',
    'range-error',
    'parse-error',
    'value-error',
    'missing-error',
    'validation',
    'timezoned',
    'whitespace',
    'secure'
  ],
  group: ['formid', 'binding', 'validation', 'form-error', 'secure'],
  list: ['formid', 'binding', 'selectmany-fieldid', 'validation', 'form-error'],
  include: ['formid', 'name', 'binding'],
  action: ['formid', 'valid-form', 'label', 'description'],
  options: ['optionid-binding', 'value-binding', 'label-binding'],
  option: ['optionid', 'value', 'label', 'default']
}

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
    const allowed = FORM_ELEMENTS[element.name]
    for (const attribute of element.attributes) {
      if (isForeign(attribute.name) || allowed.includes(attribute.name)) continue
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
      if (!(child.name in FORM_ELEMENTS) || child.name === 'form') {
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
