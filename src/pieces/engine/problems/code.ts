// The problems of a script or a template: unknown custom attributes and site preferences, and
// templates, resource keys and bundles that do not exist. Two steps, so a file is parsed only when
// it changed: `codeUses` reads what a file names (needs its text and the types of 6.4), and
// `checkCode` checks those names against the checkout as it is now (cheap, run after every change
// of the index). Pure: no Node, no Orca.
//
// The rules, each one silent when in doubt:
//
// - Unknown custom attribute: `x.custom.y` (or `x.custom['y']`) where the type of `x` is known by
//   the types of 6.4 (never guessed from a name), its object type is one the metadata defines or
//   extends, and that type has no custom attribute `y`. No metadata of that type, no warning.
// - Unknown site preference: the same for `SitePreferences`, written
//   `Site.current.preferences.custom.y` or `<a Site>.getCustomPreferenceValue('y')`, the name a
//   literal and the object known to be a `dw.system.Site`.
// - Template: the literal name of `res.render`, `ISML.renderTemplate`, `new Template`, and the
//   `template` attribute of `<isinclude>`, `<isdecorate>` and `<ismodule>` when it holds no `${…}`.
//   Found in any locale folder of a cartridge of the path. Missing everywhere or on some storefronts
//   only, as `lookup.ts` says (`presence`).
// - Resource key: `Resource.msg` and `Resource.msgf`, the key a literal and the bundle a literal
//   (`locale` when `msg` has no second argument; any other second argument is not read), with
//   `Resource` the platform's (a global, or bound to `require('dw/web/Resource')`). Found when a
//   cartridge of the path has the key in that bundle, in any locale. A bundle no cartridge has at
//   all is `bundle_missing` instead.
import type * as AST from '../js/ast'
import { walk, type Node } from '../js/ast'
import { attribute, walkTemplate } from '../isml/parser'
import { templateName } from '../checkout/checkout'
import type { Analysis } from '../query/analysis'
import type { QueryContext } from '../query/modules'
import { memberName, Types } from '../query/types'
import { SITE_PREFERENCES } from '../checkout/metadata'
import type { Lookup } from './lookup'
import { Lines, problem, storefrontList, type Problem, type Spot } from './problem'

export type AttributeUse = Spot & { typeId: string; name: string; preference: boolean }
export type TemplateNameUse = Spot & { name: string }
export type ResourceKeyUse = Spot & { key: string; bundle: string }

export type CodeUses = {
  kind: 'code'
  attributes: AttributeUse[]
  templates: TemplateNameUse[]
  resources: ResourceKeyUse[]
}

const TEMPLATE_TAGS: ReadonlySet<string> = new Set(['isinclude', 'isdecorate', 'ismodule'])
const SITE = 'dw.system.Site'
const RESOURCE = 'dw.web.Resource'

function stringLiteral(node: Node | undefined | null): AST.Literal | null {
  return node && node.type === 'Literal' && node.kind === 'string' ? node : null
}

/** A literal's range without its quotes. */
function inner(node: AST.Literal): { start: number; end: number } {
  return { start: node.start + 1, end: Math.max(node.start + 1, node.end - 1) }
}

/** The range of a member's name: the identifier, or the inside of a `['literal']`. */
function nameRange(node: AST.MemberExpression): { start: number; end: number } {
  const property = node.property
  return property.type === 'Literal' && property.kind === 'string' ? inner(property) : { start: property.start, end: property.end }
}

/** What a script or a template names, read from its text once. */
export function codeUses(ctx: QueryContext, analysis: Analysis): CodeUses {
  const uses: CodeUses = { kind: 'code', attributes: [], templates: [], resources: [] }
  if (analysis.skipped) return uses
  const lines = new Lines(analysis.text)
  const types = new Types({ ...ctx, analysis })
  const isGlobal = (node: AST.Identifier) => types.isGlobal(node)
  /** `Resource`: the platform's, a global or a name bound to it. */
  const isResource = (node: Node) => {
    if (node.type !== 'Identifier' || node.name !== 'Resource') return false
    if (isGlobal(node)) return true
    const type = types.of(node)
    return type !== null && type.kind === 'class' && type.id === RESOURCE
  }
  for (const root of analysis.roots) {
    walk(root.node, (node) => {
      if (node.type === 'MemberExpression') {
        const name = memberName(node)
        if (name === null || node.object.type !== 'MemberExpression' || memberName(node.object) !== 'custom') return
        const type = types.of(node.object)
        if (!type || type.kind !== 'custom') return
        const range = nameRange(node)
        uses.attributes.push({ ...lines.spot(range.start, range.end), typeId: type.typeId, name, preference: type.typeId === SITE_PREFERENCES })
        return
      }
      if (node.type === 'NewExpression') {
        const first = stringLiteral(node.arguments[0])
        if (first && node.callee.type === 'Identifier' && node.callee.name === 'Template') {
          const range = inner(first)
          uses.templates.push({ ...lines.spot(range.start, range.end), name: first.value as string })
        }
        return
      }
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return
      const callee = node.callee
      const method = memberName(callee)
      const first = stringLiteral(node.arguments[0])
      if (method === null || !first) return
      const range = inner(first)
      if (method === 'getCustomPreferenceValue') {
        const type = types.of(callee.object)
        if (type && type.kind === 'instance' && type.id === SITE) uses.attributes.push({ ...lines.spot(range.start, range.end), typeId: SITE_PREFERENCES, name: first.value as string, preference: true })
        return
      }
      if ((method === 'msg' || method === 'msgf') && isResource(callee.object)) {
        const second = node.arguments[1]
        let bundle: string | null = null
        if (second === undefined) bundle = method === 'msg' ? 'locale' : null
        else bundle = (stringLiteral(second)?.value as string | undefined) ?? null
        if (bundle !== null && bundle !== '') uses.resources.push({ ...lines.spot(range.start, range.end), key: first.value as string, bundle })
        return
      }
      const object = callee.object
      if (object.type !== 'Identifier') return
      if ((method === 'render' && object.name === 'res') || (method === 'renderTemplate' && object.name === 'ISML')) {
        uses.templates.push({ ...lines.spot(range.start, range.end), name: first.value as string })
      }
    })
  }
  if (analysis.document) {
    walkTemplate(analysis.document, (node) => {
      if (node.type !== 'Element' || !TEMPLATE_TAGS.has(node.name)) return
      const found = attribute(node, 'template')
      if (!found?.value || !found.value.parts.every((part) => part.type === 'Text')) return
      const name = analysis.text.slice(found.value.contentStart, found.value.contentEnd)
      if (name.trim()) uses.templates.push({ ...lines.spot(found.value.contentStart, found.value.contentEnd), name })
    })
  }
  return uses
}

/** The problems of what a file names, against the checkout as `lookup` read it. */
export function checkCode(lookup: Lookup, path: string, uses: CodeUses): Problem[] {
  const out: Problem[] = []
  for (const use of uses.attributes) {
    const known = lookup.attributes(use.typeId)
    // No metadata of that type: nothing is known of its attributes.
    if (!known || known.has(use.name)) continue
    out.push(use.preference ? problem('unknown_preference', use, { name: use.name }) : problem('unknown_attribute', use, { name: use.name, type: use.typeId }))
  }
  const templates = new Map<string, ReturnType<Lookup['presence']>>()
  for (const use of uses.templates) {
    const name = templateName(use.name)
    if (!name) continue
    let found = templates.get(name)
    if (!found) templates.set(name, (found = lookup.presence(path, (cartridge) => lookup.hasTemplate(cartridge, name))))
    if (found.kind === 'missing') out.push(problem('template_missing', use, { name }))
    else if (found.kind === 'partial') out.push(problem('template_partial', use, { name, storefronts: storefrontList(found.storefronts) }))
  }
  for (const use of uses.resources) {
    const found = lookup.presence(path, (cartridge) => lookup.hasKey(cartridge, use.bundle, use.key))
    if (found.kind === 'found' || found.kind === 'doubt') continue
    if (!lookup.bundles.has(use.bundle)) {
      // A bundle no cartridge has: one warning for it, whatever the key.
      if (found.kind === 'missing') out.push(problem('bundle_missing', use, { bundle: use.bundle }))
      else out.push(problem('resource_partial', use, { key: use.key, bundle: use.bundle, storefronts: storefrontList(found.storefronts) }))
      continue
    }
    if (found.kind === 'missing') out.push(problem('resource_missing', use, { key: use.key, bundle: use.bundle }))
    else out.push(problem('resource_partial', use, { key: use.key, bundle: use.bundle, storefronts: storefrontList(found.storefronts) }))
  }
  return out
}
