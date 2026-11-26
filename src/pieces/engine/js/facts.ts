// What a script declares and uses, computed from its tree: scopes, declarations, the declaration
// each identifier use refers to, `require` calls with the names they bind, and what the module
// exports (`module.exports`, `exports.x`, `Object.assign`, `module.superModule` chains).
//
// Scoping is simple and lexical: `var` and function declarations belong to the nearest function
// (or the module), `let`, `const` and `class` to the nearest block, parameters to their function,
// a catch binding to its clause. A use resolves to the nearest declaration of its name up the
// scope chain, whatever their order in the text (hoisting); in a template, the template's own
// scope is the exception: there a use sees only what was declared before it (see
// `fragmentFacts`). A use that resolves to nothing is a global (`declaration: null`).
// Pure: no Node, no Orca.
import type * as AST from './ast'
import type { Comment, Expression, Node, Pattern, Range } from './ast'
import { forEachChild } from './ast'

export type ScopeKind = 'module' | 'template' | 'function' | 'block' | 'catch' | 'class' | 'loop'

export interface Scope extends Range {
  id: number
  kind: ScopeKind
  /** The enclosing scope; `null` for the outermost. */
  parent: number | null
}

export type DeclarationKind = 'var' | 'let' | 'const' | 'function' | 'class' | 'param' | 'catch' | 'isset' | 'isloop'

export interface Declaration {
  id: number
  name: string
  kind: DeclarationKind
  /** The range of the declared name. */
  start: number
  end: number
  /** The whole declaring construct: the function, the class, the declarator, the parameter, the tag. */
  node: Range
  scope: number
  /** The value it starts with: a declarator's initializer, or the function or class itself. */
  init: Expression | AST.FunctionDeclaration | AST.ClassDeclaration | null
  /** The JSDoc comment of the declaring statement, if any. */
  doc?: Comment
  /** From which offset a use may see it: 0 in a script (hoisting); in a template's own scope, where it is declared. */
  visibleFrom: number
}

export interface Reference {
  name: string
  start: number
  end: number
  scope: number
  /** The declaration it refers to, by id; `null` for a global or an unknown name. */
  declaration: number | null
  /** The use assigns the name (`a = …`, `a++`, a `for…in` target). */
  write: boolean
}

export type RequireBinding =
  /** `var a = require('x')`, `a = require('x')`, `var a = require('x').member`. */
  | { kind: 'name'; name: string; start: number; end: number; declaration: number | null }
  /** `const { b, c: d } = require('x')`: one entry per bound name. */
  | { kind: 'pattern'; names: RequirePatternName[] }

export interface RequirePatternName {
  /** The property read from the module (`c`); `null` for a rest element. */
  key: string | null
  /** The local name it is bound to (`d`). */
  name: string
  start: number
  end: number
  declaration: number | null
}

export interface RequireCall extends Range {
  /** The literal argument (`'dw/web/URLUtils'`, `'*\/cartridge/scripts/x'`); `null` when it is not a literal. */
  module: string | null
  /** The range of the argument, quotes included; `null` when there is none. */
  argument: Range | null
  /** `require('x').member`: the member read off the module. */
  member: string | null
  binding: RequireBinding | null
  scope: number
}

/** What an exported value is, as far as its syntax tells. */
export type ValueKind = 'function' | 'class' | 'object' | 'identifier' | 'require' | 'superModule' | 'assign' | 'call' | 'other'

export interface ValueFacts extends Range {
  kind: ValueKind
  /** `identifier`: the name and its declaration. */
  name?: string
  declaration?: number | null
  /** `require`: the module named. */
  module?: string | null
  /** `call`: the callee as a dotted name (`server.exports`), when it is one. */
  callee?: string
  /** Whether the value is `module.superModule`, a name bound to it, or (`assign`) builds on one. */
  superModule: boolean
}

export interface ExportAssignment extends Range {
  /** The value assigned to `module.exports`. */
  value: ValueFacts
  /** `assign`: the identifiers and `module.superModule` passed to `Object.assign`, in order. */
  bases?: ValueFacts[]
  doc?: Comment
}

export type ExportSource =
  /** A property of an object literal assigned to `module.exports` (directly, or through the exported name). */
  | 'object'
  /** `module.exports.x = …` or `exports.x = …`. */
  | 'member'
  /** `name.x = …` where `name` is what `module.exports` is assigned, or a binding of `module.superModule`. */
  | 'extension'
  /** A property of an object literal passed to `Object.assign` whose result is exported. */
  | 'assign'

export interface ExportMember {
  name: string
  /** The range of the name where it is exported. */
  start: number
  end: number
  value: ValueFacts
  source: ExportSource
  doc?: Comment
}

export interface SuperModuleFacts {
  /** Every `module.superModule` in the text. */
  uses: Range[]
  /** Declarations whose value is `module.superModule`. */
  bindings: number[]
  /** Whether what the module exports is, or builds on, `module.superModule`. */
  extended: boolean
}

export interface ExportFacts {
  /** Every `module.exports = …`, in source order (the last one wins at run time). */
  assignments: ExportAssignment[]
  /** Every exported member found, in source order. */
  members: ExportMember[]
  superModule: SuperModuleFacts
}

export interface ScriptFacts {
  scopes: Scope[]
  declarations: Declaration[]
  references: Reference[]
  requires: RequireCall[]
  exports: ExportFacts
}

/** One piece of JavaScript of a template: a `${…}` expression or an `<isscript>` block. */
export interface Fragment {
  /** The fragment's tree: a script's program, or an expression. */
  node: AST.Program | Expression
}

/** A name a template declares outside JavaScript: `<isset name>` or an `<isloop>` variable. */
export interface TemplateDeclaration {
  name: string
  kind: 'isset' | 'isloop'
  /** The range of the name (inside its attribute value). */
  start: number
  end: number
  /** The tag that declares it. */
  node: Range
  /** `isset`: from where it can be used (after its tag). `isloop`: the loop element, where it can be used. */
  visible: Range
}

/** The facts of a script. */
export function scriptFacts(program: AST.Program): ScriptFacts {
  const builder = new FactsBuilder('module', program, false)
  builder.visitProgram(program, builder.rootScope)
  return builder.finish()
}

/**
 * The facts of a template's JavaScript as a whole: its fragments share one scope, the template's,
 * where a use sees only the names declared before it (a `require` in an `<isscript>` binds a name
 * the expressions after it can use) and the names of the `<isloop>` elements around it.
 */
export function fragmentFacts(range: Range, fragments: readonly Fragment[], declarations: readonly TemplateDeclaration[] = []): ScriptFacts {
  const builder = new FactsBuilder('template', range, true)
  const loops: { scope: number; range: Range }[] = []
  // Loop scopes first, outer before inner, so each one's parent is already known.
  const loopDeclarations = declarations.filter((d) => d.kind === 'isloop').sort((a, b) => a.visible.start - b.visible.start || b.visible.end - a.visible.end)
  for (const declaration of loopDeclarations) {
    let loop = loops.find((l) => l.range.start === declaration.visible.start && l.range.end === declaration.visible.end)
    if (!loop) {
      const parent = innermost(loops, declaration.visible.start, declaration.visible.end)
      loop = { scope: builder.addScope('loop', declaration.visible, parent ?? builder.rootScope), range: declaration.visible }
      loops.push(loop)
    }
    builder.declare(declaration.name, 'isloop', declaration, declaration.node, loop.scope, null, undefined, declaration.visible.start)
  }
  for (const declaration of declarations) {
    if (declaration.kind !== 'isset') continue
    builder.declare(declaration.name, 'isset', declaration, declaration.node, builder.rootScope, null, undefined, declaration.visible.start)
  }
  for (const fragment of fragments) {
    const scope = innermost(loops, fragment.node.start, fragment.node.end) ?? builder.rootScope
    // A template-level `var` belongs to the template; it is visible from its fragment on.
    builder.fragmentStart = fragment.node.start
    if (fragment.node.type === 'Program') builder.visitProgram(fragment.node, scope)
    else builder.visit(fragment.node, scope)
  }
  return builder.finish()
}

function innermost(loops: { scope: number; range: Range }[], start: number, end: number): number | null {
  let best: { scope: number; range: Range } | null = null
  for (const loop of loops) {
    if (loop.range.start <= start && end <= loop.range.end && (!best || loop.range.end - loop.range.start <= best.range.end - best.range.start)) best = loop
  }
  return best ? best.scope : null
}

// ---------------------------------------------------------------------------------------------

/** Past this depth the walk stops descending: deeper than any tree the parser builds. */
const MAX_WALK_DEPTH = 3000

interface ScopeData extends Scope {
  names: Map<string, Declaration[]>
  /** The scope `var` declarations of this scope go to. */
  functionScope: number
}

/** An assignment `name.member = value` seen while walking, settled once the exported names are known. */
interface PendingExtension {
  object: string
  objectScope: number
  objectStart: number
  member: string
  start: number
  end: number
  value: Expression
  doc?: Comment
}

class FactsBuilder {
  private readonly scopes: ScopeData[] = []
  private readonly declarations: Declaration[] = []
  private readonly references: Reference[] = []
  private readonly requires: RequireCall[] = []
  /** Every `require` call, to its index in `requires`. */
  private readonly requireNodes = new Map<AST.CallExpression, number>()
  /** `require('x').member`: the member read off a call. */
  private readonly requireMembers = new Map<AST.CallExpression, string>()
  /** Function declarations declared ahead of their list. */
  private readonly hoisted = new Set<AST.FunctionDeclaration>()
  /** JSDoc of the statements whose expression is an assignment. */
  private readonly docs = new Map<AST.AssignmentExpression, Comment>()
  /** Bindings of `require` calls whose declaration is settled at the end. */
  private readonly requireBindings = new Map<AST.CallExpression, RequireBinding>()
  private readonly assignments: { node: AST.AssignmentExpression; scope: number; doc?: Comment }[] = []
  private readonly memberExports: { name: string; start: number; end: number; value: Expression; scope: number; doc?: Comment }[] = []
  private readonly extensions: PendingExtension[] = []
  private readonly superUses: Range[] = []
  /** Declarators whose value is `module.superModule`, settled to declarations at the end. */
  private readonly superDeclarators: { id: AST.Identifier; scope: number }[] = []
  /** Values to classify once every use is resolved. */
  private readonly valueScopes = new Map<Expression, number>()
  private readonly ordered: boolean
  readonly rootScope: number
  /** In a template, where the fragment being walked starts: its template-level names are visible from there. */
  fragmentStart = 0

  constructor(kind: 'module' | 'template', range: Range, ordered: boolean) {
    this.ordered = ordered
    this.rootScope = this.addScope(kind, range, null)
  }

  addScope(kind: ScopeKind, range: Range, parent: number | null): number {
    const id = this.scopes.length
    const functionScope = kind === 'module' || kind === 'template' || kind === 'function' || parent === null ? id : this.scopes[parent].functionScope
    this.scopes.push({ id, kind, start: range.start, end: range.end, parent, names: new Map(), functionScope })
    return id
  }

  declare(
    name: string,
    kind: DeclarationKind,
    at: Range,
    node: Range,
    scope: number,
    init: Declaration['init'],
    doc: Comment | undefined,
    visibleFrom?: number
  ): Declaration {
    const visible = visibleFrom ?? (this.ordered && this.isRootLevel(scope) ? this.fragmentStart : 0)
    const declaration: Declaration = { id: this.declarations.length, name, kind, start: at.start, end: at.end, node: { start: node.start, end: node.end }, scope, init, visibleFrom: visible }
    if (doc) declaration.doc = doc
    this.declarations.push(declaration)
    const data = this.scopes[scope]
    const list = data.names.get(name)
    if (list) list.push(declaration)
    else data.names.set(name, [declaration])
    return declaration
  }

  /** The scope is the template's own, or a loop scope of it: where order matters. */
  private isRootLevel(scope: number): boolean {
    const kind = this.scopes[scope].kind
    return kind === 'template' || kind === 'loop' || kind === 'module'
  }

  private use(id: AST.Identifier, scope: number, write: boolean): void {
    this.references.push({ name: id.name, start: id.start, end: id.end, scope, declaration: null, write })
  }

  /** The declaration `name` refers to from `scope` at `offset`. */
  private lookup(name: string, scope: number, offset: number): Declaration | null {
    for (let current: number | null = scope; current !== null; current = this.scopes[current].parent) {
      const list = this.scopes[current].names.get(name)
      if (!list) continue
      if (!this.ordered) return list[0]
      // In a template: the last declaration visible at this offset.
      let found: Declaration | null = null
      for (const declaration of list) if (declaration.visibleFrom <= offset) found = declaration
      if (found) return found
    }
    return null
  }

  // -------------------------------------------------------------------------------------------
  // Walking

  visitProgram(program: AST.Program, scope: number): void {
    this.hoistFunctions(program.body, scope)
    for (const statement of program.body) this.visit(statement, scope)
  }

  /** Function declarations are known before the code around them runs. */
  private hoistFunctions(body: AST.Statement[], scope: number): void {
    for (const statement of body) {
      if (statement.type === 'FunctionDeclaration' && statement.id) {
        this.hoisted.add(statement)
        this.declare(statement.id.name, 'function', statement.id, statement, this.scopes[scope].functionScope, statement, statement.doc)
      }
    }
  }

  /** How deep the walk is; the parser bounds a tree's depth, and this bounds the walk the same way on any tree. */
  private depth = 0

  visit(node: Node, scope: number): void {
    if (this.depth >= MAX_WALK_DEPTH) return
    this.depth++
    try {
      this.visitNode(node, scope)
    } finally {
      this.depth--
    }
  }

  private visitNode(node: Node, scope: number): void {
    switch (node.type) {
      case 'Identifier':
        this.use(node, scope, false)
        return
      case 'FunctionDeclaration':
        // Declared by `hoistFunctions` of its list; a function in a nested statement position (`if (a) function f() {}`) is declared here.
        if (node.id && !this.hoisted.has(node)) this.declare(node.id.name, 'function', node.id, node, this.scopes[scope].functionScope, node, node.doc)
        this.visitFunction(node, scope)
        return
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        this.visitFunction(node, scope)
        return
      case 'ClassDeclaration':
        if (node.id) this.declare(node.id.name, 'class', node.id, node, scope, node, node.doc)
        this.visitClass(node, scope)
        return
      case 'ClassExpression':
        this.visitClass(node, scope)
        return
      case 'VariableDeclaration':
        this.visitVariableDeclaration(node, scope)
        return
      case 'BlockStatement': {
        const inner = this.addScope('block', node, scope)
        this.hoistFunctions(node.body, inner)
        for (const statement of node.body) this.visit(statement, inner)
        return
      }
      case 'SwitchStatement': {
        this.visit(node.discriminant, scope)
        const inner = this.addScope('block', node, scope)
        for (const switchCase of node.cases) this.hoistFunctions(switchCase.consequent, inner)
        for (const switchCase of node.cases) {
          if (switchCase.test) this.visit(switchCase.test, inner)
          for (const statement of switchCase.consequent) this.visit(statement, inner)
        }
        return
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const loopScope = this.addScope('block', node, scope)
        if (node.type === 'ForStatement') {
          if (node.init) this.visit(node.init, loopScope)
          if (node.test) this.visit(node.test, loopScope)
          if (node.update) this.visit(node.update, loopScope)
        } else {
          if (node.left.type === 'VariableDeclaration') this.visit(node.left, loopScope)
          else this.visitTarget(node.left, loopScope)
          this.visit(node.right, loopScope)
        }
        this.visit(node.body, loopScope)
        return
      }
      case 'CatchClause': {
        const inner = this.addScope('catch', node, scope)
        if (node.param) this.declarePattern(node.param, 'catch', node.param, inner, null, undefined)
        if (node.guard) this.visit(node.guard, inner)
        this.visit(node.body, inner)
        return
      }
      case 'MemberExpression':
        this.visitMember(node, scope)
        return
      case 'Property':
        if (node.computed) this.visit(node.key, scope)
        this.visit(node.value, scope)
        return
      case 'MethodDefinition':
        if (node.computed) this.visit(node.key, scope)
        this.visit(node.value, scope)
        return
      case 'LabeledStatement':
        this.visit(node.body, scope)
        return
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
        return
      case 'AssignmentExpression':
        this.visitAssignment(node, scope)
        return
      case 'UpdateExpression':
        if (node.argument.type === 'Identifier') this.use(node.argument, scope, true)
        else this.visit(node.argument, scope)
        return
      case 'CallExpression':
        this.visitCall(node, scope)
        return
      case 'ExpressionStatement':
        if (node.doc && node.expression.type === 'AssignmentExpression') this.docs.set(node.expression, node.doc)
        this.visit(node.expression, scope)
        return
      case 'ObjectPattern':
      case 'ArrayPattern':
      case 'AssignmentPattern':
      case 'RestElement':
        this.visitTarget(node, scope)
        return
    }
    forEachChild(node, (child) => this.visit(child, scope))
  }

  private visitFunction(node: AST.FunctionDeclaration | AST.FunctionExpression | AST.ArrowFunctionExpression, scope: number): void {
    let outer = scope
    if (node.type === 'FunctionExpression' && node.id) {
      // A named function expression's name is visible only inside it.
      outer = this.addScope('function', node, scope)
      this.declare(node.id.name, 'function', node.id, node, outer, node, undefined, 0)
    }
    const inner = this.addScope('function', node, outer)
    for (const param of node.params) this.declarePattern(param, 'param', param, inner, null, undefined)
    if (node.body.type === 'BlockStatement') {
      this.hoistFunctions(node.body.body, inner)
      for (const statement of node.body.body) this.visit(statement, inner)
    } else {
      this.visit(node.body, inner)
    }
  }

  private visitClass(node: AST.ClassDeclaration | AST.ClassExpression, scope: number): void {
    if (node.superClass) this.visit(node.superClass, scope)
    const inner = this.addScope('class', node, scope)
    if (node.type === 'ClassExpression' && node.id) this.declare(node.id.name, 'class', node.id, node, inner, node, undefined, 0)
    for (const member of node.body.body) this.visit(member, inner)
  }

  private visitVariableDeclaration(node: AST.VariableDeclaration, scope: number): void {
    const target = node.kind === 'var' ? this.scopes[scope].functionScope : scope
    for (const declarator of node.declarations) {
      const init = declarator.init
      // Declared before its initializer is walked: `var a = function () { a() }` sees itself.
      this.declarePattern(declarator.id, node.kind, declarator, target, init, node.doc)
      if (init) {
        this.noteRequireBinding(declarator.id, init)
        if (declarator.id.type === 'Identifier' && isSuperModule(init)) this.superDeclarators.push({ id: declarator.id, scope: target })
        this.visit(init, scope)
      }
    }
  }

  /** Declares every name of a binding pattern, and walks its defaults and computed keys. */
  private declarePattern(pattern: Pattern, kind: DeclarationKind, node: Range, scope: number, init: Expression | null, doc: Comment | undefined): void {
    switch (pattern.type) {
      case 'Identifier':
        this.declare(pattern.name, kind, pattern, node, scope, init, doc)
        return
      case 'ObjectPattern':
        for (const property of pattern.properties) {
          if (property.type === 'RestElement') {
            this.declarePattern(property.argument, kind, node, scope, null, doc)
          } else {
            if (property.computed) this.visit(property.key, scope)
            this.declarePattern(property.value as Pattern, kind, node, scope, null, doc)
          }
        }
        return
      case 'ArrayPattern':
        for (const element of pattern.elements) if (element) this.declarePattern(element, kind, node, scope, null, doc)
        return
      case 'AssignmentPattern':
        this.declarePattern(pattern.left, kind, node, scope, init, doc)
        this.visit(pattern.right, scope)
        return
      case 'RestElement':
        this.declarePattern(pattern.argument, kind, node, scope, null, doc)
        return
      case 'MemberExpression':
        this.visit(pattern, scope)
        return
    }
  }

  /** An assignment target: its names are written, its defaults and member objects read. */
  private visitTarget(pattern: Pattern, scope: number): void {
    switch (pattern.type) {
      case 'Identifier':
        this.use(pattern, scope, true)
        return
      case 'ObjectPattern':
        for (const property of pattern.properties) {
          if (property.type === 'RestElement') this.visitTarget(property.argument, scope)
          else {
            if (property.computed) this.visit(property.key, scope)
            this.visitTarget(property.value as Pattern, scope)
          }
        }
        return
      case 'ArrayPattern':
        for (const element of pattern.elements) if (element) this.visitTarget(element, scope)
        return
      case 'AssignmentPattern':
        this.visitTarget(pattern.left, scope)
        this.visit(pattern.right, scope)
        return
      case 'RestElement':
        this.visitTarget(pattern.argument, scope)
        return
      case 'MemberExpression':
        this.visit(pattern, scope)
        return
    }
  }

  private visitMember(node: AST.MemberExpression, scope: number): void {
    if (node.object.type === 'CallExpression' && isIdentifier(node.object.callee, 'require')) {
      const member = memberName(node)
      if (member) this.requireMembers.set(node.object, member.name)
    }
    if (isSuperModule(node)) {
      this.superUses.push({ start: node.start, end: node.end })
      this.visit(node.object, scope)
      return
    }
    this.visit(node.object, scope)
    if (node.computed) this.visit(node.property, scope)
  }

  private visitAssignment(node: AST.AssignmentExpression, scope: number): void {
    const left = node.left
    if (node.operator === '=') {
      const doc = this.docs.get(node)
      // The value of a chain `a = b = c` is its last right-hand side.
      let value: Expression = node.right
      while (value.type === 'AssignmentExpression' && value.operator === '=') value = value.right
      if (left.type === 'MemberExpression') {
        if (isModuleExports(left)) {
          this.assignments.push({ node, scope, doc })
          this.valueScopes.set(value, scope)
        } else {
          const member = memberName(left)
          if (member !== null) {
            if (isModuleExports(left.object) || isExportsObject(left.object)) {
              this.memberExports.push({ name: member.name, start: member.start, end: member.end, value, scope, doc })
              this.valueScopes.set(value, scope)
            } else if (left.object.type === 'Identifier') {
              this.extensions.push({
                object: left.object.name,
                objectScope: scope,
                objectStart: left.object.start,
                member: member.name,
                start: member.start,
                end: member.end,
                value,
                doc
              })
              this.valueScopes.set(value, scope)
            }
          }
        }
      }
      if (left.type === 'Identifier') this.noteRequireBinding(left, node.right)
      if (left.type === 'Identifier' && isSuperModule(node.right)) this.superDeclarators.push({ id: left, scope })
    }
    if (left.type === 'Identifier') this.use(left, scope, true)
    else if (left.type === 'MemberExpression') this.visit(left, scope)
    else this.visitTarget(left as Pattern, scope)
    this.visit(node.right, scope)
  }

  /** Remembers the name a `require` call (or `require(…).member`) is bound to. */
  private noteRequireBinding(target: Pattern, init: Expression): void {
    const call = requireCallOf(init)
    if (!call) return
    if (target.type === 'Identifier') {
      this.requireBindings.set(call, { kind: 'name', name: target.name, start: target.start, end: target.end, declaration: null })
    } else if (target.type === 'ObjectPattern') {
      const names: RequirePatternName[] = []
      for (const property of target.properties) {
        if (property.type === 'RestElement') {
          if (property.argument.type === 'Identifier') names.push({ key: null, name: property.argument.name, start: property.argument.start, end: property.argument.end, declaration: null })
          continue
        }
        let value = property.value as Pattern
        if (value.type === 'AssignmentPattern') value = value.left
        if (value.type !== 'Identifier') continue
        const key = property.computed ? null : propertyKeyName(property.key)
        names.push({ key, name: value.name, start: value.start, end: value.end, declaration: null })
      }
      this.requireBindings.set(call, { kind: 'pattern', names })
    }
  }

  private visitCall(node: AST.CallExpression, scope: number): void {
    if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
      const first = node.arguments[0]
      let module: string | null = null
      if (first && first.type === 'Literal' && first.kind === 'string') module = first.value as string
      else if (first && first.type === 'TemplateLiteral' && first.expressions.length === 0) module = first.quasis[0].cooked
      this.requires.push({
        module,
        argument: first ? { start: first.start, end: first.end } : null,
        member: null,
        binding: null,
        scope,
        start: node.start,
        end: node.end
      })
      this.requireNodes.set(node, this.requires.length - 1)
    }
    this.visit(node.callee, scope)
    for (const argument of node.arguments) this.visit(argument, scope)
  }

  // -------------------------------------------------------------------------------------------
  // Settling

  finish(): ScriptFacts {
    // Each use to its declaration.
    for (const reference of this.references) {
      const declaration = this.lookup(reference.name, reference.scope, reference.start)
      reference.declaration = declaration ? declaration.id : null
    }
    const byStart = new Map<number, Reference>()
    for (const reference of this.references) byStart.set(reference.start, reference)
    const resolve = (name: string, scope: number, offset: number): number | null => {
      const known = byStart.get(offset)
      if (known && known.name === name) return known.declaration
      const declaration = this.lookup(name, scope, offset)
      return declaration ? declaration.id : null
    }
    const declaredAt = new Map<number, Declaration>()
    for (const declaration of this.declarations) declaredAt.set(declaration.start, declaration)
    /** The declaration a bound name is: declared right there, or the one an assigned name refers to. */
    const bindingOf = (start: number, name: string): number | null => {
      const found = declaredAt.get(start)
      return found && found.name === name ? found.id : resolve(name, this.rootScope, start)
    }

    // Requires: the member read off each, and the declarations of the names they bind.
    for (const [call, index] of this.requireNodes) {
      const fact = this.requires[index]
      const binding = this.requireBindings.get(call)
      if (binding) {
        if (binding.kind === 'name') binding.declaration = bindingOf(binding.start, binding.name)
        else for (const name of binding.names) name.declaration = bindingOf(name.start, name.name)
        fact.binding = binding
      }
    }
    for (const [call, member] of this.requireMembers) {
      const index = this.requireNodes.get(call)
      if (index !== undefined) this.requires[index].member = member
    }

    // module.superModule bindings.
    const superBindings = new Set<number>()
    for (const { id } of this.superDeclarators) {
      const declaration = bindingOf(id.start, id.name)
      if (declaration !== null) superBindings.add(declaration)
    }

    const classify = (value: Expression): ValueFacts => {
      const scope = this.valueScopes.get(value) ?? this.rootScope
      return classifyValue(value, (id) => resolve(id.name, scope, id.start), superBindings)
    }

    const assignments: ExportAssignment[] = this.assignments.map(({ node, doc }) => {
      let valueNode: Expression = node.right
      while (valueNode.type === 'AssignmentExpression' && valueNode.operator === '=') valueNode = valueNode.right
      const assignment: ExportAssignment = { start: node.start, end: node.end, value: classify(valueNode) }
      if (assignment.value.kind === 'assign' && valueNode.type === 'CallExpression') {
        assignment.bases = valueNode.arguments
          .filter((argument): argument is Expression => argument.type !== 'SpreadElement' && argument.type !== 'ObjectExpression')
          .map((argument) => classify(argument))
          .filter((base) => base.kind === 'identifier' || base.kind === 'superModule' || base.kind === 'require')
      }
      if (doc) assignment.doc = doc
      return assignment
    })

    const members: (ExportMember & { order: number })[] = []
    // Properties of exported object literals, and of Object.assign arguments.
    this.assignments.forEach(({ node }) => {
      let valueNode: Expression = node.right
      while (valueNode.type === 'AssignmentExpression' && valueNode.operator === '=') valueNode = valueNode.right
      if (valueNode.type === 'ObjectExpression') {
        for (const member of this.objectMembers(valueNode, 'object')) members.push({ ...member, value: classify(member.valueNode), order: member.start })
      } else if (valueNode.type === 'CallExpression' && isObjectAssign(valueNode)) {
        for (const argument of valueNode.arguments) {
          if (argument.type === 'ObjectExpression') {
            for (const member of this.objectMembers(argument, 'assign')) members.push({ ...member, value: classify(member.valueNode), order: member.start })
          }
        }
      }
    })
    // module.exports.x = … and exports.x = …
    for (const member of this.memberExports) {
      const fact: ExportMember & { order: number } = { name: member.name, start: member.start, end: member.end, value: classify(member.value), source: 'member', order: member.start }
      if (member.doc) fact.doc = member.doc
      members.push(fact)
    }
    // Names whose members are exported: what module.exports is assigned (directly or as an
    // Object.assign base), and every binding of module.superModule.
    const exportedNames = new Set<number>(superBindings)
    for (const assignment of assignments) {
      if (assignment.value.kind === 'identifier' && assignment.value.declaration != null) exportedNames.add(assignment.value.declaration)
      for (const base of assignment.bases ?? []) if (base.kind === 'identifier' && base.declaration != null) exportedNames.add(base.declaration)
    }
    for (const id of exportedNames) {
      const declaration = this.declarations[id]
      if (superBindings.has(id) && !this.exportsBuildOn(assignments, id)) continue
      if (declaration.init && declaration.init.type === 'ObjectExpression') {
        for (const member of this.objectMembers(declaration.init, 'object')) members.push({ ...member, value: classify(member.valueNode), order: member.start })
      }
    }
    for (const extension of this.extensions) {
      const declaration = resolve(extension.object, extension.objectScope, extension.objectStart)
      if (declaration === null || !exportedNames.has(declaration)) continue
      if (superBindings.has(declaration) && !this.exportsBuildOn(assignments, declaration)) continue
      const fact: ExportMember & { order: number } = { name: extension.member, start: extension.start, end: extension.end, value: classify(extension.value), source: 'extension', order: extension.start }
      if (extension.doc) fact.doc = extension.doc
      members.push(fact)
    }
    members.sort((a, b) => a.order - b.order)

    const extended = assignments.some((assignment) => assignment.value.superModule)

    const scopes: Scope[] = this.scopes.map(({ id, kind, start, end, parent }) => ({ id, kind, start, end, parent }))
    return {
      scopes,
      declarations: this.declarations,
      references: this.references,
      requires: this.requires,
      exports: {
        assignments,
        members: members.map(({ order: _order, ...member }) => member),
        superModule: { uses: this.superUses, bindings: [...superBindings], extended }
      }
    }
  }

  /** Whether a `module.exports = …` exports the declaration `id` or builds on it. */
  private exportsBuildOn(assignments: ExportAssignment[], id: number): boolean {
    return assignments.some(
      (assignment) =>
        (assignment.value.kind === 'identifier' && assignment.value.declaration === id) ||
        (assignment.bases ?? []).some((base) => base.kind === 'identifier' && base.declaration === id)
    )
  }

  private objectMembers(object: AST.ObjectExpression, source: ExportSource): { name: string; start: number; end: number; valueNode: Expression; source: ExportSource; doc?: Comment }[] {
    const out: { name: string; start: number; end: number; valueNode: Expression; source: ExportSource; doc?: Comment }[] = []
    for (const property of object.properties) {
      if (property.type !== 'Property' || property.computed) continue
      const name = propertyKeyName(property.key)
      if (name === null) continue
      const value = property.value
      if (value.type === 'ObjectPattern' || value.type === 'ArrayPattern' || value.type === 'AssignmentPattern' || value.type === 'RestElement') continue
      const member: { name: string; start: number; end: number; valueNode: Expression; source: ExportSource; doc?: Comment } = { name, start: property.key.start, end: property.key.end, valueNode: value, source }
      if (property.doc) member.doc = property.doc
      out.push(member)
    }
    return out
  }

}

// ---------------------------------------------------------------------------------------------
// Shapes

function isIdentifier(node: Node | null | undefined, name: string): boolean {
  return !!node && node.type === 'Identifier' && node.name === name
}

/** The name of a non-computed member, or of a member with a string key (`a['b']`). */
function memberName(node: AST.MemberExpression): { name: string; start: number; end: number } | null {
  if (!node.computed && node.property.type === 'Identifier') return { name: node.property.name, start: node.property.start, end: node.property.end }
  if (node.computed && node.property.type === 'Literal' && node.property.kind === 'string') {
    return { name: node.property.value as string, start: node.property.start, end: node.property.end }
  }
  return null
}

/** `module.exports` (or `module['exports']`). */
export function isModuleExports(node: Node): boolean {
  if (node.type !== 'MemberExpression' || !isIdentifier(node.object, 'module')) return false
  const name = memberName(node)
  return name !== null && name.name === 'exports'
}

function isExportsObject(node: Node): boolean {
  return isIdentifier(node, 'exports')
}

/** `module.superModule`. */
export function isSuperModule(node: Node): boolean {
  if (node.type !== 'MemberExpression' || !isIdentifier(node.object, 'module')) return false
  const name = memberName(node)
  return name !== null && name.name === 'superModule'
}

function isObjectAssign(node: Node): boolean {
  return node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && isIdentifier(node.callee.object, 'Object') && memberName(node.callee)?.name === 'assign'
}

/** The `require(…)` call an initializer is, or reads a member of; `null` otherwise. */
function requireCallOf(node: Expression): AST.CallExpression | null {
  if (node.type === 'CallExpression' && isIdentifier(node.callee, 'require')) return node
  if (node.type === 'MemberExpression' && node.object.type === 'CallExpression' && isIdentifier(node.object.callee, 'require')) return node.object
  return null
}

function propertyKeyName(key: Expression): string | null {
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal' && (key.kind === 'string' || key.kind === 'number')) return String(key.value)
  return null
}

/** A callee as a dotted name (`server.exports`), or `undefined` when it is not one. */
function dottedName(node: Node): string | undefined {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const object = dottedName(node.object)
    return object === undefined ? undefined : `${object}.${node.property.name}`
  }
  return undefined
}

function classifyValue(value: Expression, resolve: (id: AST.Identifier) => number | null, superBindings: Set<number>): ValueFacts {
  const range = { start: value.start, end: value.end }
  switch (value.type) {
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return { ...range, kind: 'function', superModule: false }
    case 'ClassExpression':
      return { ...range, kind: 'class', superModule: false }
    case 'ObjectExpression':
      return { ...range, kind: 'object', superModule: false }
    case 'Identifier': {
      const declaration = resolve(value)
      return { ...range, kind: 'identifier', name: value.name, declaration, superModule: declaration !== null && superBindings.has(declaration) }
    }
    case 'MemberExpression': {
      if (isSuperModule(value)) return { ...range, kind: 'superModule', superModule: true }
      const call = requireCallOf(value)
      if (call) return { ...range, kind: 'require', module: requireModule(call), superModule: false }
      return { ...range, kind: 'other', superModule: false }
    }
    case 'CallExpression': {
      if (isIdentifier(value.callee, 'require')) return { ...range, kind: 'require', module: requireModule(value), superModule: false }
      if (isObjectAssign(value)) {
        const builds = value.arguments.some((argument) => {
          if (argument.type === 'SpreadElement') return false
          if (isSuperModule(argument)) return true
          if (argument.type === 'Identifier') {
            const declaration = resolve(argument)
            return declaration !== null && superBindings.has(declaration)
          }
          return false
        })
        return { ...range, kind: 'assign', superModule: builds }
      }
      const callee = dottedName(value.callee)
      return callee === undefined ? { ...range, kind: 'call', superModule: false } : { ...range, kind: 'call', callee, superModule: false }
    }
  }
  return { ...range, kind: 'other', superModule: false }
}

function requireModule(call: AST.CallExpression): string | null {
  const first = call.arguments[0]
  if (first && first.type === 'Literal' && first.kind === 'string') return first.value as string
  if (first && first.type === 'TemplateLiteral' && first.expressions.length === 0) return first.quasis[0].cooked
  return null
}

// ---------------------------------------------------------------------------------------------
// Lookups for later parts

/** The use at `offset`, if any. */
export function referenceAt(facts: ScriptFacts, offset: number): Reference | null {
  for (const reference of facts.references) if (reference.start <= offset && offset <= reference.end) return reference
  return null
}

/** The declaration whose name sits at `offset`, if any. */
export function declarationAt(facts: ScriptFacts, offset: number): Declaration | null {
  for (const declaration of facts.declarations) if (declaration.start <= offset && offset <= declaration.end) return declaration
  return null
}

/** The innermost scope holding `offset`. */
export function scopeAt(facts: ScriptFacts, offset: number): Scope {
  let best = facts.scopes[0]
  for (const scope of facts.scopes) {
    if (scope.start <= offset && offset <= scope.end && scope.end - scope.start <= best.end - best.start) best = scope
  }
  return best
}
