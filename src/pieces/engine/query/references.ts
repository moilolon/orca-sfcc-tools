// References of a function a cartridge script exports, across every storefront's cartridge path:
// every read of it (`helper.price`, `require('x').price`, a name of `var { price } =
// require('x')`, `base.price` through `module.superModule`) in a file whose `require` reaches the
// file that defines it on some storefront, with those storefronts. Asked on the export itself,
// on the function it names, or on a read of it. The files of the checkout are read from the
// index; the file asked on, from its text. Pure: no Node, no Orca.
import type * as AST from '../js/ast'
import { walk, type Range } from '../js/ast'
import { lineAt, lineStarts } from '../checkout/files'
import { memberReader, memberUsesOf, type MemberUse } from '../checkout/scan'
import { pathAt, rootAt, type Analysis } from './analysis'
import { moduleMember, type QueryContext } from './modules'
import { Types } from './types'

/** At most this many references are answered. */
export const MAX_REFERENCES = 500

export type ReferenceEntry = {
  path: string
  start: number
  end: number
  line: number
  /** `definition` for where the function is exported or declared, `use` for a read of it. */
  kind: 'definition' | 'use'
  /** The storefronts whose path makes the read reach the function; null when no storefront can be named (see `ModuleCopy`). */
  storefronts: string[] | null
}

export type References = {
  /** The name at the offset, in the text given. */
  range: Range
  name: string
  /** The files that define the function (one per copy a read may reach). */
  defining: string[]
  references: ReferenceEntry[]
  truncated: boolean
}

/** What is asked: an exported function, by the files that define it and its name. */
type Wanted = { name: string; paths: Set<string>; range: Range }

/** The references of the exported function at `offset`; null when the offset is on none. */
export function references(ctx: QueryContext, analysis: Analysis, offset: number): References | null {
  if (analysis.skipped || offset < 0 || offset > analysis.text.length) return null
  const wanted = wantedAt(ctx, analysis, offset)
  if (!wanted) return null
  const out: ReferenceEntry[] = []
  let truncated = false
  const push = (entry: ReferenceEntry) => {
    if (out.length >= MAX_REFERENCES) truncated = true
    else out.push(entry)
  }
  const starts = lineStarts(analysis.text)
  // The file asked on, from its text: its export and declaration, and the reads of the declaration.
  if (wanted.paths.has(analysis.path)) {
    const member = analysis.facts.exports.members.find((each) => each.name === wanted.name)
    if (member) {
      push({ path: analysis.path, start: member.start, end: member.end, line: lineAt(starts, member.start), kind: 'definition', storefronts: null })
      const declared = member.value.kind === 'identifier' ? member.value.declaration : null
      if (declared !== null && declared !== undefined) {
        const declaration = analysis.facts.declarations[declared]
        if (declaration) push({ path: analysis.path, start: declaration.start, end: declaration.end, line: lineAt(starts, declaration.start), kind: 'definition', storefronts: null })
        for (const reference of analysis.facts.references) {
          if (reference.declaration === declared && !reference.write && !(reference.start === member.value.start)) push({ path: analysis.path, start: reference.start, end: reference.end, line: lineAt(starts, reference.start), kind: 'use', storefronts: null })
        }
      }
    }
  }
  // The other copies that define it, from the index.
  for (const path of [...wanted.paths].sort()) {
    if (path === analysis.path) continue
    const facts = ctx.index.fileFacts(path)
    const member = facts?.kind === 'script' ? facts.exports.members.find((each) => each.name === wanted.name) : undefined
    if (!member) continue
    push({ path, start: member.start, end: member.end, line: member.line, kind: 'definition', storefronts: null })
    if (member.definition) push({ path, ...member.definition, kind: 'definition', storefronts: null })
  }
  // Every other file of the checkout from the index, this one from its text.
  const reached = new Map<string, string[] | null | false>()
  const reaches = (from: string, cartridge: string, module: string): string[] | null | false => {
    // A cartridge or `modules` name reaches the same file from anywhere; `*/` depends on the
    // storefronts that load the reading file, so on its cartridge; the rest on the file itself.
    const key = /^(\.|~)/.test(module) || module === 'module.superModule' ? `${from}\u0000${module}` : module.startsWith('*/') ? `${cartridge}\u0000${module}` : module
    let found = reached.get(key)
    if (found === undefined) {
      found = false
      for (const place of moduleMember(ctx, from, module, wanted.name)) {
        if (!wanted.paths.has(place.path)) continue
        if (place.storefronts === null) found = null
        else if (found !== null) found = [...(found || []), ...place.storefronts.filter((each) => !(found || []).includes(each))]
      }
      reached.set(key, found)
    }
    return found
  }
  const scan = (path: string, uses: readonly MemberUse[]) => {
    let cartridge: string | null = null
    for (const use of uses) {
      if (use.member !== wanted.name) continue
      cartridge ??= ctx.index.cartridgeOf(path)?.root ?? ''
      const storefronts = reaches(path, cartridge, use.module)
      if (storefronts === false) continue
      push({ path, start: use.start, end: use.end, line: use.line, kind: 'use', storefronts })
    }
  }
  scan(analysis.path, currentUses(analysis))
  for (const path of ctx.index.filePaths()) {
    if (path === analysis.path) continue
    const facts = ctx.index.fileFacts(path)
    if (facts) scan(path, facts.members)
  }
  return { range: wanted.range, name: wanted.name, defining: [...wanted.paths].sort(), references: out, truncated }
}

/** The member reads of the file asked on, from its text. */
function currentUses(analysis: Analysis): MemberUse[] {
  const reads: AST.MemberExpression[] = []
  const readMember = memberReader(reads)
  for (const root of analysis.roots) walk(root.node, readMember)
  return memberUsesOf(analysis.text, analysis.facts, reads)
}

function wantedAt(ctx: QueryContext, analysis: Analysis, offset: number): Wanted | null {
  // The export itself, or the declaration of the function it names.
  if (analysis.kind === 'script') {
    for (const member of analysis.facts.exports.members) {
      const declared = member.value.kind === 'identifier' ? analysis.facts.declarations[member.value.declaration ?? -1] : undefined
      const at = member.start <= offset && offset <= member.end ? member : declared && declared.start <= offset && offset <= declared.end ? declared : null
      if (at) return { name: member.name, paths: new Set([analysis.path]), range: { start: at.start, end: at.end } }
    }
  }
  // A read of a module's member.
  const root = rootAt(analysis, offset)
  if (!root) return null
  const path = pathAt(root.node, offset)
  const node = path[path.length - 1]
  const parent = path[path.length - 2]
  if (!node || node.type !== 'Identifier' || offset < node.start || offset > node.end) return null
  const types = new Types({ ...ctx, analysis })
  let module: { from: string; module: string } | null = null
  if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed && parent.object.type !== 'Super') {
    const object = types.of(parent.object)
    if (object?.kind === 'module') module = { from: object.from, module: object.module }
  } else {
    // A name of `var { price } = require('x')`.
    const type = types.of(node)
    if (type?.kind === 'member') module = { from: type.from, module: type.module }
  }
  if (!module) return null
  const places = moduleMember(ctx, module.from, module.module, node.name)
  if (places.length === 0) return null
  return { name: node.name, paths: new Set(places.map((place) => place.path)), range: { start: node.start, end: node.end } }
}
