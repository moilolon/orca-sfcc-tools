// The syntax layer of the analysis engine (phase 6.2): the contract parts 6.3 (the checkout
// index) and 6.4 (queries) build on. Everything here is pure, with no Node and no Orca imports,
// so the editor can load it in its frame too.
//
// - `parseScript(text)` / `parseExpression(text)`: a tolerant JavaScript parser for SFCC scripts.
//   It never throws; it returns a tree (ESTree-shaped, `js/ast.ts`) where every node has `start`
//   and `end` offsets of `text`, the comments (JSDoc as `doc`, also attached to the declaration
//   that follows), and the syntax problems with their ranges.
// - `tokenize(text)`: the tokens of a script, comments included, for highlighting.
// - `scriptFacts(program)`: scopes, declarations, the declaration of each identifier use,
//   `require` calls with what they bind, and exports (`module.exports`, `exports.x`,
//   `Object.assign`, `module.superModule`).
// - `parseTemplate(text)`: an ISML template into elements, ISML tags, text, `${…}`, comments and
//   `<isscript>`, with positions; tolerant like the JavaScript parser.
// - `templateScript(text)`: the JavaScript of a template (every `${…}` and `<isscript>`, parsed in
//   template positions) and its facts as a whole.
//
// Positions are UTF-16 offsets of the text given, `end` exclusive. Problems carry a stable `code`
// (`PROBLEM_CODES`) for whoever words them.

export type * from './js/ast'
export { PROBLEM_CODES, forEachChild, nodePathAt, walk } from './js/ast'
export { KEYWORDS, Lexer, tokenize, type Token, type TokenType } from './js/lexer'
export { MAX_DEPTH, MAX_TREE_DEPTH, parseExpression, parseScript, type ExpressionParse, type ParseOptions, type ScriptParse } from './js/parser'
export {
  declarationAt,
  fragmentFacts,
  isModuleExports,
  isSuperModule,
  referenceAt,
  scopeAt,
  scriptFacts,
  type Declaration,
  type DeclarationKind,
  type ExportAssignment,
  type ExportFacts,
  type ExportMember,
  type ExportSource,
  type Fragment,
  type Reference,
  type RequireBinding,
  type RequireCall,
  type RequirePatternName,
  type Scope,
  type ScopeKind,
  type ScriptFacts,
  type SuperModuleFacts,
  type TemplateDeclaration,
  type ValueFacts,
  type ValueKind
} from './js/facts'
export {
  EXPRESSION_CHARACTERS,
  EXPRESSION_LINES,
  HTML_VOID,
  ISML_CONTAINERS,
  ISML_TAGS,
  MAX_ELEMENT_DEPTH,
  MAX_TAG_NESTING,
  attribute,
  attributeText,
  parseTemplate,
  scanExpression,
  walkTemplate,
  type Attribute,
  type AttributeValue,
  type CloseTag,
  type Doctype,
  type Element,
  type ExpressionScan,
  type HtmlComment,
  type IsComment,
  type IsScript,
  type IsmlDocument,
  type IsmlExpression,
  type IsmlNode,
  type ModuleDeclaration,
  type TemplateParse,
  type Text
} from './isml/parser'
export { templateScript, type TemplateFragment, type TemplateScript } from './isml/embedded'
