// Cartridge modules as the queries see them: which file a `require` reaches on each storefront,
// and the members each copy exports, its `module.superModule` and the modules it re-exports
// followed. Pure: no Node, no Orca.
import type { CheckoutIndex } from '../checkout/checkout'
import { SUPER_MODULE, type ExportedMember, type ModuleExports } from '../checkout/scan'
import type { DwIndex } from '../dw/index'

/** What every query is given besides the file: the checkout index and the `dw.*` index. */
export type QueryContext = { index: CheckoutIndex; dw: DwIndex | null }

/** How many copies along `module.superModule` and re-exports are followed. */
export const MAX_MODULE_DEPTH = 8

/** A file a module reaches: on one storefront, or on every one (`storefront: null`, a file named directly). */
export type ModuleCopy = { storefront: string | null; path: string }

/** The module name `module.superModule` is given: the next copy of the file itself, per storefront. */
export { SUPER_MODULE }

/**
 * The storefronts that load a file: those whose path holds its cartridge. Null when its cartridge
 * is on no path (or it is in none, or `modules`): then which storefront runs it is not known.
 */
export function storefrontsOf(ctx: QueryContext, from: string): ReadonlySet<string> | null {
  const cartridge = ctx.index.cartridgeOf(from)
  if (!cartridge || cartridge.kind !== 'cartridge') return null
  const on = ctx.index.storefronts().filter((storefront) => storefront.cartridges.includes(cartridge.name))
  return on.length > 0 ? new Set(on.map((storefront) => storefront.id)) : null
}

/**
 * The files `require(module)` from `from` reaches. A `*\/…` module gives, for each storefront
 * whose path holds the file's own cartridge, the copy that path loads: a storefront that never
 * loads the file never runs its `require`. For a file whose cartridge is on no path, the copies
 * the paths reach, unlabelled: it may be loaded by name from any of them, so each copy may run
 * but no storefront can be named. With no storefront path at all, every cartridge's copy,
 * unlabelled. `SUPER_MODULE` gives the copy `module.superModule` reaches on each storefront.
 */
export function moduleCopies(ctx: QueryContext, from: string, module: string): ModuleCopy[] {
  if (module === SUPER_MODULE) return ctx.index.superModule(from).copies.flatMap((copy) => (copy.path ? [{ storefront: copy.storefront, path: copy.path }] : []))
  const resolved = ctx.index.resolveModule(from, module)
  if (resolved.kind === 'file') return resolved.path ? [{ storefront: null, path: resolved.path }] : []
  if (resolved.kind === 'dw') return []
  if (resolved.copies.length === 0) return resolved.candidates.map((path) => ({ storefront: null, path }))
  const on = storefrontsOf(ctx, from)
  if (on) return resolved.copies.flatMap((copy) => (copy.path && on.has(copy.storefront) ? [{ storefront: copy.storefront, path: copy.path }] : []))
  const paths = [...new Set(resolved.copies.flatMap((copy) => (copy.path ? [copy.path] : [])))]
  return paths.map((path) => ({ storefront: null, path }))
}

/** What a script exports, from the index; null for a file it does not hold as a script. */
export function exportsOf(ctx: QueryContext, path: string): ModuleExports | null {
  const facts = ctx.index.fileFacts(path)
  return facts && facts.kind === 'script' ? facts.exports : null
}

/** A member and the file that defines it. */
export type MemberDefinition = { storefront: string | null; path: string; member: ExportedMember }

/**
 * The members a file exports: its own, then those of the modules it re-exports, then those of
 * its `module.superModule` on the storefront given (or every storefront), a closer one hiding a
 * farther one of the same name.
 */
export function fileMembers(ctx: QueryContext, path: string, storefront: string | null, depth = 0, seen = new Set<string>()): MemberDefinition[] {
  const exports = exportsOf(ctx, path)
  if (!exports || depth > MAX_MODULE_DEPTH || seen.has(path)) return []
  seen.add(path)
  const out: MemberDefinition[] = exports.members.map((member) => ({ storefront, path, member }))
  const names = new Set(out.map((each) => each.member.name))
  const add = (more: MemberDefinition[]) => {
    for (const each of more) {
      if (names.has(each.member.name)) continue
      names.add(each.member.name)
      out.push(each)
    }
  }
  for (const module of exports.reexports) {
    for (const copy of moduleCopies(ctx, path, module)) {
      if (storefront !== null && copy.storefront !== null && copy.storefront !== storefront) continue
      add(fileMembers(ctx, copy.path, storefront ?? copy.storefront, depth + 1, new Set(seen)))
    }
  }
  if (exports.extendsSuper) {
    for (const copy of ctx.index.superModule(path).copies) {
      if (!copy.path || (storefront !== null && copy.storefront !== storefront)) continue
      add(fileMembers(ctx, copy.path, copy.storefront, depth + 1, new Set(seen)))
    }
  }
  return out
}

/** Every member `require(module)` gives, over every copy: one entry per name and file. */
export function moduleMembers(ctx: QueryContext, from: string, module: string): MemberDefinition[] {
  const out: MemberDefinition[] = []
  const seen = new Set<string>()
  for (const copy of moduleCopies(ctx, from, module)) {
    for (const each of fileMembers(ctx, copy.path, copy.storefront)) {
      const key = `${each.member.name}\u0000${each.path}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(each)
    }
  }
  return out
}

/** A definition of a member, with the storefronts it runs on; `null` when the module is a file named directly. */
export type MemberPlace = { storefronts: string[] | null; path: string; member: ExportedMember }

/** Where one member of `require(module)` is defined, one entry per definition: empty when no copy exports it. */
export function moduleMember(ctx: QueryContext, from: string, module: string, name: string): MemberPlace[] {
  const out: MemberPlace[] = []
  const byDefinition = new Map<string, MemberPlace>()
  for (const copy of moduleCopies(ctx, from, module)) {
    const found = fileMembers(ctx, copy.path, copy.storefront).find((each) => each.member.name === name)
    if (!found) continue
    // The same definition reached from two storefronts is one, with both.
    const key = `${found.path}\u0000${found.member.start}`
    const known = byDefinition.get(key)
    if (known) {
      if (known.storefronts && copy.storefront !== null) known.storefronts.push(copy.storefront)
      continue
    }
    const place: MemberPlace = { storefronts: copy.storefront === null ? null : [copy.storefront], path: found.path, member: found.member }
    byDefinition.set(key, place)
    out.push(place)
  }
  return out
}
