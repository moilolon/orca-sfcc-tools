// Hover: what the thing at an offset is, as data the editor words. A `dw.*` member or class (its
// signatures, deprecation and link; the description is read by the worker at run time through
// `describe.ts` and never stored), a cartridge module and the copy that runs on each storefront,
// a member of one and where each copy defines it, `module.superModule`, an SFRA route (who
// declares it, in which order the chain runs, which declaration serves the request), a template, a
// resource key, a custom attribute, an ISML tag. A completion item's id is expanded the same way.
// Every list is bounded by `MAX_HOVER_ENTRIES`. Pure: no Node, no Orca.
import type * as AST from '../js/ast'
import type { Range } from '../js/ast'
import { isSuperModule } from '../js/facts'
import type { ModuleResolution, RouteProblemCode, SuperModuleCopy, TemplateCopy } from '../checkout/checkout'
import { SITE_PREFERENCES, type ObjectTypeKind } from '../checkout/metadata'
import { DEFINING_METHODS, resourceBundle, type ExportedMember, type RouteMethod } from '../checkout/scan'
import { signature, type DwMemberKind } from '../dw/index'
import { pathAt, rootAt, type Analysis, type Root } from './analysis'
import { callRole, customTags, elementAt, stringArgumentAt } from './complete'
import { ISML_TAG_ATTRIBUTES, TEMPLATE_ATTRIBUTE_TAGS } from './isml-tags'
import { moduleMember, SUPER_MODULE, type QueryContext } from './modules'
import { cartridgeRoutes } from './routes'
import { guessedClass, isListedConstant, isStaticMember, memberName, membersFor, metadataTypeOf, subPackages, Types } from './types'

/** The longest list a hover answers (storefronts, copies, candidates, definitions, steps). */
export const MAX_HOVER_ENTRIES = 50
/** The longest value of a resource key a hover answers. */
export const MAX_VALUE_CHARACTERS = 300

/** What the worker reads through `b2c docs read` for a hover: a class, or one member's section. */
export type Describe = { classId: string; memberKey?: string }

export type DwMemberEntry = { kind: DwMemberKind; owner: string; key: string; signature: string; static: boolean; deprecated: boolean; link: string }

export type HoverContent =
  | { kind: 'dw-member'; classId: string; name: string; members: DwMemberEntry[]; describe: Describe }
  /** A class: read as the class itself (`instance: false`), or the type of a value (`true`). */
  | { kind: 'dw-class'; classId: string; instance: boolean; super: string | null; deprecated: boolean; link: string; describe: Describe }
  | { kind: 'dw-package'; name: string; classes: number; packages: number }
  /** A module of the checkout: the file it reaches, or (`*\/…`) the copy that runs on each storefront and every candidate. */
  | { kind: 'module'; module: string; form: ModuleResolution['form']; copies: { storefront: string | null; path: string | null }[]; candidates: string[] }
  | { kind: 'module-member'; module: string; name: string; definitions: MemberDefinitionEntry[] }
  | { kind: 'super-module'; module: string | null; copies: SuperModuleCopy[] }
  /** With no storefront path, `storefronts` is empty and `cartridges` says what each cartridge's controller declares. */
  | { kind: 'route'; id: string; storefronts: RouteEntry[]; cartridges: CartridgeRouteEntry[] }
  | { kind: 'template'; name: string; copies: TemplateCopy[]; candidates: string[] }
  | { kind: 'resource'; key: string; bundle: string; copies: ResourceEntry[]; candidates: number }
  | { kind: 'attribute'; typeId: string; id: string; type: string | null; objectKind: ObjectTypeKind | null; path: string | null; line: number | null; source: string | null; guessed: boolean }
  | { kind: 'tag'; name: string; custom: boolean; attributes: string[]; template: string | null; copies: TemplateCopy[] }

export type MemberDefinitionEntry = {
  /** The storefronts the definition runs on; null when the module is a file named directly. */
  storefronts: string[] | null
  path: string
  line: number
  kind: ExportedMember['kind']
  params: string[] | null
  doc: string | null
}

export type RouteStepEntry = { method: RouteMethod; name: string; path: string; cartridge: string; line: number }

export type RouteEntry = {
  storefront: string
  /** The controller copy that runs there; null when none does. */
  controller: string | null
  /** The steps in the order they run. */
  steps: RouteStepEntry[]
  /** The declaration that serves the request (the last `get`, `post`, `use` or `replace` applied); null when the route is not served. */
  serves: RouteStepEntry | null
  problems: { code: RouteProblemCode; path: string; start: number }[]
}

/** The operations of a route one cartridge's controller declares, in source order. */
export type CartridgeRouteEntry = { cartridge: string; path: string; steps: RouteStepEntry[] }

export type ResourceEntry = { storefront: string; path: string | null; cartridge: string | null; line: number | null; value: string | null }

/** A hover: what is there, and the range of the text it is about (null for a completion item's id). */
export type Hover = HoverContent & { range: Range | null }

const cap = <T>(list: readonly T[]): T[] => list.slice(0, MAX_HOVER_ENTRIES)

/** What is at `offset` of the file `analysis` read; null when nothing the engine knows. */
export function hover(ctx: QueryContext, analysis: Analysis, offset: number): Hover | null {
  if (analysis.skipped || offset < 0 || offset > analysis.text.length) return null
  const root = rootAt(analysis, offset)
  if (root) return hoverScript(ctx, analysis, root, offset)
  if (analysis.kind !== 'template') return null
  const element = elementAt(analysis, offset)
  if (!element || !element.isml) return null
  if (element.nameStart <= offset && offset <= element.nameEnd) {
    const content = tagHover(ctx, analysis, element.name)
    return content && { ...content, range: { start: element.nameStart, end: element.nameEnd } }
  }
  const value = element.attributes.find((a) => a.value && a.value.contentStart <= offset && offset <= a.value.contentEnd)
  if (value?.value && value.name === 'template' && TEMPLATE_ATTRIBUTE_TAGS.has(element.name) && value.value.parts.every((part) => part.type === 'Text')) {
    const range = { start: value.value.contentStart, end: value.value.contentEnd }
    return { ...templateHover(ctx, analysis.text.slice(range.start, range.end)), range }
  }
  return null
}

function tagHover(ctx: QueryContext, analysis: Analysis | null, name: string): HoverContent | null {
  if (ISML_TAG_ATTRIBUTES[name]) return { kind: 'tag', name, custom: false, attributes: [...ISML_TAG_ATTRIBUTES[name]], template: null, copies: [] }
  const custom = analysis ? customTags(ctx, analysis).get(name) : undefined
  if (!custom) return null
  return { kind: 'tag', name, custom: true, attributes: [...custom.attributes], template: custom.template, copies: custom.template ? cap(ctx.index.resolveTemplate(custom.template).copies) : [] }
}

function templateHover(ctx: QueryContext, name: string): HoverContent {
  const resolved = ctx.index.resolveTemplate(name)
  return { kind: 'template', name: resolved.name, copies: cap(resolved.copies), candidates: cap(resolved.candidates) }
}

function hoverScript(ctx: QueryContext, analysis: Analysis, root: Root, offset: number): Hover | null {
  const types = new Types({ ...ctx, analysis })
  const argument = stringArgumentAt(analysis, root, offset)
  if (argument) {
    if (!argument.call) return null
    const role = callRole(types, argument.call)
    const value = argument.literal.value as string
    const range = argument.content
    let content: HoverContent | null = null
    if (role === 'require' && argument.index === 0) content = moduleHover(ctx, analysis.path, value)
    else if (role === 'resource' && argument.index <= 1) {
      const key = literal(argument.call, 0)
      const bundle = argument.call.type === 'CallExpression' && argument.call.callee.type === 'MemberExpression' ? resourceBundle(memberName(argument.call.callee) ?? '', argument.call.arguments) : undefined
      if (key !== null && bundle !== undefined) content = resourceHover(ctx, key, bundle)
    } else if (role === 'template' && argument.index === 0) content = templateHover(ctx, value)
    else if (role === 'route' && argument.index === 0) content = routeHover(ctx, value)
    else if (role === 'route-declaration' && argument.index === 0 && argument.call.type === 'CallExpression') content = declarationHover(ctx, analysis, argument.call, value)
    else if (role === 'preference' && argument.index === 0) content = attributeHover(ctx, SITE_PREFERENCES, value, false)
    return content && { ...content, range }
  }
  const path = pathAt(root.node, offset)
  const node = path[path.length - 1]
  if (!node || node.type !== 'Identifier' || offset < node.start || offset > node.end) return null
  const range = { start: node.start, end: node.end }
  const parent = path[path.length - 2]
  if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
    const content = memberHover(ctx, types, parent, node.name)
    return content && { ...content, range }
  }
  const content = valueHover(ctx, types, node)
  return content && { ...content, range }
}

function literal(call: AST.CallExpression | AST.NewExpression, index: number): string | null {
  const argument = call.arguments[index]
  return argument && argument.type === 'Literal' && argument.kind === 'string' ? (argument.value as string) : null
}

/** `object.name`: what `name` is, read off what `object` is. */
function memberHover(ctx: QueryContext, types: Types, node: AST.MemberExpression, name: string): HoverContent | null {
  if (isSuperModule(node) && node.object.type === 'Identifier' && types.isGlobal(node.object)) {
    const resolved = ctx.index.superModule(types.path())
    return { kind: 'super-module', module: resolved.module, copies: cap(resolved.copies) }
  }
  if (node.object.type === 'Super') return null
  const object = types.of(node.object)
  if (!object) {
    // `name.custom.attribute` of a name nothing types: the short list of names.
    const holder = node.object
    if (holder.type === 'MemberExpression' && memberName(holder) === 'custom' && holder.object.type === 'Identifier' && types.of(holder.object) === null && types.guessable(holder.object)) {
      const cls = guessedClass(holder.object.name)
      const typeId = cls ? metadataTypeOf(ctx.dw, cls) : null
      if (typeId) return attributeHover(ctx, typeId, name, true)
    }
    return null
  }
  switch (object.kind) {
    case 'custom':
      return attributeHover(ctx, object.typeId, name, false)
    case 'module':
      return moduleMemberHover(ctx, object.from, object.module, name)
    case 'package':
    case 'class':
    case 'instance': {
      const type = types.memberOf(object, name)
      if (type?.kind === 'class') return classHover(ctx, type.id, false)
      if (type?.kind === 'package') return packageHover(ctx, type.name)
      if (object.kind === 'package') return null
      return dwMemberHover(ctx, object.id, name, object.kind === 'class')
    }
  }
  return null
}

/** A name on its own: what its type is. */
function valueHover(ctx: QueryContext, types: Types, node: AST.Identifier): HoverContent | null {
  const type = types.of(node)
  if (!type) return null
  switch (type.kind) {
    case 'class':
      return classHover(ctx, type.id, false)
    case 'instance':
      return classHover(ctx, type.id, true)
    case 'package':
      return packageHover(ctx, type.name)
    case 'module':
      return moduleHover(ctx, type.from, type.module)
    case 'member':
      return moduleMemberHover(ctx, type.from, type.module, type.name)
    case 'method':
      return dwMemberHover(ctx, type.owner, type.name, type.static)
  }
  return null
}

function dwMemberHover(ctx: QueryContext, classId: string, name: string, ofClass: boolean): HoverContent | null {
  const dw = ctx.dw
  const cls = dw?.findClass(classId)
  if (!dw || !cls) return null
  // A global function is read off `TopLevel.global`, whose members are all static.
  const members = (cls.id === 'TopLevel.global' ? dw.members(cls) : membersFor(dw, cls, ofClass)).filter((member) => member.name === name)
  if (members.length === 0) return null
  const entries = cap(members).map((member): DwMemberEntry => {
    const owner = dw.findClass(member.owner) ?? cls
    return { kind: member.kind, owner: member.owner, key: member.key, signature: signature(member), static: member.static, deprecated: member.deprecated, link: dw.link(owner, member) }
  })
  return { kind: 'dw-member', classId: cls.id, name, members: entries, describe: { classId: entries[0].owner, memberKey: entries[0].key } }
}

function classHover(ctx: QueryContext, classId: string, instance: boolean): HoverContent | null {
  const dw = ctx.dw
  const cls = dw?.findClass(classId)
  if (!dw || !cls) return null
  return { kind: 'dw-class', classId: cls.id, instance, super: cls.super, deprecated: cls.deprecated, link: dw.link(cls), describe: { classId: cls.id } }
}

function packageHover(ctx: QueryContext, name: string): HoverContent | null {
  const dw = ctx.dw
  if (!dw) return null
  return { kind: 'dw-package', name, classes: dw.packageClasses(name).length, packages: subPackages(dw, name).length }
}

/** `require(module)` from `from`. */
function moduleHover(ctx: QueryContext, from: string, module: string): HoverContent | null {
  if (module === SUPER_MODULE) {
    const resolved = ctx.index.superModule(from)
    return { kind: 'super-module', module: resolved.module, copies: cap(resolved.copies) }
  }
  const resolved = ctx.index.resolveModule(from, module)
  if (resolved.kind === 'dw') {
    if (!ctx.dw) return null
    const id = module.replace(/\//g, '.')
    const cls = ctx.dw.findClass(id)
    if (cls && cls.id === id) return classHover(ctx, id, false)
    return ctx.dw.packageClasses(id).length > 0 ? packageHover(ctx, id) : null
  }
  if (resolved.kind === 'file') return { kind: 'module', module, form: resolved.form, copies: [{ storefront: null, path: resolved.path }], candidates: [] }
  return { kind: 'module', module, form: resolved.form, copies: cap(resolved.copies), candidates: cap(resolved.candidates) }
}

function moduleMemberHover(ctx: QueryContext, from: string, module: string, name: string): HoverContent | null {
  const definitions = moduleMember(ctx, from, module, name)
  if (definitions.length === 0) return null
  return {
    kind: 'module-member',
    module,
    name,
    definitions: cap(definitions).map((each) => {
      const place = each.member.definition ?? each.member
      return { storefronts: each.storefronts, path: each.path, line: place.line, kind: each.member.kind, params: each.member.params, doc: each.member.doc }
    })
  }
}

function resourceHover(ctx: QueryContext, key: string, bundle: string | null): HoverContent {
  const resolved = ctx.index.resolveResource(key, bundle)
  const copies = cap(resolved.copies).map((copy): ResourceEntry => ({
    storefront: copy.storefront,
    path: copy.key?.path ?? null,
    cartridge: copy.key?.cartridge ?? null,
    line: copy.key?.line ?? null,
    value: copy.key ? (copy.key.value.length > MAX_VALUE_CHARACTERS ? `${copy.key.value.slice(0, MAX_VALUE_CHARACTERS)}…` : copy.key.value) : null
  }))
  return { kind: 'resource', key, bundle: resolved.bundle, copies, candidates: resolved.candidates.length }
}

function attributeHover(ctx: QueryContext, typeId: string, id: string, guessed: boolean): HoverContent | null {
  const attribute = ctx.index.attributes(typeId).find((each) => each.id === id)
  if (!attribute) return null
  const objectKind = ctx.index.types().find((type) => type.typeId === typeId)?.kind ?? null
  return { kind: 'attribute', typeId, id, type: attribute.type, objectKind, path: attribute.path, line: attribute.line, source: attribute.source, guessed }
}

function routeHover(ctx: QueryContext, id: string): HoverContent | null {
  const resolved = ctx.index.route(id)
  if (!resolved) return null
  const step = (each: { method: RouteMethod; name: string; path: string; cartridge: string; line: number }): RouteStepEntry => ({ method: each.method, name: each.name, path: each.path, cartridge: each.cartridge, line: each.line })
  if (resolved.storefronts.length === 0) {
    // No storefront path: what each cartridge's controller declares, the chain unknown.
    const declared = cartridgeRoutes(ctx).get(`${resolved.controller}-${resolved.name}`) ?? []
    if (declared.length === 0) return null
    const byCartridge = new Map<string, CartridgeRouteEntry>()
    for (const route of declared) {
      let entry = byCartridge.get(route.path)
      if (!entry) byCartridge.set(route.path, (entry = { cartridge: route.cartridge, path: route.path, steps: [] }))
      entry.steps.push(step({ ...route.operation, path: route.path, cartridge: route.cartridge }))
    }
    return { kind: 'route', id: `${resolved.controller}-${resolved.name}`, storefronts: [], cartridges: cap([...byCartridge.values()]) }
  }
  return {
    kind: 'route',
    id: `${resolved.controller}-${resolved.name}`,
    cartridges: [],
    storefronts: cap(resolved.storefronts).map((chain): RouteEntry => {
      const steps = cap(chain.steps).map(step)
      const serves = [...chain.steps].reverse().find((each) => DEFINING_METHODS.has(each.method) || each.method === 'replace')
      return { storefront: chain.storefront, controller: chain.controller, steps, serves: serves ? step(serves) : null, problems: cap(chain.problems).map((problem) => ({ code: problem.code, path: problem.path, start: problem.start })) }
    })
  }
}

/** `server.get('Show', …)` in a controller: the route `Controller-Show`, when `server` is `require('server')`. */
function declarationHover(ctx: QueryContext, analysis: Analysis, call: AST.CallExpression, name: string): HoverContent | null {
  const controller = /(?:^|\/)cartridge\/controllers\/([^/]+)\.(?:js|ds)$/i.exec(analysis.path)?.[1]
  const callee = call.callee
  if (!controller || callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return null
  const declaration = analysis.references.get(callee.object.start)?.declaration
  const isServer = analysis.facts.requires.some((each) => each.module === 'server' && each.member === null && each.binding?.kind === 'name' && each.binding.declaration === declaration && declaration !== null)
  return isServer ? routeHover(ctx, `${controller}-${name}`) : null
}

// ---------------------------------------------------------------------------------------------
// A completion item's id

/**
 * The hover of a completion item, by its id (`dw:…`, `dwclass:…`, `dwpackage:…`, `member:<path>#<name>`,
 * `custom:<type>#<id>`, `key:<bundle>#<key>`, `template:…`, `module:…`, `route:…`,
 * `tag:…`). `analysis` is the file the list was asked in, for what depends on it (a module's
 * `~/`, a template's custom tags); null when the id names nothing known.
 */
export function hoverItem(ctx: QueryContext, analysis: Analysis | null, id: string): Hover | null {
  const colon = id.indexOf(':')
  if (colon <= 0) return null
  const kind = id.slice(0, colon)
  const rest = id.slice(colon + 1)
  const hash = rest.lastIndexOf('#')
  const head = hash === -1 ? rest : rest.slice(0, hash)
  const tail = hash === -1 ? '' : rest.slice(hash + 1)
  const from = analysis?.path ?? ''
  let content: HoverContent | null = null
  switch (kind) {
    case 'dw': {
      const dw = ctx.dw
      const cls = dw?.findClass(head)
      const member = cls && dw ? dw.members(cls).find((each) => each.key === tail) : undefined
      // Read off the class when the completion offered it there: a static member, a static property, a constant.
      content = member && cls && dw ? dwMemberHover(ctx, cls.id, member.name, isStaticMember(dw.members(cls), member) || isListedConstant(dw.members(cls), member)) : null
      break
    }
    case 'dwclass':
      content = classHover(ctx, rest, false)
      break
    case 'dwpackage':
      content = packageHover(ctx, rest)
      break
    case 'member': {
      const exports = ctx.index.fileFacts(head)
      if (exports?.kind !== 'script') break
      const member = exports.exports.members.find((each) => each.name === tail)
      if (!member) break
      const place = member.definition ?? member
      content = { kind: 'module-member', module: head, name: tail, definitions: [{ storefronts: null, path: head, line: place.line, kind: member.kind, params: member.params, doc: member.doc }] }
      break
    }
    case 'custom':
      content = attributeHover(ctx, head, tail, false)
      break
    case 'key':
      content = resourceHover(ctx, tail, head)
      break
    case 'template':
      content = templateHover(ctx, rest)
      break
    case 'module':
      content = moduleHover(ctx, from, rest)
      break
    case 'route':
      content = routeHover(ctx, rest)
      break
    case 'tag':
      content = tagHover(ctx, analysis, rest)
      break
  }
  return content && { ...content, range: null }
}
