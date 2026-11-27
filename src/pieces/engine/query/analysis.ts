// What every query reads of the file being edited: its tree (a script's program, or a template's
// document and its JavaScript fragments), its facts, and the lookups built once per text (each
// use by its offset, the values assigned to each declaration, the JSDoc of each parameter). The
// text is the editor's, which may be newer than the checkout index: the index is read only for
// other files. Pure: no Node, no Orca.
import type * as AST from '../js/ast'
import { forEachChild, type Comment, type Node, type Range } from '../js/ast'
import { scriptFacts, type Declaration, type Reference, type ScriptFacts } from '../js/facts'
import { parseScript } from '../js/parser'
import { templateScript, type TemplateFragment } from '../isml/embedded'
import { parseTemplate, type IsmlDocument } from '../isml/parser'
import { MAX_PARSED_CHARACTERS } from '../checkout/scan'

export type FileKind = 'script' | 'template'

/** What a path is to the engine: a server script, a template, or neither (null). */
export function fileKind(path: string): FileKind | null {
  if (/\.(js|ds)$/i.test(path)) return 'script'
  if (/\.isml$/i.test(path)) return 'template'
  return null
}

/** A JavaScript root of the file: a script's program, or one fragment of a template. */
export type Root = { node: AST.Program | AST.Expression; start: number; end: number }

export type Analysis = {
  kind: FileKind
  path: string
  text: string
  /** The JavaScript roots: one for a script, one per `${…}` and `<isscript>` of a template. */
  roots: Root[]
  /** A template's document; null for a script. */
  document: IsmlDocument | null
  fragments: TemplateFragment[]
  facts: ScriptFacts
  /** Each use, by the offset it starts at. */
  references: Map<number, Reference>
  /** Each declaration, by the offset its name starts at. */
  declarations: Map<number, Declaration>
  /** The values assigned to a declaration with a plain `=` after it is declared. */
  assigned: Map<number, AST.Expression[]>
  /** Declarations written some other way too (`+=`, `++`, a `for…in` target, a pattern): no one type. */
  rewritten: Set<number>
  /** Declarations bound to a member of a pattern of `require(…)`: `var { price } = require('x')`. */
  requiredMembers: Map<number, { module: string; key: string }>
  /** Declarations whose name is the whole target of their declarator (`var a = …`), not inside a pattern. */
  plain: Set<number>
  /** The JSDoc that documents the function a parameter belongs to, by the parameter's declaration. */
  paramDocs: Map<number, Comment>
  /** Too large to parse: no tree, nothing answers. */
  skipped: boolean
}

/** Reads a file's text once for every query on it. Never throws. */
export function analyse(path: string, text: string): Analysis {
  const kind = fileKind(path) ?? 'script'
  const base = { kind, path, text, roots: [] as Root[], document: null as IsmlDocument | null, fragments: [] as TemplateFragment[] }
  const skipped = text.length > MAX_PARSED_CHARACTERS
  let facts: ScriptFacts
  if (skipped) {
    facts = scriptFacts(parseScript('').program)
  } else if (kind === 'template') {
    const parsed = parseTemplate(text)
    const script = templateScript(text, parsed.document)
    base.document = parsed.document
    base.fragments = script.fragments
    base.roots = script.fragments.map((fragment) => ({ node: fragment.node, start: fragment.start, end: fragment.end }))
    facts = script.facts
  } else {
    const program = parseScript(text).program
    base.roots = [{ node: program, start: 0, end: text.length }]
    facts = scriptFacts(program)
  }
  const analysis: Analysis = {
    ...base,
    facts,
    references: new Map(),
    declarations: new Map(),
    assigned: new Map(),
    rewritten: new Set(),
    requiredMembers: new Map(),
    plain: new Set(),
    paramDocs: new Map(),
    skipped
  }
  for (const reference of facts.references) analysis.references.set(reference.start, reference)
  for (const declaration of facts.declarations) analysis.declarations.set(declaration.start, declaration)
  for (const call of facts.requires) {
    if (call.module === null || call.member !== null || call.binding?.kind !== 'pattern') continue
    for (const name of call.binding.names) if (name.key !== null && name.declaration !== null) analysis.requiredMembers.set(name.declaration, { module: call.module, key: name.key })
  }
  for (const root of analysis.roots) collect(analysis, root.node)
  // A write the walk did not see as a plain `=` is some other kind of write.
  const plainWrites = new Map<number, number>()
  for (const [id, values] of analysis.assigned) plainWrites.set(id, values.length)
  const writes = new Map<number, number>()
  for (const reference of facts.references) if (reference.write && reference.declaration !== null) writes.set(reference.declaration, (writes.get(reference.declaration) ?? 0) + 1)
  for (const [id, count] of writes) if (count !== (plainWrites.get(id) ?? 0)) analysis.rewritten.add(id)
  return analysis
}

/** Walks a root once, with an explicit stack: assignments, declarators, and the JSDoc of each function. */
function collect(analysis: Analysis, root: Node): void {
  const stack: { node: Node; doc: Comment | undefined }[] = [{ node: root, doc: undefined }]
  while (stack.length > 0) {
    const { node, doc } = stack.pop() as { node: Node; doc: Comment | undefined }
    // The JSDoc reaches the function through the statement that holds it: a declaration, an
    // assignment, an object's property, a class's method.
    let passed: Comment | undefined
    switch (node.type) {
      case 'VariableDeclaration':
      case 'ExpressionStatement':
        passed = node.doc
        break
      case 'VariableDeclarator':
      case 'AssignmentExpression':
        passed = doc
        break
      case 'Property':
      case 'MethodDefinition':
        passed = node.doc ?? doc
        break
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const own = node.type === 'FunctionDeclaration' ? (node.doc ?? doc) : doc
        if (own) for (const param of node.params) paramDeclarations(analysis, param, own)
        break
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      const declaration = analysis.declarations.get(node.id.start)
      if (declaration) analysis.plain.add(declaration.id)
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier') {
      const reference = analysis.references.get(node.left.start)
      if (reference && reference.declaration !== null) {
        const list = analysis.assigned.get(reference.declaration)
        if (list) list.push(node.right)
        else analysis.assigned.set(reference.declaration, [node.right])
      }
    }
    const children: Node[] = []
    forEachChild(node, (child) => children.push(child))
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      const keep = passed !== undefined && ((node.type === 'VariableDeclaration' && child.type === 'VariableDeclarator') || (node.type === 'VariableDeclarator' && child === node.init) || (node.type === 'ExpressionStatement' && child === node.expression) || (node.type === 'AssignmentExpression' && child === node.right) || ((node.type === 'Property' || node.type === 'MethodDefinition') && child === node.value))
      stack.push({ node: child, doc: keep ? passed : undefined })
    }
  }
}

function paramDeclarations(analysis: Analysis, param: AST.Pattern, doc: Comment): void {
  let at: AST.Pattern = param
  for (let depth = 0; depth < 8; depth++) {
    if (at.type === 'Identifier') {
      const declaration = analysis.declarations.get(at.start)
      if (declaration) analysis.paramDocs.set(declaration.id, doc)
      return
    }
    if (at.type === 'AssignmentPattern') at = at.left
    else if (at.type === 'RestElement') at = at.argument
    else return
  }
}

// ---------------------------------------------------------------------------------------------
// Where an offset is

/** The root holding an offset (its end included: a cursor at the end of a `${…}` is in it). */
export function rootAt(analysis: Analysis, offset: number): Root | null {
  for (const root of analysis.roots) if (root.start <= offset && offset <= root.end) return root
  return null
}

/**
 * The nodes around an offset, outermost first, ends included: the child taken is the first that
 * holds the offset before its end, else the last that ends at it (so `a.b|` is in `b`).
 */
export function pathAt(root: Node, offset: number): Node[] {
  const path: Node[] = []
  let current: Node | null = root
  for (let guard = 0; current && guard < 10_000; guard++) {
    path.push(current)
    let inside: Node | null = null
    let ending: Node | null = null
    forEachChild(current, (child) => {
      if (inside !== null) return
      if (child.start <= offset && offset < child.end) inside = child
      else if (child.end === offset && child.start <= offset) ending = child
    })
    current = inside ?? ending
  }
  return path
}

/** The identifier characters right before and after an offset: what a completion replaces. */
export function wordAround(text: string, offset: number, pattern = /[\w$]/): Range & { prefix: string } {
  let start = offset
  while (start > 0 && pattern.test(text[start - 1])) start--
  let end = offset
  while (end < text.length && pattern.test(text[end])) end++
  return { start, end, prefix: text.slice(start, offset) }
}

/** A string literal's content range, without its quotes; an unclosed one runs to its end. */
export function stringContent(text: string, literal: Range): Range {
  const quote = text[literal.start]
  const closed = literal.end - literal.start >= 2 && text[literal.end - 1] === quote
  return { start: literal.start + 1, end: Math.max(literal.start + 1, closed ? literal.end - 1 : literal.end) }
}
