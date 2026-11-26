// The tolerant JavaScript parser: recursive descent over the lexer, for the language of SFCC
// scripts (ES5 plus what Rhino accepts: `const`/`let`, arrow functions, template strings,
// destructuring, spread, default parameters, classes, `for…of`, Rhino's `for each` and
// conditional `catch`). It never throws: on any input it returns a tree and a list of problems.
// Where a token is missing it reports it and goes on as if it were there; where a statement
// cannot be read it reports once and skips to the next statement boundary (a `;`, the `}` that
// closes the block, or a token on a new line). Every node has its `start` and `end` offsets.
// JSDoc comments are attached (`doc`) to the statement, property or class member that follows.
// Pure: no Node, no Orca.
import type * as AST from './ast'
import type { Comment, Expression, Pattern, Problem, ProblemCode, Statement } from './ast'
import { forEachChild } from './ast'
import { Lexer, type Token } from './lexer'

export interface ParseOptions {
  /** Where to start reading `text` (default 0): positions stay offsets of the whole text. */
  start?: number
  /** Where to stop (default the end of `text`). */
  end?: number
}

export interface ScriptParse {
  program: AST.Program
  comments: Comment[]
  problems: Problem[]
}

export interface ExpressionParse {
  expression: Expression
  comments: Comment[]
  problems: Problem[]
}

/** Parses a script. Never throws. */
export function parseScript(text: string, options: ParseOptions = {}): ScriptParse {
  const parser = new Parser(text, options)
  const body: Statement[] = []
  const start = options.start ?? 0
  try {
    parser.parseStatementList(false, false, body)
  } catch {
    // Not expected: the parser bounds its own depth. Keep what was read.
    parser.report('internal_error', parser.tok.start, parser.tok.start)
  }
  const end = Math.min(options.end ?? text.length, text.length)
  const program: AST.Program = { type: 'Program', start, end, body }
  if (parser.problems.length > 0) coverChildren(program)
  return { program, comments: parser.comments, problems: parser.problems }
}

/**
 * Widens each node's range to hold its children. Only broken input needs it: a missing
 * expression stands as an empty node at the token where it was expected, which can lie past the
 * end of the node around it.
 */
function coverChildren(root: AST.Node): void {
  // Breadth first into a list (no recursion), then children before parents.
  const nodes: AST.Node[] = [root]
  const parents: number[] = [-1]
  for (let i = 0; i < nodes.length; i++) {
    forEachChild(nodes[i], (child) => {
      nodes.push(child)
      parents.push(i)
    })
  }
  for (let i = nodes.length - 1; i > 0; i--) {
    const node = nodes[i]
    const parent = nodes[parents[i]]
    if (node.start < parent.start) parent.start = node.start
    if (node.end > parent.end) parent.end = node.end
  }
}

/** Parses one expression (the inside of an ISML `${…}`). Never throws. */
export function parseExpression(text: string, options: ParseOptions = {}): ExpressionParse {
  const parser = new Parser(text, options)
  let expression: Expression
  try {
    expression = parser.parseExpression(false)
    if (parser.tok.type !== 'eof') {
      parser.report('unexpected_token', parser.tok.start, parser.tok.end, parser.describe(parser.tok))
    }
    if (parser.problems.length > 0) coverChildren(expression)
  } catch {
    parser.report('internal_error', parser.tok.start, parser.tok.start)
    const at = options.start ?? 0
    expression = { type: 'InvalidExpression', start: at, end: at }
  }
  return { expression, comments: parser.comments, problems: parser.problems }
}

/** How deep the parser may recurse (statements, assignments, operands) before it stops descending. */
export const MAX_DEPTH = 200

/**
 * How deep the tree may grow, counting each link of a chain (`a.b.c`, `a + b + c`, `f()()`) as a
 * level as well as each recursion: a chain is read in a loop, but its tree nests, and whoever
 * walks the tree recursively must be able to.
 */
export const MAX_TREE_DEPTH = 1000

const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??='])

const BINARY_PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '|': 4,
  '^': 5,
  '&': 6,
  '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, instanceof: 8, in: 8,
  '<<': 9, '>>': 9, '>>>': 9,
  '+': 10, '-': 10,
  '*': 11, '/': 11, '%': 11,
  '**': 12
}

// Keywords that start a statement: never swallowed as a name where an expression is missing.
const STATEMENT_KEYWORDS = new Set([
  'var', 'const', 'function', 'class', 'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue',
  'throw', 'try', 'catch', 'finally', 'switch', 'case', 'default', 'with', 'debugger', 'import', 'export'
])

class Parser {
  readonly lexer: Lexer
  readonly comments: Comment[] = []
  readonly problems: Problem[] = []
  tok: Token
  /** The token before `tok`. */
  private prev: Token | null = null
  private ahead: Token | null = null
  private prevEnd: number
  private depth = 0
  private treeDepth = 0
  private inGenerator = false
  /** Set when a problem is reported; a statement list then skips to the next boundary. */
  private pendingError = false
  /** Arrow functions read without parentheses around them: nothing chains onto them. */
  private readonly bareArrows = new WeakSet<object>()

  constructor(text: string, options: ParseOptions) {
    const start = options.start ?? 0
    this.lexer = new Lexer(text, start, options.end ?? text.length, this.comments, this.problems)
    this.prevEnd = start
    this.tok = this.lexer.next()
  }

  // -------------------------------------------------------------------------------------------
  // Tokens

  private next(): void {
    this.prev = this.tok
    this.prevEnd = this.tok.end
    if (this.ahead) {
      this.tok = this.ahead
      this.ahead = null
    } else {
      this.tok = this.lexer.next()
    }
  }

  private peek(): Token {
    if (!this.ahead) this.ahead = this.lexer.next()
    return this.ahead
  }

  /** The token after the current one is the punctuator `value`. */
  private peekIs(value: string): boolean {
    const t = this.peek()
    return t.type === 'punctuator' && t.value === value
  }

  /** The current token is the punctuator or keyword `value`. */
  private at(value: string): boolean {
    const t = this.tok
    return t.value === value && (t.type === 'punctuator' || t.type === 'keyword')
  }

  /** The current token is the identifier `name` (a contextual word: `let`, `of`, `get`, …). */
  private atName(name: string): boolean {
    return this.tok.type === 'identifier' && this.tok.value === name
  }

  private eat(value: string): boolean {
    if (!this.at(value)) return false
    this.next()
    return true
  }

  private expect(value: string): boolean {
    if (this.eat(value)) return true
    this.report('expected', this.tok.start, this.tok.end, value)
    return false
  }

  report(code: ProblemCode, start: number, end: number, detail?: string): void {
    this.lexer.report(code, start, end, detail)
    this.pendingError = true
  }

  /** A short word for a token, for a problem's detail: its text when it is a punctuator or keyword. */
  describe(token: Token): string {
    if (token.type === 'punctuator' || token.type === 'keyword') return token.value
    if (token.type === 'eof') return 'end of input'
    return token.type
  }

  private unexpected(): void {
    const t = this.tok
    if (t.type === 'eof') this.report('expected', t.start, t.start, 'expression')
    else if (t.type !== 'invalid') this.report('unexpected_token', t.start, t.end, this.describe(t))
    else this.pendingError = true
  }

  private consumeSemicolon(): void {
    if (this.eat(';')) return
    if (this.at('}') || this.tok.type === 'eof' || this.tok.newlineBefore) return
    this.report('expected', this.tok.start, this.tok.end, ';')
  }

  private invalid(start: number, end: number): AST.InvalidExpression {
    return { type: 'InvalidExpression', start, end }
  }

  // -------------------------------------------------------------------------------------------
  // Statements

  /** Reads statements into `body` until the end, or a `}` when `inBlock`, or a `case` when `inCase`. */
  parseStatementList(inBlock: boolean, inCase: boolean, body: Statement[] = []): Statement[] {
    while (this.tok.type !== 'eof') {
      if (inBlock && this.at('}')) break
      if (inCase && (this.at('case') || this.at('default'))) break
      const before = this.tok
      this.pendingError = false
      const statement = this.parseStatement()
      if (this.tok === before) {
        // Nothing could be read here: report it once and step over the token.
        if (this.at('}') && !inBlock) this.report('unexpected_token', before.start, before.end, '}')
        else this.unexpected()
        this.next()
      } else {
        body.push(statement)
      }
      if (this.pendingError) this.recover(inBlock)
    }
    this.pendingError = false
    return body
  }

  /** Skips to the next statement boundary after a problem. */
  private recover(inBlock: boolean): void {
    // A statement that reported a problem but ended on its `;` or `}` needs no skipping.
    const prev = this.prev
    if (prev && prev.type === 'punctuator' && (prev.value === ';' || prev.value === '}') && prev.end === this.prevEnd) {
      this.pendingError = false
      return
    }
    const first = this.tok
    let braces = 0
    while (this.tok.type !== 'eof') {
      if (braces === 0) {
        if (this.at(';')) {
          this.next()
          break
        }
        if (this.at('}')) {
          if (inBlock) break
          this.next()
          continue
        }
        if (this.tok.newlineBefore || (this.tok !== first && this.startsStatement())) break
      }
      if (this.at('{')) braces++
      else if (this.at('}')) braces--
      this.next()
    }
    this.pendingError = false
  }

  private startsStatement(): boolean {
    return this.tok.type === 'keyword' && STATEMENT_KEYWORDS.has(this.tok.value) && this.tok.value !== 'else' && this.tok.value !== 'catch' && this.tok.value !== 'finally'
  }

  private parseStatement(): Statement {
    const t = this.tok
    const start = t.start
    if (!this.enter()) return { type: 'EmptyStatement', start, end: this.prevEnd }
    try {
      const statement = this.parseStatementInner()
      if (t.doc && statement.start === start) {
        switch (statement.type) {
          case 'FunctionDeclaration':
          case 'VariableDeclaration':
          case 'ClassDeclaration':
          case 'ExpressionStatement':
            statement.doc = t.doc
        }
      }
      return statement
    } finally {
      this.leave()
    }
  }

  /**
   * One level deeper. Past the limits it reports `too_deep` once, steps over the current token
   * (so the caller's loop moves on) and answers false: the caller then returns an empty node.
   */
  private enter(): boolean {
    if (this.depth >= MAX_DEPTH || this.treeDepth >= MAX_TREE_DEPTH) {
      const t = this.tok
      this.report('too_deep', t.start, t.end)
      if (t.type !== 'eof') this.next()
      return false
    }
    this.depth++
    this.treeDepth++
    return true
  }

  private leave(): void {
    this.depth--
    this.treeDepth--
  }

  /** One more link of a chain read in a loop; false past the tree's limit, where the chain stops. */
  private link(): boolean {
    if (this.treeDepth >= MAX_TREE_DEPTH) {
      this.report('too_deep', this.tok.start, this.tok.end)
      return false
    }
    this.treeDepth++
    return true
  }

  private parseStatementInner(): Statement {
    const t = this.tok
    const start = t.start
    if (t.type === 'punctuator') {
      if (t.value === '{') return this.parseBlock()
      if (t.value === ';') {
        this.next()
        return { type: 'EmptyStatement', start, end: this.prevEnd }
      }
    } else if (t.type === 'keyword') {
      switch (t.value) {
        case 'var':
        case 'const': {
          const declaration = this.parseVariableDeclaration(t.value, false)
          this.consumeSemicolon()
          declaration.end = this.prevEnd
          return declaration
        }
        case 'function':
          return this.parseFunction(true) as AST.FunctionDeclaration
        case 'class':
          return this.parseClass(true) as AST.ClassDeclaration
        case 'if':
          return this.parseIf()
        case 'for':
          return this.parseFor()
        case 'while': {
          this.next()
          const test = this.parseParenthesizedCondition()
          const body = this.parseStatement()
          return { type: 'WhileStatement', test, body, start, end: this.prevEnd }
        }
        case 'do': {
          this.next()
          const body = this.parseStatement()
          this.expect('while')
          const test = this.parseParenthesizedCondition()
          this.eat(';')
          return { type: 'DoWhileStatement', body, test, start, end: this.prevEnd }
        }
        case 'return': {
          this.next()
          let argument: Expression | null = null
          if (!this.at(';') && !this.at('}') && this.tok.type !== 'eof' && !this.tok.newlineBefore) argument = this.parseExpression(false)
          this.consumeSemicolon()
          return { type: 'ReturnStatement', argument, start, end: this.prevEnd }
        }
        case 'break':
        case 'continue': {
          this.next()
          let label: AST.Identifier | null = null
          if (this.tok.type === 'identifier' && !this.tok.newlineBefore) label = this.parseIdentifier()
          this.consumeSemicolon()
          return { type: t.value === 'break' ? 'BreakStatement' : 'ContinueStatement', label, start, end: this.prevEnd }
        }
        case 'throw': {
          this.next()
          const argument = this.parseExpression(false)
          this.consumeSemicolon()
          return { type: 'ThrowStatement', argument, start, end: this.prevEnd }
        }
        case 'try':
          return this.parseTry()
        case 'switch':
          return this.parseSwitch()
        case 'with': {
          this.next()
          const object = this.parseParenthesizedCondition()
          const body = this.parseStatement()
          return { type: 'WithStatement', object, body, start, end: this.prevEnd }
        }
        case 'debugger':
          this.next()
          this.consumeSemicolon()
          return { type: 'DebuggerStatement', start, end: this.prevEnd }
      }
    } else if (t.type === 'identifier') {
      if (t.value === 'let') {
        const after = this.peek()
        if (after.type === 'identifier' || (after.type === 'punctuator' && (after.value === '[' || after.value === '{'))) {
          const declaration = this.parseVariableDeclaration('let', false)
          this.consumeSemicolon()
          declaration.end = this.prevEnd
          return declaration
        }
      }
      if (this.peekIs(':')) {
        const label = this.parseIdentifier()
        this.next() // :
        const body = this.parseStatement()
        return { type: 'LabeledStatement', label, body, start, end: this.prevEnd }
      }
    }
    if (t.type === 'keyword' && (t.value === 'else' || t.value === 'catch' || t.value === 'finally' || t.value === 'case' || t.value === 'default')) {
      // A clause with nothing to belong to: nothing is read, and the list reports it.
      return { type: 'EmptyStatement', start, end: start }
    }
    const expression = this.parseExpression(false)
    if (this.tok === t) return { type: 'ExpressionStatement', expression, start, end: start }
    this.consumeSemicolon()
    return { type: 'ExpressionStatement', expression, start, end: this.prevEnd }
  }

  private parseBlock(): AST.BlockStatement {
    const start = this.tok.start
    if (!this.at('{')) {
      this.report('expected', this.tok.start, this.tok.end, '{')
      return { type: 'BlockStatement', body: [], start, end: start }
    }
    this.next()
    const body = this.parseStatementList(true, false)
    this.expect('}')
    return { type: 'BlockStatement', body, start, end: this.prevEnd }
  }

  private parseParenthesizedCondition(): Expression {
    this.expect('(')
    const test = this.parseExpression(false)
    this.expect(')')
    return test
  }

  private parseVariableDeclaration(kind: 'var' | 'let' | 'const', noIn: boolean): AST.VariableDeclaration {
    const start = this.tok.start
    this.next()
    const declarations: AST.VariableDeclarator[] = []
    for (;;) {
      const declStart = this.tok.start
      const id = this.parseBindingTarget()
      let init: Expression | null = null
      if (this.eat('=')) init = this.parseAssignment(noIn)
      declarations.push({ type: 'VariableDeclarator', id, init, start: declStart, end: this.prevEnd })
      if (!this.eat(',')) break
    }
    return { type: 'VariableDeclaration', kind, declarations, start, end: this.prevEnd }
  }

  private parseIf(): AST.IfStatement {
    // An `else if` chain is read in a loop, so a long chain never deepens the recursion.
    const chain: AST.IfStatement[] = []
    let start = this.tok.start
    this.next()
    for (;;) {
      const test = this.parseParenthesizedCondition()
      const consequent = this.parseStatement()
      const node: AST.IfStatement = { type: 'IfStatement', test, consequent, alternate: null, start, end: this.prevEnd }
      if (chain.length > 0) chain[chain.length - 1].alternate = node
      chain.push(node)
      if (!this.eat('else')) break
      if (this.at('if')) {
        start = this.tok.start
        this.next()
        continue
      }
      node.alternate = this.parseStatement()
      break
    }
    for (const node of chain) node.end = this.prevEnd
    return chain[0]
  }

  private parseFor(): Statement {
    const start = this.tok.start
    this.next()
    let each = false
    if (this.atName('each')) {
      each = true
      this.next()
    }
    this.expect('(')
    let init: AST.VariableDeclaration | Expression | null = null
    if (this.at('var') || this.at('const') || (this.atName('let') && (this.peek().type === 'identifier' || this.peekIs('[') || this.peekIs('{')))) {
      init = this.parseVariableDeclaration(this.tok.value as 'var' | 'let' | 'const', true)
    } else if (!this.at(';')) {
      init = this.parseExpression(true)
    }
    if (init && (this.at('in') || this.atName('of'))) {
      const of = this.atName('of')
      const left: AST.VariableDeclaration | Pattern = init.type === 'VariableDeclaration' ? init : this.toAssignTarget(init)
      this.next()
      const right = of ? this.parseAssignment(false) : this.parseExpression(false)
      this.expect(')')
      const body = this.parseStatement()
      if (of) return { type: 'ForOfStatement', left, right, body, start, end: this.prevEnd }
      return { type: 'ForInStatement', left, right, body, each, start, end: this.prevEnd }
    }
    this.expect(';')
    const test = this.at(';') ? null : this.parseExpression(false)
    this.expect(';')
    const update = this.at(')') ? null : this.parseExpression(false)
    this.expect(')')
    const body = this.parseStatement()
    return { type: 'ForStatement', init, test, update, body, start, end: this.prevEnd }
  }

  private parseTry(): AST.TryStatement {
    const start = this.tok.start
    this.next()
    const block = this.parseBlock()
    let handler: AST.CatchClause | null = null
    let finalizer: AST.BlockStatement | null = null
    if (this.at('catch')) {
      const catchStart = this.tok.start
      this.next()
      let param: Pattern | null = null
      let guard: Expression | null = null
      if (this.eat('(')) {
        param = this.parseBindingTarget()
        if (this.eat('if')) guard = this.parseExpression(false)
        this.expect(')')
      }
      const body = this.parseBlock()
      handler = { type: 'CatchClause', param, guard, body, start: catchStart, end: this.prevEnd }
    }
    if (this.eat('finally')) finalizer = this.parseBlock()
    if (!handler && !finalizer) this.report('expected', this.tok.start, this.tok.end, 'catch')
    return { type: 'TryStatement', block, handler, finalizer, start, end: this.prevEnd }
  }

  private parseSwitch(): AST.SwitchStatement {
    const start = this.tok.start
    this.next()
    const discriminant = this.parseParenthesizedCondition()
    const cases: AST.SwitchCase[] = []
    if (this.expect('{')) {
      while (this.tok.type !== 'eof' && !this.at('}')) {
        const caseStart = this.tok.start
        let test: Expression | null = null
        if (this.eat('case')) {
          test = this.parseExpression(false)
        } else if (!this.eat('default')) {
          this.unexpected()
          this.next()
          continue
        }
        this.expect(':')
        const consequent = this.parseStatementList(true, true)
        cases.push({ type: 'SwitchCase', test, consequent, start: caseStart, end: this.prevEnd })
      }
      this.expect('}')
    }
    return { type: 'SwitchStatement', discriminant, cases, start, end: this.prevEnd }
  }

  // -------------------------------------------------------------------------------------------
  // Functions and classes

  private parseFunction(declaration: boolean): AST.FunctionDeclaration | AST.FunctionExpression {
    const start = this.tok.start
    this.next() // function
    const generator = this.eat('*')
    let id: AST.Identifier | null = null
    if (this.tok.type === 'identifier') id = this.parseIdentifier()
    else if (declaration) this.report('expected', this.tok.start, this.tok.end, 'name')
    const { params, body } = this.parseFunctionRest(generator)
    return { type: declaration ? 'FunctionDeclaration' : 'FunctionExpression', id, params, body, generator, start, end: this.prevEnd } as
      | AST.FunctionDeclaration
      | AST.FunctionExpression
  }

  private parseFunctionRest(generator: boolean): { params: Pattern[]; body: AST.BlockStatement } {
    const outer = this.inGenerator
    this.inGenerator = generator
    try {
      const params = this.parseParams()
      const body = this.parseBlock()
      return { params, body }
    } finally {
      this.inGenerator = outer
    }
  }

  private parseParams(): Pattern[] {
    const params: Pattern[] = []
    if (!this.expect('(')) return params
    while (!this.at(')') && this.tok.type !== 'eof') {
      const before = this.tok
      if (this.at('...')) {
        const start = this.tok.start
        this.next()
        const argument = this.parseBindingTarget()
        params.push({ type: 'RestElement', argument, start, end: this.prevEnd })
      } else {
        params.push(this.parseBindingElement())
      }
      if (this.tok === before) break
      if (!this.eat(',')) break
    }
    this.expect(')')
    return params
  }

  private parseClass(declaration: boolean): AST.ClassDeclaration | AST.ClassExpression {
    const start = this.tok.start
    this.next() // class
    let id: AST.Identifier | null = null
    if (this.tok.type === 'identifier') id = this.parseIdentifier()
    else if (declaration) this.report('expected', this.tok.start, this.tok.end, 'name')
    let superClass: Expression | null = null
    if (this.eat('extends')) superClass = this.parseCallOrMember()
    const bodyStart = this.tok.start
    const members: AST.MethodDefinition[] = []
    if (this.expect('{')) {
      while (this.tok.type !== 'eof' && !this.at('}')) {
        if (this.eat(';')) continue
        const before = this.tok
        const member = this.parseClassMember()
        if (member) members.push(member)
        if (this.tok === before) {
          this.unexpected()
          this.next()
        }
      }
      this.expect('}')
    }
    const body: AST.ClassBody = { type: 'ClassBody', body: members, start: bodyStart, end: this.prevEnd }
    return { type: declaration ? 'ClassDeclaration' : 'ClassExpression', id, superClass, body, start, end: this.prevEnd } as AST.ClassDeclaration | AST.ClassExpression
  }

  private parseClassMember(): AST.MethodDefinition | null {
    const start = this.tok.start
    const doc = this.tok.doc
    let isStatic = false
    if (this.atName('static') && !this.peekIs('(')) {
      isStatic = true
      this.next()
    }
    let kind: AST.MethodDefinition['kind'] = 'method'
    if ((this.atName('get') || this.atName('set')) && !this.peekIs('(')) {
      kind = this.tok.value as 'get' | 'set'
      this.next()
    }
    const generator = this.eat('*')
    const before = this.tok
    const { key, computed } = this.parsePropertyKey()
    if (this.tok === before) return null
    if (!this.at('(')) {
      this.report('expected', this.tok.start, this.tok.end, '(')
      // Skip what is left of this member.
      while (this.tok.type !== 'eof' && !this.at('}') && !this.at(';') && !this.tok.newlineBefore) this.next()
      return null
    }
    if (!computed && kind === 'method' && key.type === 'Identifier' && key.name === 'constructor') kind = 'constructor'
    const value = this.parseMethod(generator)
    const member: AST.MethodDefinition = { type: 'MethodDefinition', key, value, kind, computed, static: isStatic, start, end: this.prevEnd }
    if (doc) member.doc = doc
    return member
  }

  private parseMethod(generator: boolean): AST.FunctionExpression {
    const start = this.tok.start
    const { params, body } = this.parseFunctionRest(generator)
    return { type: 'FunctionExpression', id: null, params, body, generator, start, end: this.prevEnd }
  }

  // -------------------------------------------------------------------------------------------
  // Patterns

  private parseBindingTarget(): Pattern {
    const t = this.tok
    if (t.type === 'identifier') return this.parseIdentifier()
    if (t.type === 'keyword' && !t.newlineBefore && !STATEMENT_KEYWORDS.has(t.value)) {
      // A reserved word used as a name: reported, and read as the name it was meant to be.
      this.report('unexpected_token', t.start, t.end, t.value)
      this.next()
      return { type: 'Identifier', name: t.value, start: t.start, end: t.end }
    }
    if (this.at('[')) return this.parseArrayPattern()
    if (this.at('{')) return this.parseObjectPattern()
    this.report('expected', t.start, t.end, 'name')
    return this.invalid(t.start, t.start)
  }

  private parseBindingElement(): Pattern {
    const start = this.tok.start
    const target = this.parseBindingTarget()
    if (!this.eat('=')) return target
    const right = this.parseAssignment(false)
    return { type: 'AssignmentPattern', left: target, right, start, end: this.prevEnd }
  }

  private parseArrayPattern(): AST.ArrayPattern {
    const start = this.tok.start
    this.next()
    const elements: (Pattern | null)[] = []
    while (!this.at(']') && this.tok.type !== 'eof') {
      if (this.at(',')) {
        this.next()
        elements.push(null)
        continue
      }
      const before = this.tok
      if (this.at('...')) {
        const restStart = this.tok.start
        this.next()
        const argument = this.parseBindingTarget()
        elements.push({ type: 'RestElement', argument, start: restStart, end: this.prevEnd })
      } else {
        elements.push(this.parseBindingElement())
      }
      if (this.tok === before || !this.eat(',')) break
    }
    this.expect(']')
    return { type: 'ArrayPattern', elements, start, end: this.prevEnd }
  }

  private parseObjectPattern(): AST.ObjectPattern {
    const start = this.tok.start
    this.next()
    const properties: (AST.Property | AST.RestElement)[] = []
    while (!this.at('}') && this.tok.type !== 'eof') {
      const before = this.tok
      const propStart = this.tok.start
      if (this.at('...')) {
        this.next()
        const argument = this.parseBindingTarget()
        properties.push({ type: 'RestElement', argument, start: propStart, end: this.prevEnd })
      } else {
        const { key, computed } = this.parsePropertyKey()
        if (this.tok === before) break
        let value: Pattern
        let shorthand = false
        if (this.eat(':')) {
          value = this.parseBindingElement()
        } else if (key.type === 'Identifier' && !computed) {
          shorthand = true
          const name: AST.Identifier = { type: 'Identifier', name: key.name, start: key.start, end: key.end }
          if (this.eat('=')) {
            const right = this.parseAssignment(false)
            value = { type: 'AssignmentPattern', left: name, right, start: key.start, end: this.prevEnd }
          } else {
            value = name
          }
        } else {
          this.report('expected', this.tok.start, this.tok.end, ':')
          value = this.invalid(this.tok.start, this.tok.start)
        }
        properties.push({ type: 'Property', key, value, kind: 'init', computed, shorthand, method: false, start: propStart, end: this.prevEnd })
      }
      if (!this.eat(',')) break
    }
    this.expect('}')
    return { type: 'ObjectPattern', properties, start, end: this.prevEnd }
  }

  /** Turns an expression read before `=` (or `in`/`of`) into the target it stands for. */
  private toAssignTarget(expression: Expression | AST.SpreadElement | Pattern): Pattern {
    switch (expression.type) {
      case 'Identifier':
      case 'MemberExpression':
      case 'InvalidExpression':
      case 'ObjectPattern':
      case 'ArrayPattern':
      case 'AssignmentPattern':
      case 'RestElement':
        return expression
      case 'ArrayExpression':
        return {
          type: 'ArrayPattern',
          elements: expression.elements.map((element) => (element === null ? null : this.toAssignTarget(element))),
          start: expression.start,
          end: expression.end
        }
      case 'ObjectExpression':
        return {
          type: 'ObjectPattern',
          properties: expression.properties.map((property): AST.Property | AST.RestElement =>
            property.type === 'SpreadElement'
              ? { type: 'RestElement', argument: this.toAssignTarget(property.argument), start: property.start, end: property.end }
              : { ...property, value: this.toAssignTarget(property.value) }
          ),
          start: expression.start,
          end: expression.end
        }
      case 'AssignmentExpression':
        if (expression.operator === '=') {
          return { type: 'AssignmentPattern', left: this.toAssignTarget(expression.left), right: expression.right, start: expression.start, end: expression.end }
        }
        break
      case 'SpreadElement':
        return { type: 'RestElement', argument: this.toAssignTarget(expression.argument), start: expression.start, end: expression.end }
    }
    this.report('invalid_assignment_target', expression.start, expression.end)
    return this.invalid(expression.start, expression.end)
  }

  // -------------------------------------------------------------------------------------------
  // Expressions

  parseExpression(noIn: boolean): Expression {
    const start = this.tok.start
    const first = this.parseAssignment(noIn)
    if (!this.at(',')) return first
    const expressions = [first]
    while (this.eat(',')) expressions.push(this.parseAssignment(noIn))
    return { type: 'SequenceExpression', expressions, start, end: this.prevEnd }
  }

  private parseAssignment(noIn: boolean): Expression {
    const start = this.tok.start
    if (!this.enter()) return this.invalid(start, this.prevEnd)
    try {
      return this.parseAssignmentInner(noIn, start)
    } finally {
      this.leave()
    }
  }

  private parseAssignmentInner(noIn: boolean, start: number): Expression {
    if (this.atName('yield') && this.inGenerator) return this.parseYield()
    const left = this.parseConditional(noIn)
    if (this.bareArrows.has(left)) return left
    const t = this.tok
    if (t.type === 'punctuator' && ASSIGNMENT_OPERATORS.has(t.value)) {
      let target: Pattern | Expression
      if (t.value === '=') {
        target = this.toAssignTarget(left)
      } else {
        target = left
        if (left.type !== 'Identifier' && left.type !== 'MemberExpression' && left.type !== 'InvalidExpression') {
          this.report('invalid_assignment_target', left.start, left.end)
        }
      }
      this.next()
      const right = this.parseAssignment(noIn)
      return { type: 'AssignmentExpression', operator: t.value, left: target, right, start, end: this.prevEnd }
    }
    return left
  }

  private parseYield(): AST.YieldExpression {
    const start = this.tok.start
    this.next()
    const delegate = this.eat('*')
    let argument: Expression | null = null
    const t = this.tok
    const ends = t.type === 'eof' || t.newlineBefore || (t.type === 'punctuator' && [')', ']', '}', ',', ';', ':'].includes(t.value))
    if (!ends || delegate) argument = this.parseAssignment(false)
    return { type: 'YieldExpression', argument, delegate, start, end: this.prevEnd }
  }

  private parseConditional(noIn: boolean): Expression {
    const start = this.tok.start
    const test = this.parseBinary(0, noIn)
    if (this.bareArrows.has(test) || !this.at('?')) return test
    this.next()
    const consequent = this.parseAssignment(false)
    this.expect(':')
    const alternate = this.parseAssignment(noIn)
    return { type: 'ConditionalExpression', test, consequent, alternate, start, end: this.prevEnd }
  }

  private binaryOperator(noIn: boolean): string | null {
    const t = this.tok
    if (t.type === 'punctuator') return BINARY_PRECEDENCE[t.value] !== undefined ? t.value : null
    if (t.type === 'keyword' && (t.value === 'instanceof' || (t.value === 'in' && !noIn))) return t.value
    return null
  }

  private parseBinary(minPrecedence: number, noIn: boolean): Expression {
    const start = this.tok.start
    let left = this.parseUnary()
    if (this.bareArrows.has(left)) return left
    let links = 0
    for (;;) {
      const operator = this.binaryOperator(noIn)
      if (operator === null) break
      const precedence = BINARY_PRECEDENCE[operator]
      if (precedence < minPrecedence || !this.link()) break
      links++
      this.next()
      const right = this.parseBinary(operator === '**' ? precedence : precedence + 1, noIn)
      if (operator === '||' || operator === '&&' || operator === '??') {
        left = { type: 'LogicalExpression', operator, left, right, start, end: this.prevEnd }
      } else {
        left = { type: 'BinaryExpression', operator, left, right, start, end: this.prevEnd }
      }
    }
    this.treeDepth -= links
    return left
  }

  private parseUnary(): Expression {
    const t = this.tok
    const start = t.start
    if (!this.enter()) return this.invalid(start, this.prevEnd)
    try {
      if ((t.type === 'punctuator' && (t.value === '!' || t.value === '~' || t.value === '+' || t.value === '-')) ||
        (t.type === 'keyword' && (t.value === 'typeof' || t.value === 'void' || t.value === 'delete'))) {
        this.next()
        const argument = this.parseUnary()
        return { type: 'UnaryExpression', operator: t.value as AST.UnaryExpression['operator'], argument, start, end: this.prevEnd }
      }
      if (t.type === 'punctuator' && (t.value === '++' || t.value === '--')) {
        this.next()
        const argument = this.parseUnary()
        this.checkSimpleTarget(argument)
        return { type: 'UpdateExpression', operator: t.value, prefix: true, argument, start, end: this.prevEnd }
      }
      const expression = this.parseCallOrMember()
      if ((this.at('++') || this.at('--')) && !this.tok.newlineBefore && !this.bareArrows.has(expression)) {
        const operator = this.tok.value as '++' | '--'
        this.checkSimpleTarget(expression)
        this.next()
        return { type: 'UpdateExpression', operator, prefix: false, argument: expression, start, end: this.prevEnd }
      }
      return expression
    } finally {
      this.leave()
    }
  }

  /** The current token continues a member or call chain. */
  private continuesChain(calls: boolean): boolean {
    return this.at('.') || this.at('[') || (calls && (this.at('?.') || this.at('(') || (this.tok.type === 'template' && this.tok.templateHead === true)))
  }

  private checkSimpleTarget(expression: Expression): void {
    if (expression.type !== 'Identifier' && expression.type !== 'MemberExpression' && expression.type !== 'InvalidExpression') {
      this.report('invalid_assignment_target', expression.start, expression.end)
    }
  }

  private parseCallOrMember(): Expression {
    const start = this.tok.start
    let expression: Expression | AST.Super = this.at('new') ? this.parseNew() : this.parsePrimary()
    if (this.bareArrows.has(expression)) return expression as Expression
    let links = 0
    for (;;) {
      if (!this.continuesChain(true) || !this.link()) break
      links++
      if (this.at('.')) {
        this.next()
        const property = this.parsePropertyName()
        expression = { type: 'MemberExpression', object: expression, property, computed: false, optional: false, start, end: this.prevEnd }
      } else if (this.at('?.')) {
        this.next()
        if (this.at('(')) {
          const args = this.parseArguments()
          expression = { type: 'CallExpression', callee: expression, arguments: args, optional: true, start, end: this.prevEnd }
        } else if (this.eat('[')) {
          const property = this.parseExpression(false)
          this.expect(']')
          expression = { type: 'MemberExpression', object: expression, property, computed: true, optional: true, start, end: this.prevEnd }
        } else {
          const property = this.parsePropertyName()
          expression = { type: 'MemberExpression', object: expression, property, computed: false, optional: true, start, end: this.prevEnd }
        }
      } else if (this.at('[')) {
        this.next()
        const property = this.parseExpression(false)
        this.expect(']')
        expression = { type: 'MemberExpression', object: expression, property, computed: true, optional: false, start, end: this.prevEnd }
      } else if (this.at('(')) {
        const args = this.parseArguments()
        expression = { type: 'CallExpression', callee: expression, arguments: args, optional: false, start, end: this.prevEnd }
      } else if (this.tok.type === 'template' && this.tok.templateHead) {
        const quasi = this.parseTemplate()
        expression = { type: 'TaggedTemplateExpression', tag: expression as Expression, quasi, start, end: this.prevEnd }
      }
    }
    this.treeDepth -= links
    if (expression.type === 'Super') {
      this.report('unexpected_token', expression.start, expression.end, 'super')
      return this.invalid(expression.start, expression.end)
    }
    return expression
  }

  private parseNew(): Expression {
    const start = this.tok.start
    this.next() // new
    if (this.at('.')) {
      this.next()
      const meta: AST.Identifier = { type: 'Identifier', name: 'new', start, end: start + 3 }
      const property = this.parsePropertyName()
      return { type: 'MetaProperty', meta, property: property.type === 'Identifier' ? property : { type: 'Identifier', name: '', start: property.start, end: property.end }, start, end: this.prevEnd }
    }
    const calleeStart = this.tok.start
    if (!this.enter()) return this.invalid(start, this.prevEnd)
    let callee: Expression | AST.Super
    try {
      callee = this.at('new') ? this.parseNew() : this.parsePrimary()
    } finally {
      this.leave()
    }
    let links = 0
    for (;;) {
      if (!this.continuesChain(false) || !this.link()) break
      links++
      if (this.at('.')) {
        this.next()
        const property = this.parsePropertyName()
        callee = { type: 'MemberExpression', object: callee, property, computed: false, optional: false, start: calleeStart, end: this.prevEnd }
      } else if (this.at('[')) {
        this.next()
        const property = this.parseExpression(false)
        this.expect(']')
        callee = { type: 'MemberExpression', object: callee, property, computed: true, optional: false, start: calleeStart, end: this.prevEnd }
      }
    }
    this.treeDepth -= links
    const args = this.at('(') ? this.parseArguments() : []
    return { type: 'NewExpression', callee: callee as Expression, arguments: args, start, end: this.prevEnd }
  }

  private parseArguments(): (Expression | AST.SpreadElement)[] {
    const args: (Expression | AST.SpreadElement)[] = []
    this.next() // (
    while (!this.at(')') && this.tok.type !== 'eof') {
      const before = this.tok
      args.push(this.parseSpreadOrAssignment())
      // An empty argument (`f(a,, b)`) was reported: step over its comma and go on.
      if (this.tok === before && this.at(',')) {
        this.next()
        continue
      }
      if (this.tok === before || !this.eat(',')) break
    }
    this.expect(')')
    return args
  }

  private parseSpreadOrAssignment(): Expression | AST.SpreadElement {
    if (!this.at('...')) return this.parseAssignment(false)
    const start = this.tok.start
    this.next()
    const argument = this.parseAssignment(false)
    return { type: 'SpreadElement', argument, start, end: this.prevEnd }
  }

  private parseIdentifier(): AST.Identifier {
    const t = this.tok
    this.next()
    return { type: 'Identifier', name: t.value, start: t.start, end: t.end }
  }

  /** The name after `.`: any identifier or reserved word. */
  private parsePropertyName(): AST.Identifier | AST.InvalidExpression {
    const t = this.tok
    if (t.type === 'identifier' || t.type === 'keyword') return this.parseIdentifier()
    this.report('expected', t.start, t.end, 'name')
    return this.invalid(t.start, t.start)
  }

  private parsePropertyKey(): { key: Expression; computed: boolean } {
    const t = this.tok
    if (t.type === 'identifier' || t.type === 'keyword') return { key: this.parseIdentifier(), computed: false }
    if (t.type === 'string') {
      this.next()
      return { key: { type: 'Literal', value: t.value, kind: 'string', start: t.start, end: t.end }, computed: false }
    }
    if (t.type === 'number') {
      this.next()
      return { key: { type: 'Literal', value: numberValue(t.value), kind: 'number', start: t.start, end: t.end }, computed: false }
    }
    if (this.at('[')) {
      this.next()
      const key = this.parseAssignment(false)
      this.expect(']')
      return { key, computed: true }
    }
    this.report('expected', t.start, t.end, 'name')
    return { key: this.invalid(t.start, t.start), computed: false }
  }

  private parsePrimary(): Expression | AST.Super {
    const t = this.tok
    const start = t.start
    switch (t.type) {
      case 'identifier': {
        const after = this.peek()
        if (after.type === 'punctuator' && after.value === '=>' && !after.newlineBefore) {
          const param = this.parseIdentifier()
          return this.parseArrowRest(start, [param])
        }
        return this.parseIdentifier()
      }
      case 'number':
        this.next()
        return { type: 'Literal', value: numberValue(t.value), kind: 'number', start, end: t.end }
      case 'string':
        this.next()
        return { type: 'Literal', value: t.value, kind: 'string', start, end: t.end }
      case 'template':
        if (t.templateHead) return this.parseTemplate()
        break
      case 'keyword':
        switch (t.value) {
          case 'this':
            this.next()
            return { type: 'ThisExpression', start, end: t.end }
          case 'super':
            this.next()
            return { type: 'Super', start, end: t.end }
          case 'null':
            this.next()
            return { type: 'Literal', value: null, kind: 'null', start, end: t.end }
          case 'true':
          case 'false':
            this.next()
            return { type: 'Literal', value: t.value === 'true', kind: 'boolean', start, end: t.end }
          case 'function':
            return this.parseFunction(false) as AST.FunctionExpression
          case 'class':
            return this.parseClass(false) as AST.ClassExpression
          case 'new':
            return this.parseNew()
        }
        break
      case 'punctuator':
        switch (t.value) {
          case '/':
          case '/=': {
            const regex = this.lexer.rescanRegex(t)
            this.ahead = null
            this.tok = regex
            this.next()
            return { type: 'Literal', value: regex.value, kind: 'regex', regex: regex.regex, start, end: regex.end }
          }
          case '(':
            return this.parseParenthesized()
          case '[':
            return this.parseArray()
          case '{':
            return this.parseObject()
        }
        break
      case 'invalid':
        // The lexer reported it already.
        this.pendingError = true
        this.next()
        return this.invalid(start, t.end)
    }
    this.unexpected()
    return this.invalid(start, start)
  }

  private parseTemplate(): AST.TemplateLiteral {
    const start = this.tok.start
    const quasis: AST.TemplateElement[] = []
    const expressions: Expression[] = []
    let chunk = this.tok
    for (;;) {
      quasis.push({ type: 'TemplateElement', cooked: chunk.cooked ?? '', tail: chunk.templateTail === true, start: chunk.start, end: chunk.end })
      this.next()
      if (chunk.templateTail) break
      expressions.push(this.parseExpression(false))
      if (!this.at('}')) {
        this.report('expected', this.tok.start, this.tok.end, '}')
        break
      }
      chunk = this.lexer.rescanTemplate(this.tok)
      this.ahead = null
      this.tok = chunk
    }
    return { type: 'TemplateLiteral', quasis, expressions, start, end: this.prevEnd }
  }

  private parseParenthesized(): Expression {
    const start = this.tok.start
    this.next() // (
    const items: (Expression | AST.RestElement)[] = []
    let trailingComma = false
    let rest = false
    while (!this.at(')') && this.tok.type !== 'eof') {
      const before = this.tok
      if (this.at('...')) {
        const restStart = this.tok.start
        this.next()
        const argument = this.parseBindingTarget()
        items.push({ type: 'RestElement', argument, start: restStart, end: this.prevEnd })
        rest = true
        break
      }
      items.push(this.parseAssignment(false))
      if (this.tok === before) break
      if (!this.at(',')) break
      this.next()
      if (this.at(')')) {
        trailingComma = true
        break
      }
    }
    this.expect(')')
    if (this.at('=>') && !this.tok.newlineBefore) {
      const params = items.map((item) => this.toParam(item))
      return this.parseArrowRest(start, params)
    }
    if (items.length === 0) {
      this.report('expected', this.prevEnd - 1, this.prevEnd, 'expression')
      return this.invalid(start, this.prevEnd)
    }
    if (rest || trailingComma) this.report('unexpected_token', start, this.prevEnd, rest ? '...' : ',')
    const expressions = items.filter((item): item is Expression => item.type !== 'RestElement')
    if (expressions.length === 0) return this.invalid(start, this.prevEnd)
    const expression: Expression =
      expressions.length === 1 ? expressions[0] : { type: 'SequenceExpression', expressions, start: expressions[0].start, end: expressions[expressions.length - 1].end }
    this.bareArrows.delete(expression)
    return expression
  }

  private toParam(item: Expression | AST.RestElement): Pattern {
    switch (item.type) {
      case 'Identifier':
      case 'RestElement':
        return item
      case 'AssignmentExpression':
      case 'ArrayExpression':
      case 'ObjectExpression': {
        const target = this.toAssignTarget(item)
        if (!containsMember(target)) return target
        break
      }
    }
    this.report('invalid_arrow_parameters', item.start, item.end)
    return this.invalid(item.start, item.end)
  }

  private parseArrowRest(start: number, params: Pattern[]): AST.ArrowFunctionExpression {
    this.next() // =>
    let arrow: AST.ArrowFunctionExpression
    if (this.at('{')) {
      const outer = this.inGenerator
      this.inGenerator = false
      const body = this.parseBlock()
      this.inGenerator = outer
      arrow = { type: 'ArrowFunctionExpression', params, body, expression: false, start, end: this.prevEnd }
    } else {
      const body = this.parseAssignment(false)
      arrow = { type: 'ArrowFunctionExpression', params, body, expression: true, start, end: this.prevEnd }
    }
    this.bareArrows.add(arrow)
    return arrow
  }

  private parseArray(): AST.ArrayExpression {
    const start = this.tok.start
    this.next()
    const elements: (Expression | AST.SpreadElement | null)[] = []
    while (!this.at(']') && this.tok.type !== 'eof') {
      if (this.at(',')) {
        this.next()
        elements.push(null)
        continue
      }
      const before = this.tok
      elements.push(this.parseSpreadOrAssignment())
      if (this.tok === before || !this.eat(',')) break
    }
    this.expect(']')
    return { type: 'ArrayExpression', elements, start, end: this.prevEnd }
  }

  private parseObject(): AST.ObjectExpression {
    const start = this.tok.start
    this.next()
    const properties: (AST.Property | AST.SpreadElement)[] = []
    while (!this.at('}') && this.tok.type !== 'eof') {
      const before = this.tok
      const property = this.parseObjectMember()
      if (this.tok === before) break
      properties.push(property)
      if (this.eat(',')) continue
      // A missing comma before a member on the next line: reported, and the object goes on.
      const t = this.tok
      if (t.newlineBefore && (t.type === 'identifier' || t.type === 'string' || t.type === 'keyword') && !STATEMENT_KEYWORDS.has(t.value)) {
        this.report('expected', t.start, t.end, ',')
        continue
      }
      break
    }
    this.expect('}')
    return { type: 'ObjectExpression', properties, start, end: this.prevEnd }
  }

  private parseObjectMember(): AST.Property | AST.SpreadElement {
    const start = this.tok.start
    const doc = this.tok.doc
    if (this.at('...')) {
      this.next()
      const argument = this.parseAssignment(false)
      return { type: 'SpreadElement', argument, start, end: this.prevEnd }
    }
    let kind: AST.Property['kind'] = 'init'
    if (this.atName('get') || this.atName('set')) {
      const after = this.peek()
      const plain = after.type === 'punctuator' && ['(', ',', ':', '}', '='].includes(after.value)
      if (!plain) {
        kind = this.tok.value as 'get' | 'set'
        this.next()
      }
    }
    const generator = this.eat('*')
    const { key, computed } = this.parsePropertyKey()
    let property: AST.Property
    if (this.at('(')) {
      const value = this.parseMethod(generator)
      property = { type: 'Property', key, value, kind, computed, shorthand: false, method: kind === 'init', start, end: this.prevEnd }
    } else if (kind !== 'init') {
      this.report('expected', this.tok.start, this.tok.end, '(')
      property = { type: 'Property', key, value: this.invalid(this.tok.start, this.tok.start), kind, computed, shorthand: false, method: false, start, end: this.prevEnd }
    } else if (this.eat(':')) {
      const value = this.parseAssignment(false)
      property = { type: 'Property', key, value, kind, computed, shorthand: false, method: false, start, end: this.prevEnd }
    } else if (key.type === 'Identifier' && !computed && (this.at(',') || this.at('}') || this.at('=') || this.tok.newlineBefore || this.tok.type === 'eof')) {
      const name: AST.Identifier = { type: 'Identifier', name: key.name, start: key.start, end: key.end }
      let value: Expression | Pattern = name
      if (this.eat('=')) {
        // Only valid as a pattern (`({ a = 1 } = b)`); kept as one.
        const right = this.parseAssignment(false)
        value = { type: 'AssignmentPattern', left: name, right, start: key.start, end: this.prevEnd }
      }
      property = { type: 'Property', key, value, kind, computed, shorthand: true, method: false, start, end: this.prevEnd }
    } else {
      this.report('expected', this.tok.start, this.tok.end, ':')
      property = { type: 'Property', key, value: this.invalid(this.tok.start, this.tok.start), kind, computed, shorthand: false, method: false, start, end: this.prevEnd }
    }
    if (doc) property.doc = doc
    return property
  }
}

function containsMember(pattern: Pattern): boolean {
  switch (pattern.type) {
    case 'MemberExpression':
      return true
    case 'ArrayPattern':
      return pattern.elements.some((element) => element !== null && containsMember(element))
    case 'ObjectPattern':
      return pattern.properties.some((property) => containsMember(property.type === 'RestElement' ? property.argument : (property.value as Pattern)))
    case 'AssignmentPattern':
      return containsMember(pattern.left)
    case 'RestElement':
      return containsMember(pattern.argument)
    default:
      return false
  }
}

/** The value of a number token's text: separators and a BigInt suffix dropped, legacy octal read as octal. */
export function numberValue(raw: string): number {
  const text = raw.replace(/_/g, '').replace(/n$/, '')
  if (/^0[0-7]+$/.test(text)) return parseInt(text, 8)
  return Number(text)
}
