// The JavaScript inside a template: every `${…}` expression and every `<isscript>` block, parsed
// with the JavaScript parser straight from the template's text, so every position in their trees
// is already a position of the template. Then the facts of the template as a whole: the fragments
// share one scope, where a name is seen only after it is declared (a `require` in an `<isscript>`
// binds a name the expressions after it can use), and `<isset name>` and the variables of an
// `<isloop>` are declared there too. Pure: no Node, no Orca.
import type { Comment, Expression, Problem, Program, Range } from '../js/ast'
import { fragmentFacts, type ScriptFacts, type TemplateDeclaration } from '../js/facts'
import { parseExpression, parseScript } from '../js/parser'
import { parseTemplate, walkTemplate, type Attribute, type Element, type IsmlDocument, type IsmlExpression, type IsScript } from './parser'

export interface TemplateFragment extends Range {
  /** `expression` for a `${…}`, `script` for an `<isscript>` block. The range is the code's. */
  kind: 'expression' | 'script'
  /** The parsed code: an expression for `${…}`, a program for `<isscript>`. */
  node: Expression | Program
  /** The template node it comes from. */
  owner: IsmlExpression | IsScript
}

export interface TemplateScript {
  /** Every fragment, in source order. */
  fragments: TemplateFragment[]
  /** The names the template declares outside JavaScript (`<isset>`, `<isloop>`). */
  declarations: TemplateDeclaration[]
  /** Comments of the fragments. */
  comments: Comment[]
  /** Syntax problems of the fragments, in template positions. */
  problems: Problem[]
  /** Declarations, uses, requires and exports of the template's JavaScript as a whole. */
  facts: ScriptFacts
}

/** The JavaScript of a template. Pass the document when it is already parsed. Never throws. */
export function templateScript(text: string, document: IsmlDocument = parseTemplate(text).document): TemplateScript {
  const fragments: TemplateFragment[] = []
  const declarations: TemplateDeclaration[] = []
  const comments: Comment[] = []
  const problems: Problem[] = []
  walkTemplate(document, (node) => {
    if (node.type === 'Expression') {
      const parsed = parseExpression(text, { start: node.codeStart, end: node.codeEnd })
      fragments.push({ kind: 'expression', node: parsed.expression, owner: node, start: node.codeStart, end: node.codeEnd })
      comments.push(...parsed.comments)
      problems.push(...parsed.problems)
    } else if (node.type === 'IsScript') {
      const parsed = parseScript(text, { start: node.codeStart, end: node.codeEnd })
      fragments.push({ kind: 'script', node: parsed.program, owner: node, start: node.codeStart, end: node.codeEnd })
      comments.push(...parsed.comments)
      problems.push(...parsed.problems)
    } else if (node.type === 'Element') {
      declarations.push(...elementDeclarations(text, node))
    }
  })
  fragments.sort((a, b) => a.start - b.start)
  const facts = fragmentFacts({ start: 0, end: text.length }, fragments.map((fragment) => ({ node: fragment.node })), declarations)
  return { fragments, declarations, comments, problems, facts }
}

/** The plain-text value of an attribute and its range, or `null`. */
function plainValue(text: string, attribute: Attribute | undefined): { name: string; start: number; end: number } | null {
  if (!attribute || !attribute.value || !attribute.value.parts.every((part) => part.type === 'Text')) return null
  const raw = text.slice(attribute.value.contentStart, attribute.value.contentEnd)
  const name = raw.trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  const start = attribute.value.contentStart + raw.indexOf(name)
  return { name, start, end: start + name.length }
}

function elementDeclarations(text: string, element: Element): TemplateDeclaration[] {
  const find = (name: string) => element.attributes.find((a) => a.name === name)
  const tag = { start: element.start, end: element.openEnd }
  if (element.name === 'isset') {
    const name = plainValue(text, find('name'))
    // Visible after its own tag: `<isset name="a" value="${a + 1}">` reads the earlier `a`.
    return name ? [{ ...name, kind: 'isset', node: tag, visible: { start: element.openEnd, end: text.length } }] : []
  }
  if (element.name === 'isloop') {
    const out: TemplateDeclaration[] = []
    // The item is named by `var` (or the older `alias`), the loop state by `status`.
    for (const attribute of ['var', 'alias', 'status']) {
      const name = plainValue(text, find(attribute))
      // Visible inside the loop, not in its own `items`.
      if (name) out.push({ ...name, kind: 'isloop', node: tag, visible: { start: element.openEnd, end: element.end } })
    }
    return out
  }
  return []
}
