// The problems of SFRA route chains, placed in the controller where they happen: what the checkout
// index found when it applied each chain that runs on a storefront (`routeProblems()`), as SFRA's
// server does when a controller loads. Pure: no Node, no Orca.
//
// - `route_redefined`: `get`, `post` or `use` of a name the chain already has (SFRA throws).
// - `route_missing`: `append`, `prepend` or `replace` of a name the chain does not have (SFRA
//   throws).
// - `base_missing`: `server.extend(…)` of a controller no cartridge after it has.
// - `not_exported`: a controller with routes that does not export `server.exports()`.
//
// In doubt, nothing: on a storefront whose path names a cartridge the checkout does not hold after
// the controller's own, the base it extends may be that cartridge's, so none of that chain's
// problems count there; neither do they when it extends a module of a cartridge the checkout does
// not hold. A controller that extends nothing is read whole, whatever the path. A problem that
// happens on some of the storefronts its file runs on names them.
import type { RouteProblemEntry } from '../checkout/checkout'
import type { Lookup } from './lookup'
import { problem, storefrontList, type Lines, type Problem } from './problem'

type Found = { entry: RouteProblemEntry; storefronts: Set<string> }

const byLookup = new WeakMap<Lookup, Map<string, Found[]>>()

/** Whether a chain of `controller` on a storefront may involve a cartridge the checkout does not hold. */
function inDoubt(lookup: Lookup, entry: RouteProblemEntry): boolean {
  const storefront = lookup.storefronts.find((each) => each.id === entry.storefront)
  const facts = lookup.index.fileFacts(entry.controller)
  const base = facts && facts.kind === 'script' ? (facts.controller?.extends ?? null) : null
  if (!storefront || !base) return false
  const cartridge = lookup.cartridgeOf(entry.controller)
  if (!cartridge) return true
  const at = storefront.cartridges.indexOf(cartridge.name)
  if (storefront.cartridges.slice(at + 1).some((name) => !lookup.holds(name))) return true
  if (base.kind === 'require') {
    const resolved = lookup.index.resolveModule(entry.controller, base.module)
    if (resolved.kind === 'file' && resolved.path === null && resolved.form !== 'relative' && resolved.form !== 'current' && resolved.form !== 'cartridge') return true
    if (resolved.kind === 'path' && storefront.missing.length > 0) return true
  }
  return false
}

/** Every route problem not in doubt, by the file it is in, each with the storefronts it happens on. */
function routeProblemsByPath(lookup: Lookup): Map<string, Found[]> {
  const known = byLookup.get(lookup)
  if (known) return known
  const out = new Map<string, Found[]>()
  for (const entry of lookup.index.routeProblems()) {
    if (inDoubt(lookup, entry)) continue
    const { problem: found } = entry
    let list = out.get(found.path)
    if (!list) out.set(found.path, (list = []))
    const same = list.find((each) => each.entry.problem.code === found.code && each.entry.problem.start === found.start && each.entry.problem.end === found.end)
    if (same) same.storefronts.add(entry.storefront)
    else list.push({ entry, storefronts: new Set([entry.storefront]) })
  }
  byLookup.set(lookup, out)
  return out
}

/** Whether any route problem is in that file: a controller without one needs no reading. */
export function hasRouteProblems(lookup: Lookup, path: string): boolean {
  return routeProblemsByPath(lookup).has(path)
}

/** The route problems of one controller; `lines` places them in its text. */
export function checkRoutes(lookup: Lookup, path: string, lines: Lines): Problem[] {
  const found = routeProblemsByPath(lookup).get(path)
  if (!found) return []
  const runsOn = lookup.storefrontsOf(path).map((storefront) => storefront.id)
  return found.map(({ entry, storefronts }) => {
    const { code } = entry.problem
    const args: Record<string, string> = {}
    if (code === 'route_redefined' || code === 'route_missing') args.route = entry.route
    if (runsOn.some((id) => !storefronts.has(id))) args.storefronts = storefrontList([...storefronts])
    // On the route's name in its call; a problem of the whole file sits at its start.
    return problem(code, entry.name ? lines.spot(entry.name.start, entry.name.end) : lines.spot(0, 0), args)
  })
}
