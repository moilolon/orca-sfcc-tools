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

// The checkout index (phase 6.3): what parts 6.4 and 6.5 read. Pure like the syntax layer; the
// worker gives it the disk (`checkout/disk.ts`) and git (`checkout/git.ts`), which stay out of
// this file.
export {
  CheckoutIndex,
  GitError,
  localeFallbacks,
  splitRouteId,
  templateName,
  type Cartridge,
  type CartridgeKind,
  type CheckoutOptions,
  type CheckoutSettings,
  type Copy,
  type GitFailure,
  type IndexCounts,
  type IndexedAttribute,
  type IndexStatus,
  type MetadataOrigin,
  type MetadataSource,
  type ModuleResolution,
  type ObjectType,
  type RefReader,
  type ResourceCopy,
  type ResourceKey,
  type ResourceResolution,
  type RouteChain,
  type RouteProblem,
  type RouteProblemCode,
  type RouteResolution,
  type RouteStep,
  type ScriptEntry,
  type Storefront,
  type SuperModuleCopy,
  type SuperModuleResolution,
  type TemplateCopy,
  type TemplateEntry,
  type TemplateResolution
} from './checkout/checkout'
export { type CheckoutFiles, type DirEntry, type EntryKind } from './checkout/files'
export { MemoryFiles } from './checkout/memory'
export { SITE_PREFERENCES, type AttributeDefinition, type ObjectTypeKind } from './checkout/metadata'
export { type PropertyKey } from './checkout/properties'
export { SETTING_STOREFRONT, type PathSource, type SiteArchive } from './checkout/sites'
export {
  type ControllerBase,
  type ControllerFacts,
  type ExportedMember,
  type ExportedValue,
  type MemberUse,
  type ModuleExports,
  type Place,
  type RequireUse,
  type ResourceUse,
  type RouteMethod,
  type RouteOperation,
  type ScriptFileFacts,
  type TemplateFileFacts,
  type TemplateModule,
  type TemplateUse,
  type TemplateVia,
  SUPER_MODULE
} from './checkout/scan'

// The `dw.*` index (phase 6.1): the committed data/dw-api.json, checked and queried. Pure; the
// caller reads the file, and descriptions are the worker's (`dw/describe.ts`).
export { anchorOf, callableKey, DwIndexError, loadDwIndex, signature, simpleName, type DwCallableData, type DwClass, type DwClassData, type DwConstantData, type DwIndex, type DwIndexData, type DwMember, type DwMemberKind, type DwParam, type DwPropertyData, type DwType } from './dw/index'

// The queries (phase 6.4): pure functions of the two indexes, a file's text and an offset,
// answering in positions of that text. `analyse` reads the text once for every query on it.
export { analyse, fileKind, type Analysis, type FileKind } from './query/analysis'
export { complete, MAX_COMPLETION_ITEMS, type Completion, type CompletionContext, type CompletionItem, type CompletionKind } from './query/complete'
export {
  hover,
  hoverItem,
  MAX_HOVER_ENTRIES,
  type CartridgeRouteEntry,
  type Describe,
  type DwMemberEntry,
  type Hover,
  type HoverContent,
  type MemberDefinitionEntry,
  type ResourceEntry,
  type RouteEntry,
  type RouteStepEntry
} from './query/hover'
export { definition, MAX_TARGETS, type Definition, type DefinitionKind, type Target } from './query/definition'
export { MAX_REFERENCES, references, type ReferenceEntry, type References } from './query/references'
export { MAX_SIGNATURES, signatureHelp, type Signature, type SignatureHelp, type SignatureParameter } from './query/signature'
export { ISML_TAG_ATTRIBUTES } from './query/isml-tags'
export { cartridgeRoutes, type CartridgeRoute } from './query/routes'
export { moduleCopies, moduleMember, moduleMembers, type MemberPlace, type ModuleCopy, type QueryContext } from './query/modules'
export { GUESSED_NAMES, guessedClass, metadataTypeOf, Types, type QType, type TypeContext } from './query/types'
