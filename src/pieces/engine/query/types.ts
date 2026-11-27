// The type of an expression, as far as the engine can tell without guessing: a `dw.*` class (an
// instance of it, or the class itself), a `dw` package, a method of a class before its call, a
// cartridge module and its members, or the custom attributes of an object. Anything else is
// unknown (null): a type is never guessed from a name here (completion guesses `x.custom` alone,
// and says so).
//
// Where a type comes from, in this order: the declaration's initialiser (`new dw.x.Y()`,
// `require('dw/x/Y')`, a call whose method the `dw.*` index gives a return type), a `@type` or
// `@param` JSDoc tag, the platform's globals (`request`, `session`, `customer`; `pdict` is
// unknown), and the previous call's return type in a chain. One variable, one type: a variable
// assigned two different types, or assigned something unknown, is unknown (a JSDoc tag that agrees
// with every known assignment settles the unknown ones). Pure: no Node, no Orca.
import type * as AST from '../js/ast'
import type { Declaration } from '../js/facts'
import type { DwClass, DwIndex, DwMember } from '../dw/index'
import type { Analysis } from './analysis'
import { moduleMember, SUPER_MODULE, type QueryContext } from './modules'

export type QType =
  /** An instance of a `dw.*` class (`TopLevel.String` too); `objectType` names a custom object's type. */
  | { kind: 'instance'; id: string; objectType?: string }
  /** The class itself: its static members, `new`. */
  | { kind: 'class'; id: string }
  /** `dw`, `dw.catalog`: what is below it. */
  | { kind: 'package'; name: string }
  /** A method of a class, before it is called; `static` when read off the class. */
  | { kind: 'method'; owner: string; name: string; static: boolean }
  /** A cartridge module, as `require(module)` from the file `from` names it. */
  | { kind: 'module'; module: string; from: string }
  /** A member of a cartridge module. */
  | { kind: 'member'; module: string; from: string; name: string }
  /** `x.custom`: the custom attributes of the metadata's object type `typeId`. */
  | { kind: 'custom'; typeId: string }
  /** A value project code builds (a module's call or construction): never a `dw.*` type, never guessed. */
  | { kind: 'project' }

export type TypeContext = QueryContext & { analysis: Analysis }

/** How deep an expression is followed: deeper, its type is unknown. */
export const MAX_TYPE_DEPTH = 64

const EXTENSIBLE = 'dw.object.ExtensibleObject'
const SELF = Symbol('self')
type Found = QType | null | typeof SELF

/** Two types are the same type. */
export function sameType(a: QType, b: QType): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'instance':
      return a.id === (b as typeof a).id && a.objectType === (b as typeof a).objectType
    case 'class':
      return a.id === (b as typeof a).id
    case 'package':
      return a.name === (b as typeof a).name
    case 'method':
      return a.owner === (b as typeof a).owner && a.name === (b as typeof a).name && a.static === (b as typeof a).static
    case 'module':
      return a.module === (b as typeof a).module && a.from === (b as typeof a).from
    case 'member':
      return a.module === (b as typeof a).module && a.from === (b as typeof a).from && a.name === (b as typeof a).name
    case 'custom':
      return a.typeId === (b as typeof a).typeId
    case 'project':
      return true
  }
}

/** A type as the `dw.*` index writes it, as an instance: null for `void`, `Object` (anything) and what the index lacks. */
export function instanceOf(dw: DwIndex | null, type: string | undefined): QType | null {
  if (!dw || !type || type === 'void' || type === 'TopLevel.Object') return null
  if (type.endsWith('[]')) return dw.findClass('TopLevel.Array') ? { kind: 'instance', id: 'TopLevel.Array' } : null
  const cls = dw.findClass(type)
  return cls && cls.id === type ? { kind: 'instance', id: cls.id } : null
}

/** Whether a class is, or extends, `ExtensibleObject`: it has custom attributes. */
export function isExtensible(dw: DwIndex | null, id: string): boolean {
  if (!dw) return false
  const seen = new Set<string>()
  for (let cls = dw.findClass(id); cls && !seen.has(cls.id); cls = cls.super ? dw.findClass(cls.super) : null) {
    if (cls.id === EXTENSIBLE) return true
    seen.add(cls.id)
  }
  return false
}

/** The metadata's object type of a class's custom attributes (`Product` for `dw.catalog.Product`); null when it has none. */
export function metadataTypeOf(dw: DwIndex | null, id: string, objectType?: string): string | null {
  if (!isExtensible(dw, id)) return null
  if (id === 'dw.object.CustomObject') return objectType ?? null
  // A variant or a variation group is a product to the metadata.
  if (id === 'dw.catalog.Variant' || id === 'dw.catalog.VariationGroup') return 'Product'
  return id.slice(id.lastIndexOf('.') + 1)
}

/**
 * A name, for `name.custom` alone, and only when nothing else says what it is: the class it
 * usually names in SFCC code. A short list on purpose: a name not in it gives nothing. `customer`
 * names a `dw.customer.Customer`, which has no custom attributes (they are its `profile`'s).
 */
export const GUESSED_NAMES: Readonly<Record<string, string>> = {
  product: 'dw.catalog.Product',
  apiproduct: 'dw.catalog.Product',
  masterproduct: 'dw.catalog.Product',
  variant: 'dw.catalog.Product',
  order: 'dw.order.Order',
  apiorder: 'dw.order.Order',
  basket: 'dw.order.Basket',
  currentbasket: 'dw.order.Basket',
  apibasket: 'dw.order.Basket',
  lineitem: 'dw.order.ProductLineItem',
  productlineitem: 'dw.order.ProductLineItem',
  pli: 'dw.order.ProductLineItem',
  shipment: 'dw.order.Shipment',
  defaultshipment: 'dw.order.Shipment',
  category: 'dw.catalog.Category',
  apicategory: 'dw.catalog.Category',
  content: 'dw.content.Content',
  apicontent: 'dw.content.Content',
  profile: 'dw.customer.Profile',
  customer: 'dw.customer.Customer',
  store: 'dw.catalog.Store',
  campaign: 'dw.campaign.Campaign',
  promotion: 'dw.campaign.Promotion'
}

/** The class a name usually names, from `GUESSED_NAMES`; null for any other name. */
export function guessedClass(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(GUESSED_NAMES, name.toLowerCase()) ? GUESSED_NAMES[name.toLowerCase()] : null
}

/** The globals of a script; a template also sees the classes ISML imports for it. */
const TEMPLATE_CLASSES: Readonly<Record<string, string>> = { Resource: 'dw.web.Resource', URLUtils: 'dw.web.URLUtils', StringUtils: 'dw.util.StringUtils' }

/** The type a JSDoc type expression names: a `dw.*` class or a top-level one, `Type<…>` read as `Type`; null for anything else. */
export function jsdocType(dw: DwIndex | null, written: string): QType | null {
  if (!dw) return null
  let type = written.trim().replace(/^[?!]/, '').replace(/=$/, '')
  // `A|null`, `A|undefined`: A. Any other union is no one type.
  const parts = type.split('|').map((part) => part.trim()).filter((part) => part !== 'null' && part !== 'undefined')
  if (parts.length !== 1) return null
  type = parts[0].replace(/^\((.*)\)$/, '$1').replace(/<.*>$/, '').replace(/\.$/, '')
  if (/\[\]$/.test(type) || /^Array$/i.test(type)) return instanceOf(dw, 'TopLevel.Array')
  const primitive: Record<string, string> = { string: 'TopLevel.String', number: 'TopLevel.Number', boolean: 'TopLevel.Boolean' }
  if (primitive[type]) return instanceOf(dw, primitive[type])
  if (type.startsWith('dw.')) return instanceOf(dw, type)
  // A bare name may be a project's own type: only a top-level class of the platform counts.
  if (/^[A-Z]\w*$/.test(type)) return instanceOf(dw, `TopLevel.${type}`)
  return null
}

/** The `{Type}` of a JSDoc tag: `@type {T}`, or `@param {T} name` (also `[name]`, `[name=x]`). */
export function docTag(doc: string, tag: 'type' | 'param' | 'returns', name?: string): string | null {
  const lines = doc.split(/\r\n?|\n/)
  for (const line of lines) {
    const match = /@(type|param|arg|argument|returns?)\s*\{([^}]*)\}\s*(\[?\s*[\w$.]+)?/.exec(line)
    if (!match) continue
    const found = match[1] === 'arg' || match[1] === 'argument' ? 'param' : match[1] === 'return' ? 'returns' : match[1]
    if (found !== tag) continue
    if (tag === 'param' && (match[3] ?? '').replace(/^\[\s*/, '') !== name) continue
    return match[2]
  }
  return null
}

/** Resolves expression types for one file; declarations are computed once each. */
export class Types {
  private readonly ctx: TypeContext
  private readonly memo = new Map<number, QType | null>()
  private readonly visiting = new Set<number>()

  constructor(ctx: TypeContext) {
    this.ctx = ctx
  }

  private get dw(): DwIndex | null {
    return this.ctx.dw
  }

  /** The file's path, relative to the workspace. */
  path(): string {
    return this.ctx.analysis.path
  }

  /** The type of an expression; null when unknown. */
  of(node: AST.Expression | AST.Super | AST.Pattern, depth = 0): QType | null {
    const found = this.find(node, depth)
    return found === SELF ? null : found
  }

  /** The declaration's type: its values, else its JSDoc; one variable, one type. */
  declaration(declaration: Declaration): QType | null {
    const found = this.declared(declaration, 0)
    return found === SELF ? null : found
  }

  /** Every declaration of the binding a declaration belongs to (one, unless a name is declared again in its function). */
  private binding(declaration: Declaration): Declaration[] {
    return this.ctx.analysis.bindings.get(declaration.id) ?? [declaration]
  }

  private declared(declaration: Declaration, depth: number): Found {
    const binding = this.binding(declaration)
    // One binding, one memo: its first declaration's id.
    const key = binding[0].id
    const memo = this.memo.get(key)
    if (memo !== undefined) return memo
    if (this.visiting.has(key)) return SELF
    this.visiting.add(key)
    let result: QType | null
    try {
      result = this.compute(binding, depth)
    } finally {
      this.visiting.delete(key)
    }
    this.memo.set(key, result)
    return result
  }

  /**
   * A binding's type. Every declaration and assignment of it counts: when they disagree, or one is
   * unknown, it is unknown (a JSDoc tag that agrees with every known value settles the unknown
   * ones). A parameter's value is the caller's: only its `@param` gives it a type.
   */
  private compute(binding: readonly Declaration[], depth: number): QType | null {
    const analysis = this.ctx.analysis
    const first = binding[0]
    const required = analysis.requiredMembers.get(first.id)
    if (required && binding.length === 1) return analysis.rewritten.has(first.id) || analysis.assigned.has(first.id) ? null : this.requireType(required.module, required.key)
    const values: AST.Expression[] = []
    let parameter = false
    for (const declaration of binding) {
      if (declaration.kind === 'function' || declaration.kind === 'class' || declaration.kind === 'catch' || declaration.kind === 'isloop' || declaration.kind === 'isset') return null
      if (analysis.requiredMembers.has(declaration.id) || analysis.rewritten.has(declaration.id)) return null
      if (declaration.kind === 'param') parameter = true
      else {
        // Inside a pattern (`var { a } = obj`), the initialiser is not this name's value.
        if (!analysis.plain.has(declaration.id)) return null
        const init = declaration.init
        if (init && init.type !== 'FunctionDeclaration' && init.type !== 'ClassDeclaration') values.push(init)
      }
      values.push(...(analysis.assigned.get(declaration.id) ?? []))
    }
    let documented: QType | null = null
    for (const declaration of binding) {
      const type = this.documented(declaration)
      if (!type) continue
      if (documented && !sameType(documented, type)) return null
      documented = type
    }
    // An undocumented parameter is whatever the caller passes.
    if (parameter && !documented) return null
    let known: QType | null = null
    let unknown = parameter
    for (const value of values) {
      if (isNothing(value)) continue
      const type = this.find(value, depth + 1)
      if (type === SELF) continue
      if (type === null) {
        unknown = true
        continue
      }
      if (known && !sameType(known, type)) return null
      known = type
    }
    // A JSDoc tag that says another type than the values: in doubt.
    if (known && documented && !sameType(known, documented)) return null
    if (known && !unknown) return known
    return documented
  }

  /** Whether a name is the global one: declared nowhere in the file. */
  isGlobal(node: AST.Identifier): boolean {
    const reference = this.ctx.analysis.references.get(node.start)
    return !reference || reference.declaration === null
  }

  /**
   * Whether a name says nothing of what it holds, so its name may be guessed from (`name.custom`
   * alone): a global, a parameter, or a variable whose every value is read from elsewhere (a call,
   * a member, another name). One that holds a literal, an object, a function or a `new` is not.
   */
  guessable(node: AST.Identifier): boolean {
    const id = this.ctx.analysis.references.get(node.start)?.declaration
    const declaration = id === null || id === undefined ? undefined : this.ctx.analysis.facts.declarations[id]
    if (!declaration) return true
    const read = (value: AST.Expression) => isNothing(value) || value.type === 'CallExpression' || value.type === 'MemberExpression' || value.type === 'Identifier' || value.type === 'LogicalExpression' || value.type === 'ConditionalExpression'
    for (const each of this.binding(declaration)) {
      if (each.kind === 'function' || each.kind === 'class') return false
      const init = each.kind === 'param' ? null : each.init
      if (init && (init.type === 'FunctionDeclaration' || init.type === 'ClassDeclaration' || !read(init))) return false
      if ((this.ctx.analysis.assigned.get(each.id) ?? []).some((value) => !read(value))) return false
    }
    return true
  }

  /** The type a JSDoc tag gives a declaration: `@type` on its statement, `@param` on its function. */
  private documented(declaration: Declaration): QType | null {
    if (declaration.kind === 'param') {
      const doc = this.ctx.analysis.paramDocs.get(declaration.id)
      const written = doc ? docTag(doc.text, 'param', declaration.name) : null
      return written === null ? null : jsdocType(this.dw, written)
    }
    const written = declaration.doc ? docTag(declaration.doc.text, 'type') : null
    return written === null ? null : jsdocType(this.dw, written)
  }

  private find(node: AST.Expression | AST.Super | AST.Pattern, depth: number): Found {
    if (depth > MAX_TYPE_DEPTH) return null
    switch (node.type) {
      case 'Identifier': {
        // Inside `with (o) { … }`, a name may be a property of `o`.
        if (this.ctx.analysis.withBodies.some((body) => body.start <= node.start && node.end <= body.end)) return null
        const reference = this.ctx.analysis.references.get(node.start)
        if (reference && reference.declaration !== null) {
          const declaration = this.ctx.analysis.facts.declarations[reference.declaration]
          return declaration ? this.declared(declaration, depth) : null
        }
        // A name declared nowhere, or the name of a declaration itself.
        const declared = this.ctx.analysis.declarations.get(node.start)
        if (declared && declared.name === node.name) return this.declared(declared, depth)
        return this.global(node.name)
      }
      case 'Literal':
        if (node.kind === 'string') return instanceOf(this.dw, 'TopLevel.String')
        if (node.kind === 'number') return instanceOf(this.dw, 'TopLevel.Number')
        if (node.kind === 'boolean') return instanceOf(this.dw, 'TopLevel.Boolean')
        if (node.kind === 'regex') return instanceOf(this.dw, 'TopLevel.RegExp')
        return null
      case 'TemplateLiteral':
        return instanceOf(this.dw, 'TopLevel.String')
      case 'ArrayExpression':
        return instanceOf(this.dw, 'TopLevel.Array')
      case 'UnaryExpression':
        if (node.operator === 'typeof') return instanceOf(this.dw, 'TopLevel.String')
        if (node.operator === '!') return instanceOf(this.dw, 'TopLevel.Boolean')
        return null
      case 'BinaryExpression':
        if (/^(==|!=|===|!==|<|>|<=|>=|instanceof|in)$/.test(node.operator)) return instanceOf(this.dw, 'TopLevel.Boolean')
        if (/^(-|\*|\/|%|\*\*|<<|>>|>>>|&|\||\^)$/.test(node.operator)) return instanceOf(this.dw, 'TopLevel.Number')
        return null
      case 'AssignmentExpression':
        return node.operator === '=' ? this.find(node.right, depth + 1) : null
      case 'SequenceExpression':
        return node.expressions.length ? this.find(node.expressions[node.expressions.length - 1], depth + 1) : null
      case 'ConditionalExpression':
        return this.agree([node.consequent, node.alternate], depth)
      case 'LogicalExpression':
        // `a || b`, `a ?? b`: either; `a && b` may be `a`, falsy.
        return node.operator === '&&' ? null : this.agree([node.left, node.right], depth)
      case 'MemberExpression':
        return this.member(node, depth)
      case 'CallExpression':
        return this.call(node, depth)
      case 'NewExpression': {
        const callee = this.find(node.callee, depth + 1)
        if (callee === SELF || callee === null) return callee
        if (callee.kind === 'class') return { kind: 'instance', id: callee.id }
        if (callee.kind === 'module' || callee.kind === 'member') return { kind: 'project' }
        return null
      }
    }
    return null
  }

  /** The type every one of the values has, `null` and `undefined` aside; null when they differ. */
  private agree(values: AST.Expression[], depth: number): Found {
    let known: QType | null = null
    let self = false
    for (const value of values) {
      if (isNothing(value)) continue
      const type = this.find(value, depth + 1)
      if (type === SELF) {
        self = true
        continue
      }
      if (type === null) return null
      if (known && !sameType(known, type)) return null
      known = type
    }
    return known ?? (self ? SELF : null)
  }

  /** A name declared nowhere in the file. */
  global(name: string): QType | null {
    const dw = this.dw
    if (!dw) return null
    if (name === 'dw') return { kind: 'package', name: 'dw' }
    if (name === 'pdict' || name === 'global' || name === 'globalThis') return null
    if (this.ctx.analysis.kind === 'template' && TEMPLATE_CLASSES[name]) return dw.findClass(TEMPLATE_CLASSES[name]) ? { kind: 'class', id: TEMPLATE_CLASSES[name] } : null
    const global = dw.findClass('TopLevel.global')
    if (global) {
      const members = dw.member(global, name)
      const property = members.find((member) => member.kind === 'property')
      if (property && (name === 'request' || name === 'session' || name === 'customer' || name === 'response')) return instanceOf(dw, property.type)
      if (members.some((member) => member.kind === 'method')) return { kind: 'method', owner: 'TopLevel.global', name, static: true }
    }
    const top = dw.findClass(`TopLevel.${name}`)
    return top && top.id !== 'TopLevel.global' ? { kind: 'class', id: top.id } : null
  }

  private member(node: AST.MemberExpression, depth: number): Found {
    const name = memberName(node)
    if (name === null) return null
    // `module.superModule`, `module` the global one: the next copy of this file.
    if (name === 'superModule' && node.object.type === 'Identifier' && node.object.name === 'module' && !this.ctx.analysis.references.get(node.object.start)?.declaration) {
      return this.ctx.analysis.kind === 'script' ? { kind: 'module', module: SUPER_MODULE, from: this.ctx.analysis.path } : null
    }
    const object = this.find(node.object, depth + 1)
    if (object === SELF || object === null) return object
    return this.memberOf(object, name)
  }

  /** The type of `name` read off a value of type `object`. */
  memberOf(object: QType, name: string): QType | null {
    const dw = this.dw
    switch (object.kind) {
      case 'package': {
        if (!dw) return null
        const qualified = `${object.name}.${name}`
        const cls = dw.findClass(qualified)
        if (cls && cls.id === qualified) return { kind: 'class', id: qualified }
        return hasPackage(dw, qualified) ? { kind: 'package', name: qualified } : null
      }
      case 'class':
      case 'instance': {
        const cls = dw?.findClass(object.id)
        if (!dw || !cls) return null
        if (object.kind === 'instance' && name === 'custom') {
          const typeId = metadataTypeOf(dw, cls.id, object.objectType)
          return typeId ? { kind: 'custom', typeId } : null
        }
        const members = membersFor(dw, cls, object.kind === 'class').filter((member) => member.name === name)
        const field = members.find((member) => member.kind === 'property' || member.kind === 'constant')
        if (field) return instanceOf(dw, field.type)
        if (members.some((member) => member.kind === 'method')) return { kind: 'method', owner: cls.id, name, static: object.kind === 'class' }
        return null
      }
      case 'module':
        return { kind: 'member', module: object.module, from: object.from, name }
      default:
        return null
    }
  }

  private call(node: AST.CallExpression, depth: number): Found {
    const callee = node.callee
    if (callee.type === 'Identifier' && callee.name === 'require' && !this.ctx.analysis.references.get(callee.start)?.declaration) {
      const first = node.arguments[0]
      if (!first || first.type !== 'Literal' || first.kind !== 'string') return null
      return this.requireType(first.value as string, null)
    }
    const type = this.find(callee, depth + 1)
    if (type === SELF || type === null) return type
    if (type.kind === 'method') return this.returns(type, node)
    if (type.kind === 'member') return this.memberReturns(type)
    if (type.kind === 'module') return { kind: 'project' }
    return null
  }

  /** What `require(module)` gives in this file; `key`, a member of it (a pattern's). */
  requireType(module: string, key: string | null): QType | null {
    if (module.startsWith('dw/')) {
      const dw = this.dw
      if (!dw) return null
      const id = module.replace(/\//g, '.')
      const cls = dw.findClass(id)
      const base: QType | null = cls && cls.id === id ? { kind: 'class', id } : hasPackage(dw, id) ? { kind: 'package', name: id } : null
      return base && key !== null ? this.memberOf(base, key) : base
    }
    const base: QType = { kind: 'module', module, from: this.ctx.analysis.path }
    return key === null ? base : this.memberOf(base, key)
  }

  /** A `dw.*` method's return type, chosen among its overloads by the number of arguments; null when they disagree. */
  private returns(method: Extract<QType, { kind: 'method' }>, call: AST.CallExpression): QType | null {
    const dw = this.dw
    const cls = dw?.findClass(method.owner)
    if (!dw || !cls) return null
    // A custom object read or made by its type's id: that type's attributes.
    if (cls.id === 'dw.object.CustomObjectMgr' && (method.name === 'getCustomObject' || method.name === 'createCustomObject')) {
      const first = call.arguments[0]
      if (first && first.type === 'Literal' && first.kind === 'string') return { kind: 'instance', id: 'dw.object.CustomObject', objectType: first.value as string }
    }
    const overloads = membersFor(dw, cls, method.static).filter((member) => member.kind === 'method' && member.name === method.name)
    const count = call.arguments.length
    const fitting = overloads.filter((member) => {
      const params = member.params ?? []
      return params.some((param) => param.rest) ? count >= params.length - 1 : params.length === count
    })
    const chosen = fitting.length > 0 ? fitting : overloads
    const returns = new Set(chosen.map((member) => member.returns ?? 'void'))
    return returns.size === 1 ? instanceOf(dw, [...returns][0]) : null
  }

  /** A module function's return type, from the `@returns` of its JSDoc, when every copy agrees. */
  private memberReturns(member: Extract<QType, { kind: 'member' }>): QType | null {
    const found = moduleMember(this.ctx, member.from, member.module, member.name)
    if (found.length === 0) return { kind: 'project' }
    let known: QType | null = null
    for (const definition of found) {
      const written = definition.member.doc ? docTag(definition.member.doc, 'returns') : null
      const type = written === null ? null : jsdocType(this.dw, written)
      if (!type) return { kind: 'project' }
      if (known && !sameType(known, type)) return { kind: 'project' }
      known = type
    }
    return known
  }
}

/**
 * Whether a property is a constant the committed index lists as a property (`Status.ERROR`): an
 * upper-case name with no getter. `Product.ID` has `getID()`, so it is an instance's.
 */
export function isListedConstant(all: readonly DwMember[], member: DwMember): boolean {
  if (member.kind !== 'property' || !/^[A-Z][A-Z0-9_]*$/.test(member.name)) return false
  return !all.some((each) => each.kind === 'method' && (each.name === `get${member.name}` || each.name === `is${member.name}`))
}

/**
 * Whether a member is read off the class. The committed index marks no property static (its
 * pages do not say it in a form the generator reads), so a property counts as static when its
 * getter is: `Site.current` with `static getCurrent()`.
 */
export function isStaticMember(all: readonly DwMember[], member: DwMember): boolean {
  if (member.static || member.kind === 'constant') return true
  if (member.kind !== 'property') return false
  const capital = member.name.charAt(0).toUpperCase() + member.name.slice(1)
  return all.some((each) => each.kind === 'method' && each.static && (each.params ?? []).length === 0 && (each.name === `get${capital}` || each.name === `is${capital}`))
}

/**
 * The members a value reaches: a class's static ones and its constants (`Object`'s own static
 * functions aside: `ProductMgr.assign` is not one), an instance's others and the constants.
 */
export function membersFor(dw: DwIndex, cls: DwClass, ofClass: boolean): DwMember[] {
  const all = dw.members(cls)
  return all.filter((member) => {
    if (member.kind === 'constructor') return false
    if (member.kind === 'constant' || isListedConstant(all, member)) return true
    const isStatic = isStaticMember(all, member)
    if (!ofClass) return !isStatic
    return isStatic && (member.owner === cls.id || member.owner !== 'TopLevel.Object')
  })
}

/** Whether the `dw.*` index has a package of that name, or below it. */
export function hasPackage(dw: DwIndex, name: string): boolean {
  if (dw.packageClasses(name).length > 0) return true
  return subPackages(dw, name).length > 0
}

/** The packages right below a package (`dw.catalog` below `dw`). */
export function subPackages(dw: DwIndex, name: string): string[] {
  const found = new Set<string>()
  const prefix = `${name}.`
  for (const cls of dw.classes()) {
    if (!cls.package.startsWith(prefix)) continue
    const rest = cls.package.slice(prefix.length)
    found.add(prefix + rest.split('.')[0])
  }
  return [...found].sort()
}

/** A member expression's name: `a.b`, or `a['b']`; null when computed otherwise. */
export function memberName(node: AST.MemberExpression): string | null {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && node.property.type === 'Literal' && node.property.kind === 'string') return node.property.value as string
  return null
}

/** `null` or `undefined`: a value that says nothing of a variable's type. */
function isNothing(node: AST.Expression): boolean {
  return (node.type === 'Literal' && node.kind === 'null') || (node.type === 'Identifier' && node.name === 'undefined')
}
