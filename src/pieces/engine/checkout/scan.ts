// What the checkout index keeps of one script or template: its `require` calls, the templates and
// resource keys it names, `module.superModule`, and for a controller its SFRA route declarations.
// The tree itself is dropped once these are taken. Positions are offsets of the file's text.
// Pure: no Node, no Orca.
import type * as AST from '../js/ast'
import { walk, type Node } from '../js/ast'
import { scriptFacts, type Reference, type ScriptFacts } from '../js/facts'
import { parseScript } from '../js/parser'
import { templateScript } from '../isml/embedded'
import { attribute, parseTemplate, walkTemplate } from '../isml/parser'
import { lineAt, lineStarts } from './files'

/** A file larger than this is listed but not parsed (a bundled library, a generated file). */
export const MAX_PARSED_CHARACTERS = 2_000_000

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

export type ScriptFileFacts = {
  kind: 'script'
  requires: RequireUse[]
  templates: TemplateUse[]
  resources: ResourceUse[]
  /** Every `module.superModule` in the file. */
  superModule: { start: number; end: number }[]
  /** Set for a script read as a controller (under `cartridge/controllers/`). */
  controller: ControllerFacts | null
  /** Syntax problems found; the index does not keep them. */
  problems: number
  /** Too large to parse: nothing above was read. */
  skipped: boolean
}

export type TemplateFileFacts = {
  kind: 'template'
  requires: RequireUse[]
  templates: TemplateUse[]
  resources: ResourceUse[]
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

function requiresOf(facts: ScriptFacts): RequireUse[] {
  const uses: RequireUse[] = []
  for (const call of facts.requires) if (call.module !== null && call.argument) uses.push({ module: call.module, start: call.argument.start, end: call.argument.end })
  return uses
}

/** The facts of a script; `controller` reads its SFRA routes too. */
export function scanScript(text: string, options: { controller?: boolean } = {}): ScriptFileFacts {
  if (text.length > MAX_PARSED_CHARACTERS) return { kind: 'script', requires: [], templates: [], resources: [], superModule: [], controller: null, problems: 0, skipped: true }
  const parsed = parseScript(text)
  const facts = scriptFacts(parsed.program)
  const templates: TemplateUse[] = []
  const resources: ResourceUse[] = []
  const calls: AST.CallExpression[] = []
  collectCalls(parsed.program, templates, resources, options.controller ? (node) => void (node.type === 'CallExpression' && calls.push(node)) : undefined)
  return {
    kind: 'script',
    requires: requiresOf(facts),
    templates,
    resources,
    superModule: facts.exports.superModule.uses.map(({ start, end }) => ({ start, end })),
    controller: options.controller ? controllerFacts(text, facts, calls) : null,
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
  if (text.length > MAX_PARSED_CHARACTERS) return { kind: 'template', requires: [], templates: [], resources: [], problems: 0, skipped: true }
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
  for (const fragment of script.fragments) collectCalls(fragment.node, templates, resources)
  templates.sort((a, b) => a.start - b.start)
  resources.sort((a, b) => a.start - b.start)
  return { kind: 'template', requires: requiresOf(script.facts), templates, resources, problems: parsed.problems.length + script.problems.length, skipped: false }
}
