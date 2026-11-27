// Go to definition: where the thing at an offset is defined, as a list of places, more than one
// when storefronts run different copies (each place says the storefronts it serves; `null` when
// none can be named, see `ModuleCopy`). A template name (`template="…"`, `res.render`, `ISML.renderTemplate`,
// `new Template`) and a `require` go to the file; a `Resource.msg` key to its line in the bundle;
// a member of a cartridge module, along each path and `module.superModule`, to where it is
// declared; a route name to the declaration that serves it; a custom attribute to its metadata;
// a custom tag to its template; a name to its declaration in the file. Pure: no Node, no Orca.
import type * as AST from '../js/ast'
import type { Range } from '../js/ast'
import { SITE_PREFERENCES } from '../checkout/metadata'
import { DEFINING_METHODS } from '../checkout/scan'
import { lineAt, lineStarts } from '../checkout/files'
import { pathAt, rootAt, type Analysis, type Root } from './analysis'
import { callRole, customTags, elementAt, stringArgumentAt } from './complete'
import { TEMPLATE_ATTRIBUTE_TAGS } from './isml-tags'
import { moduleCopies, moduleMember, SUPER_MODULE, type QueryContext } from './modules'
import { cartridgeRoutes } from './routes'
import { guessedClass, memberName, metadataTypeOf, Types } from './types'

/** At most this many places are answered. */
export const MAX_TARGETS = 50

/**
 * A place: a file of the workspace, the range there (empty at 0 for a whole file), its 1-based
 * line, the storefronts it serves; null when no storefront can be named (see `ModuleCopy`).
 */
export type Target = { path: string; start: number; end: number; line: number; storefronts: string[] | null }

export type DefinitionKind = 'template' | 'module' | 'resource' | 'member' | 'super-module' | 'route' | 'attribute' | 'tag' | 'declaration'

/** What is at the offset (`range`, in the text given) and where it is defined. */
export type Definition = { kind: DefinitionKind; range: Range; targets: Target[] }

/** Gathers places, one per file and range, with every storefront that reaches it. */
class Places {
  readonly list: Target[] = []
  private readonly byKey = new Map<string, Target>()
  add(path: string, start: number, end: number, line: number, storefront: string | null): void {
    const key = `${path}\u0000${start}\u0000${end}`
    const known = this.byKey.get(key)
    if (known) {
      if (known.storefronts && storefront !== null && !known.storefronts.includes(storefront)) known.storefronts.push(storefront)
      if (storefront === null) known.storefronts = null
      return
    }
    if (this.list.length >= MAX_TARGETS) return
    const target: Target = { path, start, end, line, storefronts: storefront === null ? null : [storefront] }
    this.byKey.set(key, target)
    this.list.push(target)
  }
  file(path: string, storefront: string | null): void {
    this.add(path, 0, 0, 1, storefront)
  }
}

const answer = (kind: DefinitionKind, range: Range, places: Places): Definition | null => (places.list.length > 0 ? { kind, range, targets: places.list } : null)

/** Where the thing at `offset` of the file `analysis` read is defined; null when nothing the engine knows. */
export function definition(ctx: QueryContext, analysis: Analysis, offset: number): Definition | null {
  if (analysis.skipped || offset < 0 || offset > analysis.text.length) return null
  const root = rootAt(analysis, offset)
  if (root) return scriptDefinition(ctx, analysis, root, offset)
  if (analysis.kind !== 'template') return null
  const element = elementAt(analysis, offset)
  if (!element || !element.isml) return null
  if (element.custom && element.nameStart <= offset && offset <= element.nameEnd) {
    const tag = customTags(ctx, analysis).get(element.name)
    if (!tag?.template) return null
    return answer('tag', { start: element.nameStart, end: element.nameEnd }, templatePlaces(ctx, tag.template))
  }
  const value = element.attributes.find((a) => a.value && a.value.contentStart <= offset && offset <= a.value.contentEnd)?.value
  const name = element.attributes.find((a) => a.value === value)?.name
  if (!value || name !== 'template' || !TEMPLATE_ATTRIBUTE_TAGS.has(element.name) || !value.parts.every((part) => part.type === 'Text')) return null
  return answer('template', { start: value.contentStart, end: value.contentEnd }, templatePlaces(ctx, analysis.text.slice(value.contentStart, value.contentEnd)))
}

/** The copy of a template each storefront renders; with no storefront path, every copy. */
function templatePlaces(ctx: QueryContext, name: string): Places {
  const places = new Places()
  const resolved = ctx.index.resolveTemplate(name)
  for (const copy of resolved.copies) if (copy.path) places.file(copy.path, copy.storefront)
  if (resolved.copies.length === 0) for (const path of resolved.candidates) places.file(path, null)
  return places
}

function scriptDefinition(ctx: QueryContext, analysis: Analysis, root: Root, offset: number): Definition | null {
  const types = new Types({ ...ctx, analysis })
  const argument = stringArgumentAt(analysis, root, offset)
  if (argument) {
    if (!argument.call) return null
    const role = callRole(types, argument.call)
    const value = argument.literal.value as string
    const range = argument.content
    if (role === 'template' && argument.index === 0) return answer('template', range, templatePlaces(ctx, value))
    if (role === 'require' && argument.index === 0) {
      const places = new Places()
      for (const copy of moduleCopies(ctx, analysis.path, value)) places.file(copy.path, copy.storefront)
      return answer('module', range, places)
    }
    if (role === 'resource' && argument.index === 0) return answer('resource', range, resourcePlaces(ctx, value, literal(argument.call, 1)))
    if (role === 'route' && argument.index === 0) return answer('route', range, routePlaces(ctx, value))
    if (role === 'route-declaration' && argument.index === 0) {
      const controller = /(?:^|\/)cartridge\/controllers\/([^/]+)\.(?:js|ds)$/i.exec(analysis.path)?.[1]
      return controller ? answer('route', range, routePlaces(ctx, `${controller}-${value}`)) : null
    }
    if (role === 'preference' && argument.index === 0) return answer('attribute', range, attributePlaces(ctx, SITE_PREFERENCES, value))
    return null
  }
  const path = pathAt(root.node, offset)
  const node = path[path.length - 1]
  if (!node || node.type !== 'Identifier' || offset < node.start || offset > node.end) return null
  const range = { start: node.start, end: node.end }
  const parent = path[path.length - 2]
  if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return memberDefinition(ctx, analysis, types, parent, node.name, range)
  // A name: its declaration in the file.
  const declaration = analysis.declarations.get(node.start) ?? (() => {
    const id = analysis.references.get(node.start)?.declaration
    return id === null || id === undefined ? undefined : analysis.facts.declarations[id]
  })()
  if (!declaration) return null
  const places = new Places()
  places.add(analysis.path, declaration.start, declaration.end, lineAt(lineStarts(analysis.text), declaration.start), null)
  return answer('declaration', range, places)
}

function memberDefinition(ctx: QueryContext, analysis: Analysis, types: Types, node: AST.MemberExpression, name: string, range: Range): Definition | null {
  if (node.object.type === 'Super') return null
  if (name === 'superModule' && node.object.type === 'Identifier' && node.object.name === 'module' && types.isGlobal(node.object)) {
    const places = new Places()
    for (const copy of moduleCopies(ctx, analysis.path, SUPER_MODULE)) places.file(copy.path, copy.storefront)
    return answer('super-module', range, places)
  }
  const object = types.of(node.object)
  if (object?.kind === 'module') {
    const places = new Places()
    for (const definition of moduleMember(ctx, object.from, object.module, name)) {
      const place = definition.member.definition ?? definition.member
      if (definition.storefronts === null) places.add(definition.path, place.start, place.end, place.line, null)
      else for (const storefront of definition.storefronts) places.add(definition.path, place.start, place.end, place.line, storefront)
    }
    return answer('member', range, places)
  }
  if (object?.kind === 'custom') return answer('attribute', range, attributePlaces(ctx, object.typeId, name))
  if (!object) {
    const holder = node.object
    if (holder.type === 'MemberExpression' && memberName(holder) === 'custom' && holder.object.type === 'Identifier' && types.of(holder.object) === null && types.guessable(holder.object)) {
      const cls = guessedClass(holder.object.name)
      const typeId = cls ? metadataTypeOf(ctx.dw, cls) : null
      if (typeId) return answer('attribute', range, attributePlaces(ctx, typeId, name))
    }
  }
  return null
}

function literal(call: AST.CallExpression | AST.NewExpression, index: number): string | null {
  const argument = call.arguments[index]
  return argument && argument.type === 'Literal' && argument.kind === 'string' ? (argument.value as string) : null
}

/** The key's line in the bundle each storefront reads; with no storefront path, every definition. */
function resourcePlaces(ctx: QueryContext, key: string, bundle: string | null): Places {
  const places = new Places()
  const resolved = ctx.index.resolveResource(key, bundle)
  for (const copy of resolved.copies) if (copy.key) places.add(copy.key.path, copy.key.start, copy.key.end, copy.key.line, copy.storefront)
  if (places.list.length === 0) for (const candidate of resolved.candidates) places.add(candidate.path, candidate.start, candidate.end, candidate.line, null)
  return places
}

/** The declaration that serves a route on each storefront: its name in the `get`, `post`, `use` or `replace`. */
function routePlaces(ctx: QueryContext, id: string): Places {
  const places = new Places()
  const chains = ctx.index.route(id)?.storefronts ?? []
  for (const chain of chains) {
    const serves = [...chain.steps].reverse().find((step) => DEFINING_METHODS.has(step.method) || step.method === 'replace')
    if (serves) places.add(serves.path, serves.nameStart, serves.nameEnd, serves.line, chain.storefront)
  }
  // No storefront path: every cartridge's declaration of it, which one serves unknown.
  if (chains.length === 0) {
    for (const route of cartridgeRoutes(ctx).get(id) ?? []) {
      const operation = route.operation
      if (DEFINING_METHODS.has(operation.method) || operation.method === 'replace') places.add(route.path, operation.nameStart, operation.nameEnd, operation.line, null)
    }
  }
  return places
}

function attributePlaces(ctx: QueryContext, typeId: string, id: string): Places {
  const places = new Places()
  const attribute = ctx.index.attributes(typeId).find((each) => each.id === id)
  // A definition read from the git ref is not a file of the checkout: there is nowhere to go.
  if (attribute && attribute.source === 'checkout') places.add(attribute.path, attribute.start, attribute.end, attribute.line, null)
  return places
}
