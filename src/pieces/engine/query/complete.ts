// Completion: first where the offset is (an ISML tag's name, its attributes, a `template="…"`
// value, a string argument of a call the engine knows, a member after a dot), then what to offer
// there. Nothing is offered where nothing is known: a member of an unknown value, a custom
// attribute of an object whose type is not known (but for a short list of names, and only for
// `name.custom.`). Every item has a label, a kind, a detail (a signature or a type) and an id
// hover can expand. At most `MAX_COMPLETION_ITEMS`, filtered by what is typed. Pure.
import type * as AST from '../js/ast'
import type { Range } from '../js/ast'
import { SITE_PREFERENCES } from '../checkout/metadata'
import type { DwClass, DwIndex, DwMember } from '../dw/index'
import { signature } from '../dw/index'
import { walkTemplate, type Element } from '../isml/parser'
import { pathAt, rootAt, stringContent, wordAround, type Analysis, type Root } from './analysis'
import { ISML_TAG_ATTRIBUTES, ismlTags, TEMPLATE_ATTRIBUTE_TAGS } from './isml-tags'
import { moduleMembers, type QueryContext } from './modules'
import { guessedClass, membersFor, memberName, metadataTypeOf, subPackages, Types, type QType } from './types'

export const MAX_COMPLETION_ITEMS = 200

export type CompletionKind =
  | 'tag'
  | 'tag-attribute'
  | 'package'
  | 'class'
  | 'constant'
  | 'property'
  | 'method'
  | 'function'
  | 'value'
  | 'custom-attribute'
  | 'site-preference'
  | 'resource-key'
  | 'bundle'
  | 'template'
  | 'module'
  | 'route'

export type CompletionItem = {
  label: string
  kind: CompletionKind
  /** A signature or a type; null when there is nothing to say. */
  detail: string | null
  /** What `engine.hover` expands with `{ id }` (`dw:dw.catalog.ProductMgr#getProduct(String)`, `template:product/tile`, …). */
  id: string
  deprecated?: true
}

/** Where the offset was found: what the items are. `none` when nothing is offered there. */
export type CompletionContext = 'none' | 'tag' | 'tag-attribute' | 'member' | 'custom' | 'resource-key' | 'bundle' | 'template' | 'module' | 'route' | 'site-preference'

export type Completion = {
  context: CompletionContext
  /** What an item replaces: the word or the string around the offset. */
  range: Range
  items: CompletionItem[]
  /** More items matched than were answered. */
  truncated: boolean
  /** The custom attributes are those of a type guessed from the variable's name. */
  guessed: boolean
}

const none = (offset: number): Completion => ({ context: 'none', range: { start: offset, end: offset }, items: [], truncated: false, guessed: false })

/** What to offer at `offset` of the file `analysis` read. */
export function complete(ctx: QueryContext, analysis: Analysis, offset: number): Completion {
  if (analysis.skipped || offset < 0 || offset > analysis.text.length) return none(offset)
  const root = rootAt(analysis, offset)
  if (root) return completeScript(ctx, analysis, root, offset)
  if (analysis.kind === 'template') return completeTemplate(ctx, analysis, offset)
  return none(offset)
}

/** Keeps the items whose label starts with `prefix` (any case), at most `MAX_COMPLETION_ITEMS`. */
function answer(context: CompletionContext, range: Range, prefix: string, items: Iterable<CompletionItem>, guessed = false): Completion {
  const lower = prefix.toLowerCase()
  const out: CompletionItem[] = []
  let truncated = false
  for (const item of items) {
    if (!item.label.toLowerCase().startsWith(lower)) continue
    if (out.length >= MAX_COMPLETION_ITEMS) {
      truncated = true
      break
    }
    out.push(item)
  }
  return { context, range, items: out, truncated, guessed }
}

// ---------------------------------------------------------------------------------------------
// Templates

/** The element whose start tag holds the offset (the innermost one, for a tag written inside another's). */
export function elementAt(analysis: Analysis, offset: number): Element | null {
  let found: Element | null = null
  if (!analysis.document) return null
  walkTemplate(analysis.document, (node) => {
    if (node.type !== 'Element') return
    // After the `>` of a closed tag is its content, no longer the tag.
    const end = analysis.text[node.openEnd - 1] === '>' ? node.openEnd - 1 : node.openEnd
    if (node.start > offset || offset > end) return
    if (!found || node.start >= found.start) found = node
  })
  return found
}

/** The custom tags a template can use: its own `<ismodule>`s and those of the templates it includes. */
export function customTags(ctx: QueryContext, analysis: Analysis): Map<string, { attributes: string[]; template: string | null; path: string | null }> {
  const tags = new Map<string, { attributes: string[]; template: string | null; path: string | null }>()
  for (const module of analysis.document?.modules ?? []) tags.set(`is${module.name}`, { attributes: module.attributes, template: module.template, path: null })
  // One level of `<isinclude>`, as SFRA includes its modules template.
  const included = new Set<string>()
  if (analysis.document) {
    walkTemplate(analysis.document, (node) => {
      if (node.type !== 'Element' || node.name !== 'isinclude') return
      const value = node.attributes.find((a) => a.name === 'template')?.value
      if (value && value.parts.every((part) => part.type === 'Text')) included.add(analysis.text.slice(value.contentStart, value.contentEnd))
    })
  }
  for (const name of included) {
    for (const copy of ctx.index.resolveTemplate(name).copies) {
      const facts = copy.path ? ctx.index.fileFacts(copy.path) : null
      if (!facts || facts.kind !== 'template') continue
      for (const module of facts.modules) if (!tags.has(`is${module.name}`)) tags.set(`is${module.name}`, { attributes: module.attributes, template: module.template, path: copy.path })
    }
  }
  return tags
}

function completeTemplate(ctx: QueryContext, analysis: Analysis, offset: number): Completion {
  const text = analysis.text
  const element = elementAt(analysis, offset)
  if (element) {
    if (element.nameStart <= offset && offset <= element.nameEnd && text[element.start] === '<' && text[element.start + 1] !== '/') {
      return tagNames(ctx, analysis, { start: element.nameStart, end: element.nameEnd }, text.slice(element.nameStart, offset))
    }
    if (offset > element.nameEnd) {
      const value = element.attributes.find((a) => a.value && a.value.contentStart <= offset && offset <= a.value.contentEnd)
      if (value) {
        if (!element.isml || value.name !== 'template' || !TEMPLATE_ATTRIBUTE_TAGS.has(element.name) || !value.value) return none(offset)
        const range = { start: value.value.contentStart, end: value.value.contentEnd }
        return templates(ctx, range, text.slice(range.start, offset))
      }
      if (!element.isml) return none(offset)
      const word = wordAround(text, offset, /[\w-]/)
      const known = element.custom ? (customTags(ctx, analysis).get(element.name)?.attributes ?? []) : (ISML_TAG_ATTRIBUTES[element.name] ?? [])
      const written = new Set(element.attributes.filter((a) => !(a.nameStart <= offset && offset <= a.nameEnd)).map((a) => a.name))
      const items = known.filter((name) => !written.has(name)).map((name): CompletionItem => ({ label: name, kind: 'tag-attribute', detail: element.name, id: `tag:${element.name}` }))
      return answer('tag-attribute', { start: word.start, end: word.end }, word.prefix, items)
    }
  }
  // `<` or `<is` not yet a tag the parser keeps.
  const word = wordAround(text, offset, /[\w-]/)
  if (text[word.start - 1] === '<') return tagNames(ctx, analysis, { start: word.start, end: word.end }, word.prefix)
  return none(offset)
}

function tagNames(ctx: QueryContext, analysis: Analysis, range: Range, prefix: string): Completion {
  const items: CompletionItem[] = ismlTags().map((name) => ({ label: name, kind: 'tag', detail: (ISML_TAG_ATTRIBUTES[name] ?? []).join(', ') || null, id: `tag:${name}` }))
  for (const [name, tag] of customTags(ctx, analysis)) {
    if (!ISML_TAG_ATTRIBUTES[name]) items.push({ label: name, kind: 'tag', detail: tag.template, id: `tag:${name}` })
  }
  return answer('tag', range, prefix, items.sort(byLabel))
}

function templates(ctx: QueryContext, range: Range, typed: string): Completion {
  const slash = typed.startsWith('/') ? '/' : ''
  const items: CompletionItem[] = []
  let last: CompletionItem | null = null
  for (const entry of ctx.index.templateList()) {
    if (last && last.label === slash + entry.name) {
      if (last.detail && !last.detail.split(', ').includes(entry.cartridge)) last.detail += `, ${entry.cartridge}`
      continue
    }
    last = { label: slash + entry.name, kind: 'template', detail: entry.cartridge, id: `template:${entry.name}` }
    items.push(last)
  }
  return answer('template', range, typed, items)
}

// ---------------------------------------------------------------------------------------------
// JavaScript

/** A string literal holding the offset, and the call it is an argument of. */
export type StringArgument = { literal: AST.Literal; content: Range; call: AST.CallExpression | AST.NewExpression | null; index: number; path: AST.Node[] }

export function stringArgumentAt(analysis: Analysis, root: Root, offset: number): StringArgument | null {
  const path = pathAt(root.node, offset)
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]
    if (node.type !== 'Literal' || node.kind !== 'string') continue
    const content = stringContent(analysis.text, node)
    if (offset < content.start || offset > content.end) return null
    const parent = path[i - 1]
    if (parent && (parent.type === 'CallExpression' || parent.type === 'NewExpression')) {
      const index = parent.arguments.indexOf(node)
      if (index !== -1) return { literal: node, content, call: parent, index, path }
    }
    return { literal: node, content, call: null, index: -1, path }
  }
  return null
}

/** What a call that takes a known string is. */
export type CallRole = 'resource' | 'template' | 'require' | 'route' | 'preference' | 'route-declaration' | null

/** Names a call the engine reads a string argument of: `Resource.msg`, `res.render`, `require`, `URLUtils.url`, … */
export function callRole(types: Types, call: AST.CallExpression | AST.NewExpression): CallRole {
  const callee = call.callee
  if (call.type === 'NewExpression') return callee.type === 'Identifier' && callee.name === 'Template' ? 'template' : null
  if (callee.type === 'Identifier') return callee.name === 'require' ? 'require' : null
  if (callee.type !== 'MemberExpression') return null
  const name = memberName(callee)
  const object = callee.object
  const objectName = object.type === 'Identifier' ? object.name : null
  if (name === 'msg' || name === 'msgf') {
    if (objectName === 'Resource') return 'resource'
    // `dw.web.Resource.msg`, or the class bound to another name.
    const type = object.type === 'Super' ? null : types.of(object)
    return type?.kind === 'class' && type.id === 'dw.web.Resource' ? 'resource' : null
  }
  if (name === 'render' && objectName === 'res') return 'template'
  if (name === 'renderTemplate' && objectName === 'ISML') return 'template'
  if (name === 'url' || name === 'http' || name === 'https' || name === 'abs') {
    if (objectName === 'URLUtils') return 'route'
    const type = object.type === 'Super' ? null : types.of(object)
    return type?.kind === 'class' && type.id === 'dw.web.URLUtils' ? 'route' : null
  }
  if (name === 'getCustomPreferenceValue') {
    const type = object.type === 'Super' ? null : types.of(object)
    return type?.kind === 'instance' && type.id === 'dw.system.Site' ? 'preference' : null
  }
  if (name === 'get' || name === 'post' || name === 'use' || name === 'append' || name === 'prepend' || name === 'replace') return 'route-declaration'
  return null
}

function completeScript(ctx: QueryContext, analysis: Analysis, root: Root, offset: number): Completion {
  const types = new Types({ ...ctx, analysis })
  const argument = stringArgumentAt(analysis, root, offset)
  if (argument) {
    if (!argument.call) return none(offset)
    const role = callRole(types, argument.call)
    const typed = analysis.text.slice(argument.content.start, offset)
    const range = argument.content
    if (role === 'resource' && argument.index === 0) return resourceKeys(ctx, argument.call, range, typed)
    if (role === 'resource' && argument.index === 1) return bundles(ctx, argument.call, range, typed)
    if (role === 'template' && argument.index === 0) return templates(ctx, range, typed)
    if (role === 'require' && argument.index === 0) return modules(ctx, analysis, range, typed)
    if (role === 'route' && argument.index === 0) return routes(ctx, range, typed)
    if (role === 'preference' && argument.index === 0) return attributes(ctx, SITE_PREFERENCES, range, typed, false)
    return none(offset)
  }
  return completeMember(ctx, analysis, root, types, offset)
}

function completeMember(ctx: QueryContext, analysis: Analysis, root: Root, types: Types, offset: number): Completion {
  const text = analysis.text
  const word = wordAround(text, offset)
  let dot = word.start - 1
  while (dot >= 0 && /\s/.test(text[dot])) dot--
  if (dot < 0 || text[dot] !== '.' || text[dot - 1] === '.') return none(offset)
  const path = pathAt(root.node, offset)
  let member: AST.MemberExpression | null = null
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]
    if (node.type === 'MemberExpression' && !node.computed && node.object.end <= dot && node.property.start > dot) {
      member = node
      break
    }
  }
  if (!member || member.object.type === 'Super') return none(offset)
  const range = { start: word.start, end: word.end }
  const object = types.of(member.object)
  if (object) return membersOf(ctx, object, range, word.prefix)
  // `name.custom.` of a name nothing types: the short list of names, and nothing else.
  const holder = member.object
  if (holder.type === 'MemberExpression' && memberName(holder) === 'custom' && holder.object.type === 'Identifier' && types.of(holder.object) === null) {
    const cls = guessedClass(holder.object.name)
    const typeId = cls ? metadataTypeOf(ctx.dw, cls) : null
    if (typeId) return attributes(ctx, typeId, range, word.prefix, true)
  }
  return none(offset)
}

function membersOf(ctx: QueryContext, object: QType, range: Range, prefix: string): Completion {
  const dw = ctx.dw
  switch (object.kind) {
    case 'custom':
      return attributes(ctx, object.typeId, range, prefix, false)
    case 'package': {
      if (!dw) break
      const items: CompletionItem[] = subPackages(dw, object.name).map((name) => ({ label: name.slice(object.name.length + 1), kind: 'package', detail: name, id: `dwpackage:${name}` }))
      for (const cls of dw.packageClasses(object.name)) items.push({ label: cls.name, kind: 'class', detail: cls.id, id: `dwclass:${cls.id}`, ...(cls.deprecated ? { deprecated: true as const } : {}) })
      items.sort(byLabel)
      return answer('member', range, prefix, items)
    }
    case 'class':
    case 'instance': {
      const cls = dw?.findClass(object.id)
      if (!dw || !cls) break
      return answer('member', range, prefix, dwItems(dw, cls, membersFor(dw, cls, object.kind === 'class')))
    }
    case 'module': {
      const seen = new Set<string>()
      const items: CompletionItem[] = []
      for (const definition of moduleMembers(ctx, object.from, object.module)) {
        const member = definition.member
        if (seen.has(member.name)) continue
        seen.add(member.name)
        items.push({
          label: member.name,
          kind: member.kind === 'function' ? 'function' : 'value',
          detail: member.params ? `${member.name}(${member.params.join(', ')})` : null,
          id: `member:${definition.path}#${member.name}`
        })
      }
      items.sort(byLabel)
      return answer('member', range, prefix, items)
    }
  }
  return { ...none(range.start), range }
}

const byLabel = (a: CompletionItem, b: CompletionItem) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)

/** One item per name: overloads together, the signature of the first in the detail. */
export function dwItems(dw: DwIndex, cls: DwClass, members: readonly DwMember[]): CompletionItem[] {
  const byName = new Map<string, DwMember[]>()
  for (const member of members) {
    const list = byName.get(member.name)
    if (list) list.push(member)
    else byName.set(member.name, [member])
  }
  const items: CompletionItem[] = []
  for (const [name, list] of byName) {
    const first = list.find((member) => !member.deprecated) ?? list[0]
    const more = list.length > 1 ? ` (+${list.length - 1})` : ''
    const item: CompletionItem = { label: name, kind: first.kind === 'method' ? 'method' : first.kind === 'constant' ? 'constant' : 'property', detail: signature(first) + more, id: `dw:${first.owner}#${first.key}` }
    if (list.every((member) => member.deprecated) || dw.isDeprecated(cls, undefined)) item.deprecated = true
    items.push(item)
  }
  // Deprecated ones last.
  return items.sort((a, b) => Number(!!a.deprecated) - Number(!!b.deprecated) || byLabel(a, b))
}

function attributes(ctx: QueryContext, typeId: string, range: Range, prefix: string, guessed: boolean): Completion {
  const preference = typeId === SITE_PREFERENCES
  const items = ctx.index
    .attributes(typeId)
    .map((attribute): CompletionItem => ({ label: attribute.id, kind: preference ? 'site-preference' : 'custom-attribute', detail: attribute.type, id: `custom:${typeId}#${attribute.id}` }))
    .sort(byLabel)
  return answer(preference ? 'site-preference' : 'custom', range, prefix, items, guessed)
}

/** A literal argument of a call, or null. */
function literalArgument(call: AST.CallExpression | AST.NewExpression, index: number): string | null {
  const argument = call.arguments[index]
  return argument && argument.type === 'Literal' && argument.kind === 'string' ? (argument.value as string) : null
}

/** A value of a bundle, cut for a detail. */
function shortValue(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

function resourceKeys(ctx: QueryContext, call: AST.CallExpression | AST.NewExpression, range: Range, typed: string): Completion {
  const bundle = literalArgument(call, 1)
  const items: CompletionItem[] = []
  if (bundle !== null) {
    // The default locale's value first, else any locale's.
    const byKey = new Map<string, { value: string; exact: boolean }>()
    for (const key of ctx.index.resourceKeys(bundle)) {
      const exact = key.bundle === bundle
      const known = byKey.get(key.key)
      if (!known || (exact && !known.exact)) byKey.set(key.key, { value: key.value, exact })
    }
    for (const [key, { value }] of [...byKey].sort(([a], [b]) => (a < b ? -1 : 1))) items.push({ label: key, kind: 'resource-key', detail: shortValue(value), id: `key:${bundle}#${key}` })
  } else {
    // No bundle written yet: every key, with the bundles that define it.
    for (const [key, definitions] of [...ctx.index.keyNames()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const names = [...new Set(definitions.map((definition) => definition.bundle.replace(/_[a-z]{2}(_[A-Z]{2})?$/, '')))]
      items.push({ label: key, kind: 'resource-key', detail: names.join(', '), id: `key:${names[0] ?? 'locale'}#${key}` })
    }
  }
  return answer('resource-key', range, typed, items)
}

function bundles(ctx: QueryContext, call: AST.CallExpression | AST.NewExpression, range: Range, typed: string): Completion {
  const key = literalArgument(call, 0)
  const holding = new Set((key === null ? [] : (ctx.index.keyNames().get(key) ?? [])).map((definition) => definition.bundle.replace(/_[a-z]{2}(_[A-Z]{2})?$/, '')))
  const names = [...ctx.index.bundleNames()]
  // The bundles that define the key written first.
  names.sort((a, b) => Number(!holding.has(a)) - Number(!holding.has(b)) || (a < b ? -1 : 1))
  return answer('bundle', range, typed, names.map((name) => ({ label: name, kind: 'bundle', detail: holding.has(name) ? key : null, id: `bundle:${name}` })))
}

function modules(ctx: QueryContext, analysis: Analysis, range: Range, typed: string): Completion {
  const items: CompletionItem[] = []
  if (typed.startsWith('dw/') || (typed.length > 0 && 'dw/'.startsWith(typed))) {
    const dw = ctx.dw
    if (dw) {
      const packages = new Set<string>()
      for (const cls of dw.classes()) {
        if (!cls.package.startsWith('dw.')) continue
        packages.add(cls.package)
        items.push({ label: cls.id.replace(/\./g, '/'), kind: 'class', detail: cls.id, id: `dwclass:${cls.id}` })
      }
      for (const name of packages) items.push({ label: name.replace(/\./g, '/'), kind: 'package', detail: name, id: `dwpackage:${name}` })
      items.sort(byLabel)
    }
    return answer('module', range, typed, items)
  }
  const own = ctx.index.cartridgeOf(analysis.path)
  // `*/…` on every path, `~/…` in the file's own cartridge; else a cartridge named
  // (`app_x/cartridge/…`) or a bare name of the `modules` folder (`server`).
  const form = typed === '' || typed.startsWith('*') ? 'path' : typed.startsWith('~') ? 'current' : typed.startsWith('.') ? null : 'named'
  if (form === null) return answer('module', range, typed, [])
  let last: CompletionItem | null = null
  for (const entry of ctx.index.scriptList()) {
    if (form !== 'named' && entry.kind !== 'cartridge') continue
    if (form === 'current' && entry.cartridge !== own?.name) continue
    const label = form === 'path' ? `*/${entry.module}` : form === 'current' ? `~/${entry.module}` : entry.kind === 'modules' ? entry.module : `${entry.cartridge}/${entry.module}`
    if (last && last.label === label) {
      if (last.detail && !last.detail.split(', ').includes(entry.cartridge)) last.detail += `, ${entry.cartridge}`
      continue
    }
    last = { label, kind: 'module', detail: entry.cartridge, id: form === 'path' ? `module:*/${entry.module}` : `module:${label}` }
    items.push(last)
  }
  // Named forms come in cartridge order; the list reads by label.
  if (form === 'named') items.sort(byLabel)
  return answer('module', range, typed, items)
}

function routes(ctx: QueryContext, range: Range, typed: string): Completion {
  const ids = new Map<string, string[]>()
  for (const storefront of ctx.index.storefronts()) {
    for (const id of ctx.index.routeIds(storefront.id)) {
      const list = ids.get(id)
      if (list) list.push(storefront.id)
      else ids.set(id, [storefront.id])
    }
  }
  const items = [...ids].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, storefronts]): CompletionItem => ({ label: id, kind: 'route', detail: storefronts.join(', '), id: `route:${id}` }))
  return answer('route', range, typed, items)
}
