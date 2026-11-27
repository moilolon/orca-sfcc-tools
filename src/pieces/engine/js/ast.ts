// The tree the JavaScript parser builds: an ESTree-shaped subset covering the language of SFCC
// scripts (ES5 plus what the platform's Rhino accepts). Every node carries `start` and `end`,
// offsets into the text that was parsed (UTF-16 code units, `end` exclusive). Nodes hold no parent
// pointers, so a tree is plain data. Pure: no Node and no Orca imports.

/** A range of the parsed text: `start` inclusive, `end` exclusive. */
export interface Range {
  start: number
  end: number
}

/** A syntax problem found while lexing or parsing, with its range in the text. */
export interface Problem extends Range {
  /** A stable code, worded by whoever shows it (see `PROBLEM_CODES`). */
  code: ProblemCode
  /** What was expected or found, when that helps (a token such as `)`); never source text beyond a token. */
  detail?: string
}

/** Every problem code the lexers and parsers report. */
export const PROBLEM_CODES = [
  // JavaScript
  'invalid_character',
  'unterminated_string',
  'unterminated_template',
  'unterminated_regex',
  'unterminated_comment',
  'invalid_number',
  'unexpected_token',
  'expected',
  'invalid_assignment_target',
  'invalid_arrow_parameters',
  'too_deep',
  'internal_error',
  // ISML
  'unclosed_tag',
  'unclosed_start_tag',
  'unexpected_close_tag',
  'unclosed_expression',
  'unclosed_comment',
  'unclosed_iscomment',
  'unclosed_isscript',
  'unclosed_attribute_value',
  'unclosed_raw_text'
] as const
export type ProblemCode = (typeof PROBLEM_CODES)[number]

/** A comment of the source. `doc` is a `/** … *\/` block (JSDoc). */
export interface Comment extends Range {
  kind: 'line' | 'block' | 'doc'
  /** The comment's text without its delimiters (`//`, `/*`, `*\/`). */
  text: string
}

// ---------------------------------------------------------------------------------------------
// Expressions

export interface Identifier extends Range {
  type: 'Identifier'
  name: string
}

export interface Literal extends Range {
  type: 'Literal'
  /** The value: a string (escapes decoded), a number, a boolean, null, or for a regex its source. */
  value: string | number | boolean | null
  kind: 'string' | 'number' | 'boolean' | 'null' | 'regex'
  /** For a regular expression: its pattern and flags. */
  regex?: { pattern: string; flags: string }
}

export interface TemplateElement extends Range {
  type: 'TemplateElement'
  /** The text of this chunk with escapes decoded. */
  cooked: string
  tail: boolean
}

export interface TemplateLiteral extends Range {
  type: 'TemplateLiteral'
  quasis: TemplateElement[]
  expressions: Expression[]
}

export interface TaggedTemplateExpression extends Range {
  type: 'TaggedTemplateExpression'
  tag: Expression
  quasi: TemplateLiteral
}

export interface ThisExpression extends Range {
  type: 'ThisExpression'
}

export interface Super extends Range {
  type: 'Super'
}

export interface ArrayExpression extends Range {
  type: 'ArrayExpression'
  /** `null` for a hole (`[a, , b]`). */
  elements: (Expression | SpreadElement | null)[]
}

export interface Property extends Range {
  type: 'Property'
  key: Expression
  /** The value; in a pattern, the target (an `AssignmentPattern` when it has a default). */
  value: Expression | Pattern
  kind: 'init' | 'get' | 'set'
  computed: boolean
  shorthand: boolean
  method: boolean
  /** The JSDoc comment right before the property, if any. */
  doc?: Comment
}

export interface ObjectExpression extends Range {
  type: 'ObjectExpression'
  properties: (Property | SpreadElement)[]
}

export interface FunctionExpression extends Range {
  type: 'FunctionExpression'
  id: Identifier | null
  params: Pattern[]
  body: BlockStatement
  generator: boolean
}

export interface ArrowFunctionExpression extends Range {
  type: 'ArrowFunctionExpression'
  params: Pattern[]
  body: BlockStatement | Expression
  /** True when the body is an expression rather than a block. */
  expression: boolean
}

export interface ClassExpression extends Range {
  type: 'ClassExpression'
  id: Identifier | null
  superClass: Expression | null
  body: ClassBody
}

export interface UnaryExpression extends Range {
  type: 'UnaryExpression'
  operator: '-' | '+' | '!' | '~' | 'typeof' | 'void' | 'delete'
  argument: Expression
}

export interface UpdateExpression extends Range {
  type: 'UpdateExpression'
  operator: '++' | '--'
  prefix: boolean
  argument: Expression
}

export interface BinaryExpression extends Range {
  type: 'BinaryExpression'
  operator: string
  left: Expression
  right: Expression
}

export interface LogicalExpression extends Range {
  type: 'LogicalExpression'
  operator: '||' | '&&' | '??'
  left: Expression
  right: Expression
}

export interface AssignmentExpression extends Range {
  type: 'AssignmentExpression'
  operator: string
  left: Pattern | Expression
  right: Expression
}

export interface ConditionalExpression extends Range {
  type: 'ConditionalExpression'
  test: Expression
  consequent: Expression
  alternate: Expression
}

export interface CallExpression extends Range {
  type: 'CallExpression'
  callee: Expression | Super
  arguments: (Expression | SpreadElement)[]
  optional: boolean
}

export interface NewExpression extends Range {
  type: 'NewExpression'
  callee: Expression
  arguments: (Expression | SpreadElement)[]
}

export interface MemberExpression extends Range {
  type: 'MemberExpression'
  object: Expression | Super
  property: Expression
  computed: boolean
  optional: boolean
}

export interface MetaProperty extends Range {
  type: 'MetaProperty'
  meta: Identifier
  property: Identifier
}

export interface SequenceExpression extends Range {
  type: 'SequenceExpression'
  expressions: Expression[]
}

export interface SpreadElement extends Range {
  type: 'SpreadElement'
  argument: Expression
}

export interface YieldExpression extends Range {
  type: 'YieldExpression'
  argument: Expression | null
  delegate: boolean
}

/** What stands where the parser found no valid expression; a problem is always reported for it. */
export interface InvalidExpression extends Range {
  type: 'InvalidExpression'
}

export type Expression =
  | Identifier
  | Literal
  | TemplateLiteral
  | TaggedTemplateExpression
  | ThisExpression
  | ArrayExpression
  | ObjectExpression
  | FunctionExpression
  | ArrowFunctionExpression
  | ClassExpression
  | UnaryExpression
  | UpdateExpression
  | BinaryExpression
  | LogicalExpression
  | AssignmentExpression
  | ConditionalExpression
  | CallExpression
  | NewExpression
  | MemberExpression
  | MetaProperty
  | SequenceExpression
  | YieldExpression
  | InvalidExpression

// ---------------------------------------------------------------------------------------------
// Patterns (binding and assignment targets)

export interface ObjectPattern extends Range {
  type: 'ObjectPattern'
  properties: (Property | RestElement)[]
}

export interface ArrayPattern extends Range {
  type: 'ArrayPattern'
  elements: (Pattern | null)[]
}

export interface AssignmentPattern extends Range {
  type: 'AssignmentPattern'
  left: Pattern
  right: Expression
}

export interface RestElement extends Range {
  type: 'RestElement'
  argument: Pattern
}

/** A binding target. A `MemberExpression` appears only in assignment targets, never in a declaration. */
export type Pattern = Identifier | ObjectPattern | ArrayPattern | AssignmentPattern | RestElement | MemberExpression | InvalidExpression

// ---------------------------------------------------------------------------------------------
// Statements and declarations

interface Documented {
  /** The JSDoc comment right before the statement, if any (read by type inference later). */
  doc?: Comment
}

export interface ExpressionStatement extends Range, Documented {
  type: 'ExpressionStatement'
  expression: Expression
}

export interface BlockStatement extends Range {
  type: 'BlockStatement'
  body: Statement[]
}

export interface EmptyStatement extends Range {
  type: 'EmptyStatement'
}

export interface DebuggerStatement extends Range {
  type: 'DebuggerStatement'
}

export interface WithStatement extends Range {
  type: 'WithStatement'
  object: Expression
  body: Statement
}

export interface ReturnStatement extends Range {
  type: 'ReturnStatement'
  argument: Expression | null
}

export interface LabeledStatement extends Range {
  type: 'LabeledStatement'
  label: Identifier
  body: Statement
}

export interface BreakStatement extends Range {
  type: 'BreakStatement'
  label: Identifier | null
}

export interface ContinueStatement extends Range {
  type: 'ContinueStatement'
  label: Identifier | null
}

export interface IfStatement extends Range {
  type: 'IfStatement'
  test: Expression
  consequent: Statement
  alternate: Statement | null
}

export interface SwitchCase extends Range {
  type: 'SwitchCase'
  /** `null` for `default:`. */
  test: Expression | null
  consequent: Statement[]
}

export interface SwitchStatement extends Range {
  type: 'SwitchStatement'
  discriminant: Expression
  cases: SwitchCase[]
}

export interface ThrowStatement extends Range {
  type: 'ThrowStatement'
  argument: Expression
}

export interface CatchClause extends Range {
  type: 'CatchClause'
  param: Pattern | null
  /** Rhino's conditional catch: `catch (e if e instanceof Error)`. */
  guard: Expression | null
  body: BlockStatement
}

export interface TryStatement extends Range {
  type: 'TryStatement'
  block: BlockStatement
  handler: CatchClause | null
  finalizer: BlockStatement | null
}

export interface WhileStatement extends Range {
  type: 'WhileStatement'
  test: Expression
  body: Statement
}

export interface DoWhileStatement extends Range {
  type: 'DoWhileStatement'
  body: Statement
  test: Expression
}

export interface ForStatement extends Range {
  type: 'ForStatement'
  init: VariableDeclaration | Expression | null
  test: Expression | null
  update: Expression | null
  body: Statement
}

export interface ForInStatement extends Range {
  type: 'ForInStatement'
  left: VariableDeclaration | Pattern
  right: Expression
  body: Statement
  /** Rhino's `for each (x in list)`: iterates values. */
  each: boolean
}

export interface ForOfStatement extends Range {
  type: 'ForOfStatement'
  left: VariableDeclaration | Pattern
  right: Expression
  body: Statement
}

export interface FunctionDeclaration extends Range, Documented {
  type: 'FunctionDeclaration'
  /** `null` only where the name is missing in broken input. */
  id: Identifier | null
  params: Pattern[]
  body: BlockStatement
  generator: boolean
}

export interface VariableDeclarator extends Range {
  type: 'VariableDeclarator'
  id: Pattern
  init: Expression | null
}

export interface VariableDeclaration extends Range, Documented {
  type: 'VariableDeclaration'
  kind: 'var' | 'let' | 'const'
  declarations: VariableDeclarator[]
}

export interface MethodDefinition extends Range {
  type: 'MethodDefinition'
  key: Expression
  value: FunctionExpression
  kind: 'constructor' | 'method' | 'get' | 'set'
  computed: boolean
  static: boolean
  doc?: Comment
}

export interface ClassBody extends Range {
  type: 'ClassBody'
  body: MethodDefinition[]
}

export interface ClassDeclaration extends Range, Documented {
  type: 'ClassDeclaration'
  id: Identifier | null
  superClass: Expression | null
  body: ClassBody
}

export type Statement =
  | ExpressionStatement
  | BlockStatement
  | EmptyStatement
  | DebuggerStatement
  | WithStatement
  | ReturnStatement
  | LabeledStatement
  | BreakStatement
  | ContinueStatement
  | IfStatement
  | SwitchStatement
  | ThrowStatement
  | TryStatement
  | WhileStatement
  | DoWhileStatement
  | ForStatement
  | ForInStatement
  | ForOfStatement
  | FunctionDeclaration
  | VariableDeclaration
  | ClassDeclaration

export interface Program extends Range {
  type: 'Program'
  body: Statement[]
}

/** Every node type of the tree. */
export type Node =
  | Program
  | Statement
  | Expression
  | Pattern
  | Super
  | Property
  | SpreadElement
  | TemplateElement
  | SwitchCase
  | CatchClause
  | VariableDeclarator
  | MethodDefinition
  | ClassBody

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'

/** Calls `visit` on each direct child node of `node`, in source order. */
export function forEachChild(node: Node, visit: (child: Node) => void): void {
  for (const key in node) {
    if (key === 'doc' || key === 'regex') continue
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item)
    } else if (isNode(value)) {
      visit(value)
    }
  }
}

/**
 * Calls `visit` on `root` and every node below it, in source order, with an explicit stack: a
 * tree can be as deep as its input (an `else if` chain nests one level per link), so a walker
 * that recurses once per level can overflow. Use this, or a stack of your own.
 */
export function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Node
    visit(node)
    const children: Node[] = []
    forEachChild(node, (child) => children.push(child))
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
}

/** The innermost node whose range holds `offset` (start inclusive, end exclusive), and its ancestors. */
export function nodePathAt(root: Node, offset: number): Node[] {
  const path: Node[] = []
  let current: Node | null = root
  while (current) {
    path.push(current)
    let next: Node | null = null
    forEachChild(current, (child) => {
      if (next === null && child.start <= offset && offset < child.end) next = child
    })
    current = next
  }
  return path
}
