// SFRA routes when the checkout gives no storefront path (no site archive, no `cartridgePath`
// setting, no ref): which chain runs cannot be known, so every cartridge's controllers are read on
// their own, each declaration labelled with its cartridge. With a path, the index's route chains
// per storefront answer instead. Pure: no Node, no Orca.
import type { RouteOperation } from '../checkout/scan'
import type { QueryContext } from './modules'

/** A route operation of one cartridge's controller. */
export type CartridgeRoute = { id: string; cartridge: string; path: string; operation: RouteOperation }

/** Every route operation of every cartridge's controllers, by `Controller-Name`, in path and source order. */
export function cartridgeRoutes(ctx: QueryContext): Map<string, CartridgeRoute[]> {
  const out = new Map<string, CartridgeRoute[]>()
  for (const entry of ctx.index.scriptList()) {
    if (entry.kind !== 'cartridge') continue
    const controller = /^cartridge\/controllers\/([^/]+)$/.exec(entry.module)?.[1]
    if (!controller) continue
    const facts = ctx.index.fileFacts(entry.path)
    if (!facts || facts.kind !== 'script' || !facts.controller) continue
    for (const operation of facts.controller.operations) {
      const id = `${controller}-${operation.name}`
      const list = out.get(id)
      const route = { id, cartridge: entry.cartridge, path: entry.path, operation }
      if (list) list.push(route)
      else out.set(id, [route])
    }
  }
  return out
}
