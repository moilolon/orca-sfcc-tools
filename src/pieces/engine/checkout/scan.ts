// What the checkout index keeps of one script or template: its `require` calls, the templates and
// resource keys it names, `module.superModule`, and for a controller its SFRA route declarations.
// The tree itself is dropped once these are taken. Positions are offsets of the file's text.
// Pure: no Node, no Orca.
import type * as AST from '../js/ast'
import { walk, type Node } from '../js/ast'
import { scriptFacts, type Declaration, type Reference, type ScriptFacts, type ValueFacts } from '../js/facts'
import { parseScript } from '../js/parser'
import { templateScript } from '../isml/embedded'
import { attribute, parseTemplate, walkTemplate } from '../isml/parser'
import { lineAt, lineStarts } from './files'

/** A file larger than this is listed but not parsed (a bundled library, a generated file). */
export const MAX_PARSED_CHARACTERS = 2_000_000

/** The longest JSDoc kept per exported member: the rest is cut, so a file's record stays small. */
export const MAX_DOC_CHARACTERS = 600

/** At most this many exported members are kept per script. */
export const MAX_EXPORTED_MEMBERS = 500

export type RequireUse = {
  module: string
  /** The range of the argument, quotes included. */
  start: number
  end: number
}

export type TemplateVia = 'render' | 'renderTemplate' | 'Template' | 'isinclude' | 'isdecorate' | 'ismodule'

export type TemplateUse = {
  /** The template's name as written (`product/productDetails`). */
  name: string
  via: TemplateVia
  /** The range of the name, quotes excluded. */
  start: number
  end: number
}

export type ResourceUse = {
  method: 'msg' | 'msgf'
  key: string
  /** The bundle, when written as a literal; `null` for the default bundle (`locale`). */
  bundle: string | null
  /** The range of the key, quotes excluded. */
  start: number
  end: number
}

export type RouteMethod = 'get' | 'post' | 'use' | 'append' | 'prepend' | 'replace'

export const DEFINING_METHODS: ReadonlySet<RouteMethod> = new Set(['get', 'post', 'use'])
const ROUTE_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'use', 'append', 'prepend', 'replace'])

export type RouteOperation = {
  method: RouteMethod
  /** The route's name (`Show`). */
  name: string
  /** The range of the name, quotes excluded. */
  nameStart: number
  nameEnd: number
  /** The whole call. */
  start: number
  end: number
  /** 1-based, of the call. */
  line: number
  /** How many middleware functions the call passes after the name. */
  middleware: number
}

/** What a controller extends: `server.extend(module.superModule)` or `server.extend(require('…'))`. */
export type ControllerBase = { kind: 'superModule' } | { kind: 'require'; module: string }

export type ControllerFacts = {
  /** Route declarations in source order. */
  operations: RouteOperation[]
  extends: ControllerBase | null
  /** `module.exports = server.exports()`. */
  exported: boolean
}

/** A member of a module a file reads: the module as written (or `SUPER_MODULE`), the member, the range of its name. */
export type MemberUse = { module: string; member: string; start: number; end: number; line: number }

/** Where something is written in a file: the range of its name, and its 1-based line. */
export type Place = { start: number; end: number; line: number }

/** A member a script exports (`module.exports = { price: price }`, `exports.price = …`, `base.price = …`). */
export type ExportedMember = Place & {
  name: string
  /** `function` when its value is a function written or declared in the file. */
  kind: 'function' | 'value'
  /** The parameters' names of a function (`...rest`, `?` for a pattern); null for a value. */
  params: string[] | null
  /** Where the value is declared, when the member names a declaration (`price: price`); null when the member is the definition. */
  definition: Place | null
  /** The JSDoc of the member, else of the declaration it names, without its delimiters; cut at `MAX_DOC_CHARACTERS`. */
  doc: string | null
}

/** What `module.exports` is, as the last assignment to it writes it. */
export type ExportedValue = 'object' | 'function' | 'class' | 'superModule' | 'assign' | 'require' | 'identifier' | 'call' | 'other'

export type ModuleExports = {
  /** The members exported, by name: a name exported twice keeps its last. In source order. */
  members: ExportedMember[]
  /** The last `module.exports = …`; null when the script assigns none (members only, or nothing). */
  value: ExportedValue | null
  /** Where the last assignment is, and its value's parameters when it is a function (a model's constructor). */
  place: Place | null
  params: string[] | null
  doc: string | null
  /** Whether what is exported is, or builds on, `module.superModule`: its members include the next copy's. */
  extendsSuper: boolean
  /** The modules whose members are exported too: `module.exports = require('x')`, or a name bound to one passed to `Object.assign`. */
  reexports: string[]
}

export type ScriptFileFacts = {
  kind: 'script'
  requires: RequireUse[]
  templates: TemplateUse[]
  resources: ResourceUse[]
  /** The members of modules it reads (`helper.price`), for references. */
  members: MemberUse[]
  /** Every `module.superModule` in the file. */
  superModule: { start: number; end: number }[]
  /** Set for a script read as a controller (under `cartridge/controllers/`). */
  controller: ControllerFacts | null
  /** What the script exports. */
  exports: ModuleExports
  /** Syntax problems found; the index does not keep them. */
  problems: number
  /** Too large to parse: nothing above was read. */
  skipped: boolean
}

/** A custom tag an `<ismodule>` declares (`name="price"` declares `<isprice>`). */
export type TemplateModule = Place & {
  /** The name without `is`. */
  name: string
  /** The template that renders it, when written as plain text. */
  template: string | null
  /** The attributes it takes. */
  attributes: string[]
}

export type TemplateFileFacts = {
  kind: 'template'
  requires: RequireUse[]
  templates: TemplateUse[]
  resources: ResourceUse[]
  members: MemberUse[]
  /** The custom tags its `<ismodule>` tags declare. */
  modules: TemplateModule[]
  problems: number
  skipped: boolean
}

function isIdentifier(node: Node | undefined | null, name?: string): node is AST.Identifier {
  return !!node && node.type === 'Identifier' && (name === undefined || node.name === name)
}

function stringLiteral(node: Node | undefined | null): AST.Literal | null {
  return node && node.type === 'Literal' && node.kind === 'string' ? node : null
}

/** A literal's range without its quotes. */
function innerRange(node: AST.Literal): { start: number; end: number } {
  return { start: node.start + 1, end: Math.max(node.start + 1, node.end - 1) }
}

function memberOf(node: Node): { object: Node; name: string } | null {
  if (node.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier') return null
  return { object: node.object, name: node.property.name }
}

/** Collects template and resource uses from the calls of a tree. */
function collectCalls(root: Node, templates: TemplateUse[], resources: ResourceUse[], visit?: (node: Node) => void): void {
  walk(root, (node) => {
    visit?.(node)
    if (node.type === 'NewExpression') {
      const name = stringLiteral(node.arguments[0])
      if (isIdentifier(node.callee, 'Template') && name) templates.push({ name: name.value as string, via: 'Template', ...innerRange(name) })
      return
    }
    if (node.type !== 'CallExpression') return
    const member = memberOf(node.callee)
    if (!member) return
    const first = stringLiteral(node.arguments[0])
    if (isIdentifier(member.object, 'Resource') && (member.name === 'msg' || member.name === 'msgf')) {
      if (!first) return
      const bundle = stringLiteral(node.arguments[1])
      resources.push({ method: member.name, key: first.value as string, bundle: bundle ? (bundle.value as string) : null, ...innerRange(first) })
      return
    }
    if (!first) return
    if (member.name === 'render' && isIdentifier(member.object, 'res')) templates.push({ name: first.value as string, via: 'render', ...innerRange(first) })
    else if (member.name === 'renderTemplate' && isIdentifier(member.object, 'ISML')) templates.push({ name: first.value as string, via: 'renderTemplate', ...innerRange(first) })
  })
}

/** The module name a `module.superModule` read is kept under. */
export const SUPER_MODULE = 'module.superModule'

/** At most this many member reads are kept per file. */
export const MAX_MEMBER_USES = 5_000

/**
 * The members of modules a file reads, each with the range of the member's name: `helper.price`
 * with `helper` bound to `require('x')`, `require('x').price`, a name of `var { price } =
 * require('x')` wherever it is used, and `base.price` with `base` bound to `module.superModule`
 * (kept under `SUPER_MODULE`). The references of 6.4 are found through these.
 */
export function memberUsesOf(text: string, facts: ScriptFacts, reads: readonly AST.MemberExpression[]): MemberUse[] {
  const starts = lineStarts(text)
  const bound = new Map<number, string>()
  const patterns = new Map<number, { module: string; key: string }>()
  for (const call of facts.requires) {
    if (call.module === null || call.member !== null || !call.binding) continue
    if (call.binding.kind === 'name' && call.binding.declaration !== null) bound.set(call.binding.declaration, call.module)
    if (call.binding.kind === 'pattern') for (const name of call.binding.names) if (name.key !== null && name.declaration !== null) patterns.set(name.declaration, { module: call.module, key: name.key })
  }
  for (const id of facts.exports.superModule.bindings) bound.set(id, SUPER_MODULE)
  const references = new Map<number, Reference>()
  for (const reference of facts.references) references.set(reference.start, reference)
  const uses: MemberUse[] = []
  for (const reference of facts.references) {
    const pattern = reference.declaration === null ? undefined : patterns.get(reference.declaration)
    if (pattern && !reference.write) uses.push({ module: pattern.module, member: pattern.key, start: reference.start, end: reference.end, line: lineAt(starts, reference.start) })
  }
  for (const read of reads) {
    const member = memberOf(read)
    if (!member || read.property.type !== 'Identifier') continue
    const object = read.object
    let module: string | null = null
    if (isIdentifier(object)) {
      const declaration = references.get(object.start)?.declaration
      module = declaration === null || declaration === undefined ? null : (bound.get(declaration) ?? null)
    } else if (object.type === 'CallExpression' && isIdentifier(object.callee, 'require')) {
      module = (stringLiteral(object.arguments[0])?.value as string | undefined) ?? null
    } else if (object.type === 'MemberExpression' && isIdentifier(object.object, 'module') && memberOf(object)?.name === 'superModule') {
      module = SUPER_MODULE
    }
    if (module !== null) uses.push({ module, member: member.name, start: read.property.start, end: read.property.end, line: lineAt(starts, read.property.start) })
  }
  uses.sort((a, b) => a.start - b.start)
  return uses.slice(0, MAX_MEMBER_USES)
}

function requiresOf(facts: ScriptFacts): RequireUse[] {
  const uses: RequireUse[] = []
  for (const call of facts.requires) if (call.module !== null && call.argument) uses.push({ module: call.module, start: call.argument.start, end: call.argument.end })
  return uses
}

/** The facts of a script; `controller` reads its SFRA routes too. */
export function scanScript(text: string, options: { controller?: boolean } = {}): ScriptFileFacts {
  if (text.length > MAX_PARSED_CHARACTERS) return { kind: 'script', requires: [], templates: [], resources: [], members: [], superModule: [], controller: null, exports: noExports(), problems: 0, skipped: true }
  const parsed = parseScript(text)
  const facts = scriptFacts(parsed.program)
  const templates: TemplateUse[] = []
  const resources: ResourceUse[] = []
  const calls: AST.CallExpression[] = []
  const functions = new Map<number, FunctionNode>()
  const reads: AST.MemberExpression[] = []
  collectCalls(parsed.program, templates, resources, (node) => {
    if (options.controller && node.type === 'CallExpression') calls.push(node)
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration') functions.set(node.start, node)
    if (node.type === 'MemberExpression') reads.push(node)
  })
  return {
    kind: 'script',
    requires: requiresOf(facts),
    templates,
    resources,
    members: memberUsesOf(text, facts, reads),
    superModule: facts.exports.superModule.uses.map(({ start, end }) => ({ start, end })),
    controller: options.controller ? controllerFacts(text, facts, calls) : null,
    exports: exportsOf(text, facts, functions),
    problems: parsed.problems.length,
    skipped: false
  }
}

/** The names bound to `require('server')` in a script. */
function serverNames(facts: ScriptFacts): Set<number> {
  const declarations = new Set<number>()
  for (const call of facts.requires) {
    if (call.module !== 'server' || call.member !== null || !call.binding || call.binding.kind !== 'name') continue
    if (call.binding.declaration !== null) declarations.add(call.binding.declaration)
  }
  return declarations
}

function controllerFacts(text: string, facts: ScriptFacts, calls: AST.CallExpression[]): ControllerFacts {
  const servers = serverNames(facts)
  const starts = lineStarts(text)
  const operations: RouteOperation[] = []
  let base: ControllerBase | null = null
  const references = new Map<number, Reference>()
  for (const reference of facts.references) references.set(reference.start, reference)
  const referenceAt = (_facts: ScriptFacts, offset: number) => references.get(offset) ?? null
  const isServer = (node: Node) => {
    if (!isIdentifier(node)) return false
    const reference = referenceAt(facts, node.start)
    return reference !== null && reference.declaration !== null && servers.has(reference.declaration)
  }
  const superBindings = new Set(facts.exports.superModule.bindings)
  for (const call of calls) {
    const member = memberOf(call.callee)
    if (!member || !isServer(member.object)) continue
    if (member.name === 'extend') {
      const argument = call.arguments[0]
      if (!argument || argument.type === 'SpreadElement') continue
      if (argument.type === 'MemberExpression' && isIdentifier(argument.object, 'module') && memberOf(argument)?.name === 'superModule') base = { kind: 'superModule' }
      else if (isIdentifier(argument)) {
        const reference = referenceAt(facts, argument.start)
        if (reference?.declaration !== null && reference?.declaration !== undefined && superBindings.has(reference.declaration)) base = { kind: 'superModule' }
        else {
          const required = facts.requires.find((r) => r.binding?.kind === 'name' && r.binding.declaration === reference?.declaration && r.module !== null)
          if (required?.module) base = { kind: 'require', module: required.module }
        }
      } else if (argument.type === 'CallExpression' && isIdentifier(argument.callee, 'require')) {
        const module = stringLiteral(argument.arguments[0])
        if (module) base = { kind: 'require', module: module.value as string }
      }
      continue
    }
    if (!ROUTE_METHODS.has(member.name)) continue
    const name = stringLiteral(call.arguments[0])
    if (!name) continue
    const inner = innerRange(name)
    operations.push({
      method: member.name as RouteMethod,
      name: name.value as string,
      nameStart: inner.start,
      nameEnd: inner.end,
      start: call.start,
      end: call.end,
      line: lineAt(starts, call.start),
      middleware: Math.max(0, call.arguments.length - 1)
    })
  }
  operations.sort((a, b) => a.start - b.start)
  const exported = facts.exports.assignments.some((assignment) => {
    const value = assignment.value
    if (value.kind !== 'call' || !value.callee || !value.callee.endsWith('.exports')) return false
    const object = value.callee.slice(0, -'.exports'.length)
    // The callee's object is a name bound to `require('server')`.
    return facts.declarations.some((declaration) => declaration.name === object && servers.has(declaration.id))
  })
  return { operations, extends: base, exported }
}

const TEMPLATE_TAGS: ReadonlySet<string> = new Set(['isinclude', 'isdecorate', 'ismodule'])

/** The facts of a template: the templates its tags name, and its JavaScript's requires and resource keys. */
export function scanTemplate(text: string): TemplateFileFacts {
  if (text.length > MAX_PARSED_CHARACTERS) return { kind: 'template', requires: [], templates: [], resources: [], members: [], modules: [], problems: 0, skipped: true }
  const parsed = parseTemplate(text)
  const templates: TemplateUse[] = []
  const resources: ResourceUse[] = []
  walkTemplate(parsed.document, (node) => {
    if (node.type !== 'Element' || !TEMPLATE_TAGS.has(node.name)) return
    const found = attribute(node, 'template')
    if (!found?.value || !found.value.parts.every((part) => part.type === 'Text')) return
    const name = text.slice(found.value.contentStart, found.value.contentEnd)
    if (name.trim()) templates.push({ name, via: node.name as TemplateVia, start: found.value.contentStart, end: found.value.contentEnd })
  })
  const script = templateScript(text, parsed.document)
  const reads: AST.MemberExpression[] = []
  for (const fragment of script.fragments) collectCalls(fragment.node, templates, resources, (node) => void (node.type === 'MemberExpression' && reads.push(node)))
  templates.sort((a, b) => a.start - b.start)
  resources.sort((a, b) => a.start - b.start)
  const starts = lineStarts(text)
  const modules: TemplateModule[] = parsed.document.modules.map((module) => ({
    name: module.name,
    template: module.template,
    attributes: [...module.attributes],
    start: module.start,
    end: module.end,
    line: lineAt(starts, module.start)
  }))
  return { kind: 'template', requires: requiresOf(script.facts), templates, resources, members: memberUsesOf(text, script.facts, reads), modules, problems: parsed.problems.length + script.problems.length, skipped: false }
}

// ---------------------------------------------------------------------------------------------
// What a script exports

type FunctionNode = AST.FunctionExpression | AST.ArrowFunctionExpression | AST.FunctionDeclaration

export function noExports(): ModuleExports {
  return { members: [], value: null, place: null, params: null, doc: null, extendsSuper: false, reexports: [] }
}

/** A parameter's name: `a`, `a = 1` as `a`, `...rest`, `?` for a pattern. */
export function paramName(param: AST.Pattern): string {
  let at: AST.Pattern = param
  let prefix = ''
  for (let depth = 0; depth < 8; depth++) {
    if (at.type === 'Identifier') return prefix + at.name
    if (at.type === 'AssignmentPattern') at = at.left
    else if (at.type === 'RestElement') {
      prefix = '...'
      at = at.argument
    } else break
  }
  return prefix + '?'
}

/** A JSDoc's text, the leading `*` of each line removed, cut at `MAX_DOC_CHARACTERS`; null when empty. */
export function docText(text: string | undefined): string | null {
  if (text === undefined) return null
  const plain = text
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/^\s*\*+\s?/, '').trimEnd())
    .join('\n')
    .trim()
  if (!plain) return null
  return plain.length > MAX_DOC_CHARACTERS ? `${plain.slice(0, MAX_DOC_CHARACTERS)}…` : plain
}

function exportsOf(text: string, facts: ScriptFacts, functions: ReadonlyMap<number, FunctionNode>): ModuleExports {
  const starts = lineStarts(text)
  const place = (range: { start: number; end: number }): Place => ({ start: range.start, end: range.end, line: lineAt(starts, range.start) })
  const declaration = (id: number | null | undefined): Declaration | null => (id === null || id === undefined ? null : (facts.declarations[id] ?? null))
  /** The function a value is, or names; null for anything else. */
  const functionOf = (value: ValueFacts): FunctionNode | null => {
    if (value.kind === 'function') return functions.get(value.start) ?? null
    if (value.kind !== 'identifier') return null
    const init = declaration(value.declaration)?.init
    return init && (init.type === 'FunctionDeclaration' || init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression') ? init : null
  }
  const byName = new Map<string, ExportedMember>()
  for (const member of facts.exports.members) {
    if (!byName.has(member.name) && byName.size >= MAX_EXPORTED_MEMBERS) continue
    const fn = functionOf(member.value)
    const named = member.value.kind === 'identifier' ? declaration(member.value.declaration) : null
    byName.delete(member.name)
    byName.set(member.name, {
      name: member.name,
      ...place(member),
      kind: fn ? 'function' : 'value',
      params: fn ? fn.params.map(paramName) : null,
      definition: named ? place(named) : null,
      doc: docText(member.doc?.text ?? named?.doc?.text)
    })
  }
  const out = noExports()
  out.members = [...byName.values()].sort((a, b) => a.start - b.start)
  out.extendsSuper = facts.exports.superModule.extended
  // A name bound to `require('x')`, by its declaration.
  const required = new Map<number, string>()
  for (const call of facts.requires) {
    if (call.module !== null && call.member === null && call.binding?.kind === 'name' && call.binding.declaration !== null) required.set(call.binding.declaration, call.module)
  }
  const last = facts.exports.assignments[facts.exports.assignments.length - 1]
  if (last) {
    const value = last.value
    const fn = functionOf(value)
    out.value = fn ? 'function' : value.kind
    out.place = place(last)
    out.params = fn ? fn.params.map(paramName) : null
    const named = value.kind === 'identifier' ? declaration(value.declaration) : null
    out.doc = docText(last.doc?.text ?? named?.doc?.text)
    const reexported = (each: ValueFacts) => {
      // `require('x')` itself, not `require('x').member`.
      if (each.kind === 'require' && each.module) return /\)\s*$/.test(text.slice(each.start, each.end)) ? each.module : null
      if (each.kind === 'identifier' && each.declaration !== null && each.declaration !== undefined) return required.get(each.declaration) ?? null
      return null
    }
    for (const each of [value, ...(last.bases ?? [])]) {
      const module = reexported(each)
      if (module !== null && !out.reexports.includes(module)) out.reexports.push(module)
    }
  }
  return out
}
