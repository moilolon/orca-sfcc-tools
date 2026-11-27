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
// - A name the code tests for existence is not warned after that test, in the same function (the
//   innermost one holding the test; the whole file for a test outside every function): the code
//   says itself that it may not exist. An existence test is `'y' in x.custom`,
//   `x.custom.hasOwnProperty('y')`, `Object.prototype.hasOwnProperty.call(x.custom, 'y')`,
//   `typeof x.custom.y`, or `x.custom.y` (or `getCustomPreferenceValue('y')`) compared with
//   `undefined` or `null`. A truthiness test (`if (x.custom.y)`, `!x.custom.y`, `?:`, `&&`) is how
//   a boolean is read, not a test of existence, and a fallback (`|| ''`) hides an absent name:
//   both are warned, as is a use before the test or in another function.
// - Template: the literal name of `res.render`, `ISML.renderTemplate`, `new Template`, and the
//   `template` attribute of `<isinclude>`, `<isdecorate>` and `<ismodule>` when it holds no `${…}`.
//   Found in any locale folder of a cartridge of the path. Missing everywhere or on some storefronts
//   only, as `lookup.ts` says (`presence`).
// - Resource key: `Resource.msg` and `Resource.msgf`, the key a literal, with `Resource` the
//   platform's (a global, or bound to `require('dw/web/Resource')`). The bundle is the one the call
//   reads as `dw.web.Resource` documents it (`resourceBundle` of `checkout/scan.ts`): `message` for
//   `msg(key)`, `msg(key, defaultMessage)` and a `null` bundle, else the literal named; a bundle
//   known only at run time is not read. Found when a cartridge of the path has the key in that
//   bundle, in any locale, or in a bundle whose file has that very name. A bundle no cartridge has
//   at all is `bundle_missing` instead.
import type * as AST from '../js/ast'
import { walk, type Node } from '../js/ast'
import { attribute, walkTemplate } from '../isml/parser'
import { DEFAULT_BUNDLE, templateName } from '../checkout/checkout'
import { resourceBundle } from '../checkout/scan'
import type { Analysis } from '../query/analysis'
import type { QueryContext } from '../query/modules'
import { memberName, Types } from '../query/types'
import { SITE_PREFERENCES } from '../checkout/metadata'
import type { Lookup } from './lookup'
import { Lines, problem, storefrontList, type Problem, type Spot } from './problem'

export type AttributeUse = Spot & {
  typeId: string
  name: string
  preference: boolean
  /** An existence test of this name comes before this use, in its function: it is not warned. */
  guarded: boolean
}
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
/** What every object has, read off `x.custom` as a method: never a custom attribute. */
const OBJECT_METHODS: ReadonlySet<string> = new Set(['hasOwnProperty', 'propertyIsEnumerable', 'isPrototypeOf', 'toString', 'toLocaleString', 'valueOf', 'constructor'])
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
  /** The custom attribute an expression reads: `x.custom.y`, or a site's `getCustomPreferenceValue('y')`. */
  const attributeOf = (node: Node): { typeId: string; name: string } | null => {
    if (node.type === 'MemberExpression') {
      const name = memberName(node)
      if (name === null || OBJECT_METHODS.has(name) || node.object.type !== 'MemberExpression' || memberName(node.object) !== 'custom') return null
      const type = types.of(node.object)
      return type && type.kind === 'custom' ? { typeId: type.typeId, name } : null
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && memberName(node.callee) === 'getCustomPreferenceValue') {
      const first = stringLiteral(node.arguments[0])
      const type = node.callee.object.type === 'Super' ? null : types.of(node.callee.object)
      return first && type && type.kind === 'instance' && type.id === SITE ? { typeId: SITE_PREFERENCES, name: first.value as string } : null
    }
    return null
  }
  /** The object type whose custom attributes an expression is (`x.custom`); null for anything else. */
  const customOf = (node: Node | undefined): string | null => {
    if (!node || node.type === 'SpreadElement' || node.type === 'Super') return null
    const type = types.of(node as AST.Expression)
    return type && type.kind === 'custom' ? type.typeId : null
  }
  /** Every function's range: a test counts only inside the innermost function that holds it. */
  const functions: { start: number; end: number }[] = []
  for (const root of analysis.roots) {
    walk(root.node, (node) => {
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') functions.push({ start: node.start, end: node.end })
    })
  }
  /** The range a test at `at` covers: its innermost function, else the whole file (a template's too). */
  const scopeOf = (at: number): { start: number; end: number } => {
    let best = { start: 0, end: analysis.text.length }
    for (const fn of functions) if (fn.start <= at && at < fn.end && fn.end - fn.start < best.end - best.start) best = fn
    return best
  }
  /** Each name's tests, by `<type>\u0000<name>`: where each is, and the range it covers. */
  const guards = new Map<string, { at: number; start: number; end: number }[]>()
  const guard = (typeId: string | null, name: string | null, at: number) => {
    if (typeId === null || name === null) return
    const key = `${typeId}\u0000${name}`
    const list = guards.get(key) ?? []
    list.push({ at, ...scopeOf(at) })
    guards.set(key, list)
  }
  /** `null` or `undefined`: what a comparison with nothing compares to. */
  const nothing = (side: Node) => (side.type === 'Literal' && side.kind === 'null') || (side.type === 'Identifier' && side.name === 'undefined')
  /** An attribute read that is itself the test (`typeof x.custom.y`, `x.custom.y === undefined`). */
  const testedRead = (node: Node) => {
    const found = attributeOf(node)
    if (found) guard(found.typeId, found.name, node.start)
  }
  for (const root of analysis.roots) {
    walk(root.node, (node) => {
      switch (node.type) {
        case 'UnaryExpression':
          if (node.operator === 'typeof') testedRead(node.argument)
          break
        case 'BinaryExpression':
          if (node.operator === 'in') guard(customOf(node.right), (stringLiteral(node.left)?.value as string | undefined) ?? null, node.start)
          else if (/^[!=]==?$/.test(node.operator) && (nothing(node.left) || nothing(node.right))) testedRead(nothing(node.left) ? node.right : node.left)
          break
        case 'CallExpression': {
          const callee = node.callee
          if (callee.type !== 'MemberExpression') break
          const method = memberName(callee)
          if (method === 'hasOwnProperty') guard(customOf(callee.object), (stringLiteral(node.arguments[0])?.value as string | undefined) ?? null, node.start)
          // `Object.prototype.hasOwnProperty.call(x.custom, 'y')`, `{}.hasOwnProperty.call(…)`.
          else if (method === 'call' && callee.object.type === 'MemberExpression' && memberName(callee.object) === 'hasOwnProperty') guard(customOf(node.arguments[0]), (stringLiteral(node.arguments[1])?.value as string | undefined) ?? null, node.start)
          break
        }
      }
    })
  }
  for (const root of analysis.roots) {
    walk(root.node, (node) => {
      if (node.type === 'MemberExpression') {
        const name = memberName(node)
        if (name === null || OBJECT_METHODS.has(name) || node.object.type !== 'MemberExpression' || memberName(node.object) !== 'custom') return
        const type = types.of(node.object)
        if (!type || type.kind !== 'custom') return
        const range = nameRange(node)
        uses.attributes.push({ ...lines.spot(range.start, range.end), typeId: type.typeId, name, preference: type.typeId === SITE_PREFERENCES, guarded: false })
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
        if (type && type.kind === 'instance' && type.id === SITE) uses.attributes.push({ ...lines.spot(range.start, range.end), typeId: SITE_PREFERENCES, name: first.value as string, preference: true, guarded: false })
        return
      }
      if ((method === 'msg' || method === 'msgf') && isResource(callee.object)) {
        const bundle = resourceBundle(method, node.arguments)
        if (bundle !== undefined && bundle !== '') uses.resources.push({ ...lines.spot(range.start, range.end), key: first.value as string, bundle: bundle ?? DEFAULT_BUNDLE })
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
  for (const use of uses.attributes) {
    const tests = guards.get(`${use.typeId}\u0000${use.name}`) ?? []
    use.guarded = tests.some((test) => test.at <= use.start && test.start <= use.start && use.start < test.end)
  }
  return uses
}

/** The problems of what a file names, against the checkout as `lookup` read it. */
export function checkCode(lookup: Lookup, path: string, uses: CodeUses): Problem[] {
  const out: Problem[] = []
  for (const use of uses.attributes) {
    const known = lookup.attributes(use.typeId)
    // No metadata of that type: nothing is known of its attributes. A name the file tests for may be absent.
    if (!known || known.has(use.name) || use.guarded) continue
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
