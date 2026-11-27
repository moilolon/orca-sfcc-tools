// Signature help: inside the parentheses of a call, the signatures of what it reaches and the
// parameter the offset is at. A `dw.*` method of a known type (every overload, the one that fits
// the arguments written chosen), a `dw.*` constructor after `new`, a cartridge module's function
// (one per copy the call may reach, with where it is declared), a module that is itself a
// function (a model's constructor), or a function declared in the file. Pure: no Node, no Orca.
import type * as AST from '../js/ast'
import type { Range } from '../js/ast'
import { lineAt, lineStarts } from '../checkout/files'
import { docText, paramName } from '../checkout/scan'
import { signature as dwSignature, simpleName, type DwMember } from '../dw/index'
import { pathAt, rootAt, type Analysis } from './analysis'
import type { Describe } from './hover'
import { exportsOf, moduleCopies, moduleMember, type QueryContext } from './modules'
import { membersFor, Types } from './types'

/** At most this many signatures are answered. */
export const MAX_SIGNATURES = 20

export type SignatureParameter = { label: string; type: string | null }

export type Signature = {
  /** How it reads: `static getProduct(productID: String): Product`, `price(product)`. */
  label: string
  parameters: SignatureParameter[]
  source: 'dw' | 'module' | 'local'
  deprecated: boolean
  /** The documentation page of a `dw.*` member, and what the worker may describe. */
  link: string | null
  describe: Describe | null
  /** Where a function of the checkout is declared, its JSDoc, the storefronts it runs on (null: every one). */
  path: string | null
  line: number | null
  doc: string | null
  storefronts: string[] | null
}

export type SignatureHelp = {
  /** The arguments of the call, between its parentheses, in the text given. */
  range: Range
  signatures: Signature[]
  activeSignature: number
  /** Which argument the offset is at, from 0. */
  activeParameter: number
}

/** The call around `offset` and what it reaches; null outside the parentheses of a call the engine knows. */
export function signatureHelp(ctx: QueryContext, analysis: Analysis, offset: number): SignatureHelp | null {
  if (analysis.skipped || offset < 0 || offset > analysis.text.length) return null
  const root = rootAt(analysis, offset)
  if (!root) return null
  const text = analysis.text
  // An unclosed call ends at its last token: white space after it is still inside.
  let probe = offset
  while (probe > root.start && /\s/.test(text[probe - 1])) probe--
  const path = pathAt(root.node, probe)
  let call: AST.CallExpression | AST.NewExpression | null = null
  let open = -1
  let closedCall = false
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]
    // Inside a function written as an argument, the call around it is not the one being written.
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration') return null
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') continue
    const paren = text.indexOf('(', node.callee.end)
    if (paren === -1 || paren >= node.end || /\S/.test(text.slice(node.callee.end, paren))) continue
    const closed = text[node.end - 1] === ')' && node.end - 1 > paren
    if (offset > paren && (closed ? offset < node.end : probe <= node.end)) {
      call = node
      open = paren
      closedCall = closed
      break
    }
  }
  if (!call) return null
  const args = call.arguments
  let active = 0
  for (let i = 0; i < args.length; i++) {
    if (args[i].end > offset) break
    const between = text.slice(args[i].end, i + 1 < args.length ? Math.min(args[i + 1].start, offset) : offset)
    if (between.includes(',')) active = i + 1
  }
  const close = closedCall ? call.end - 1 : Math.max(call.end, offset)
  const signatures = signaturesOf(ctx, analysis, call).slice(0, MAX_SIGNATURES)
  if (signatures.length === 0) return null
  // The first signature that takes the arguments written and the one at the offset.
  const fits = signatures.findIndex((each) => each.parameters.length > active && each.parameters.length >= args.length)
  const rest = signatures.findIndex((each) => each.parameters.some((param) => param.label.startsWith('...')))
  return { range: { start: open + 1, end: close }, signatures, activeSignature: fits !== -1 ? fits : rest !== -1 ? rest : 0, activeParameter: active }
}

function dwSignatures(ctx: QueryContext, members: readonly DwMember[]): Signature[] {
  const dw = ctx.dw
  if (!dw) return []
  return members.map((member) => {
    const owner = dw.findClass(member.owner)
    return {
      label: dwSignature(member),
      parameters: (member.params ?? []).map((param) => ({ label: `${param.rest ? '...' : ''}${param.name}`, type: simpleName(param.type) })),
      source: 'dw',
      deprecated: member.deprecated,
      link: owner ? dw.link(owner, member) : null,
      describe: { classId: member.owner, memberKey: member.key },
      path: null,
      line: null,
      doc: null,
      storefronts: null
    }
  })
}

function plain(label: string, params: readonly string[], source: Signature['source'], where: { path: string; line: number; doc: string | null; storefronts: string[] | null }): Signature {
  return { label: `${label}(${params.join(', ')})`, parameters: params.map((param) => ({ label: param, type: null })), source, deprecated: false, link: null, describe: null, ...where }
}

function signaturesOf(ctx: QueryContext, analysis: Analysis, call: AST.CallExpression | AST.NewExpression): Signature[] {
  const callee = call.callee
  if (callee.type === 'Super') return []
  const types = new Types({ ...ctx, analysis })
  const type = types.of(callee)
  const dw = ctx.dw
  if (type?.kind === 'method' && dw) {
    const cls = dw.findClass(type.owner)
    if (!cls) return []
    const all = cls.id === 'TopLevel.global' ? dw.members(cls) : membersFor(dw, cls, type.static)
    return dwSignatures(ctx, all.filter((member) => member.kind === 'method' && member.name === type.name))
  }
  if (type?.kind === 'class' && call.type === 'NewExpression' && dw) {
    const cls = dw.findClass(type.id)
    return cls ? dwSignatures(ctx, cls.own.filter((member) => member.kind === 'constructor')) : []
  }
  if (type?.kind === 'member') {
    return moduleMember(ctx, type.from, type.module, type.name).flatMap((place) => {
      if (!place.member.params) return []
      const at = place.member.definition ?? place.member
      return [plain(place.member.name, place.member.params, 'module', { path: place.path, line: at.line, doc: place.member.doc, storefronts: place.storefronts })]
    })
  }
  if (type?.kind === 'module') {
    // A module that is itself a function: a model's constructor.
    const out: Signature[] = []
    for (const copy of moduleCopies(ctx, type.from, type.module)) {
      const exports = exportsOf(ctx, copy.path)
      if (!exports?.params || !exports.place) continue
      const known = out.find((each) => each.path === copy.path)
      if (known) {
        if (known.storefronts && copy.storefront !== null) known.storefronts.push(copy.storefront)
        continue
      }
      const name = callee.type === 'Identifier' ? callee.name : 'module'
      out.push(plain(name, exports.params, 'module', { path: copy.path, line: exports.place.line, doc: exports.doc, storefronts: copy.storefront === null ? null : [copy.storefront] }))
    }
    return out
  }
  // A function declared in the file.
  if (callee.type === 'Identifier') {
    const id = analysis.references.get(callee.start)?.declaration
    const declaration = id === null || id === undefined ? undefined : analysis.facts.declarations[id]
    const init = declaration?.init
    if (!declaration || !init || (init.type !== 'FunctionDeclaration' && init.type !== 'FunctionExpression' && init.type !== 'ArrowFunctionExpression')) return []
    // Assigned again, or declared again in its function: not one function.
    if (analysis.rewritten.has(declaration.id) || analysis.assigned.has(declaration.id) || analysis.bindings.has(declaration.id)) return []
    const doc = declaration.doc ?? (init.type === 'FunctionDeclaration' ? init.doc : undefined)
    return [plain(declaration.name, init.params.map(paramName), 'local', { path: analysis.path, line: lineAt(lineStarts(analysis.text), declaration.start), doc: docText(doc?.text), storefronts: null })]
  }
  return []
}
