// What the checks read of the checkout index, gathered once per published state of it: the
// cartridge each file belongs to, the storefronts and their paths, the templates, form definitions
// and resource keys of each cartridge, and the custom attributes of each object type. Pure: no
// Node, no Orca.
//
// Where a name lives along the storefronts (`presence`), the rule every check of a name shares:
//
// - Only the storefronts whose path holds the file's cartridge count: a name is looked for along
//   their paths. A file of a cartridge on no path (an unused cartridge, a Business Manager one, or
//   no path at all) gets no warning: what it reaches is not known.
// - On a storefront, the name is found when a cartridge of its path that the checkout holds has
//   it. When none has it and the path names a cartridge the checkout does not hold, the name may be
//   there: that storefront is in doubt and counts neither way.
// - Missing on every storefront that counts: `missing` (a warning). Missing on some and found or in
//   doubt on the others: `partial`, naming the storefronts it is missing on (the weaker warning).
import type { Cartridge, CheckoutIndex, IndexedAttribute, Storefront } from '../checkout/checkout'

export type Presence = { kind: 'found' } | { kind: 'doubt' } | { kind: 'missing' } | { kind: 'partial'; storefronts: string[] }

/** A bundle's name without its locale: `product` for `product_fr` and `product_fr_FR`. */
export function bundleBase(file: string): string {
  return file.replace(/_[a-z]{2}(_[A-Z]{2})?$/, '')
}

function add<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key)
  if (set) set.add(value)
  else map.set(key, new Set([value]))
}

export class Lookup {
  readonly index: CheckoutIndex
  readonly generation: number
  private readonly roots: Cartridge[]
  private readonly cartridgeNames: Set<string>
  readonly storefronts: Storefront[]
  /** Template names (no `.isml`), per cartridge name, any locale folder. */
  private readonly templates = new Map<string, Set<string>>()
  /** Form definition names, per cartridge name, any locale folder. */
  private readonly forms = new Map<string, Set<string>>()
  /** Keys per cartridge name and bundle (its base name, every locale merged). */
  private readonly keys = new Map<string, Map<string, Set<string>>>()
  /** Every bundle's base name, in any cartridge. */
  readonly bundles: Set<string>
  /** Custom attribute ids per object type the metadata defines or extends. */
  private readonly objectTypes = new Map<string, Set<string>>()

  constructor(index: CheckoutIndex) {
    this.index = index
    this.generation = index.generation
    const cartridges = index.cartridges()
    this.cartridgeNames = new Set(cartridges.filter((cartridge) => cartridge.kind === 'cartridge').map((cartridge) => cartridge.name))
    // The deepest folder first, so a path is matched to the cartridge nearest to it.
    this.roots = [...cartridges].sort((a, b) => b.root.length - a.root.length)
    this.storefronts = index.storefronts()
    for (const template of index.templateList()) add(this.templates, template.cartridge, template.name)
    for (const path of index.filePaths()) {
      const match = /\/cartridge\/forms\/[^/]+\/(.+)\.xml$/i.exec(path)
      if (!match) continue
      const cartridge = this.cartridgeOf(path)
      if (cartridge && cartridge.kind === 'cartridge' && path.startsWith(`${cartridge.root}/cartridge/forms/`)) add(this.forms, cartridge.name, match[1])
    }
    for (const [key, definitions] of index.keyNames()) {
      for (const definition of definitions) {
        let ofCartridge = this.keys.get(definition.cartridge)
        if (!ofCartridge) this.keys.set(definition.cartridge, (ofCartridge = new Map()))
        add(ofCartridge, bundleBase(definition.bundle), key)
      }
    }
    this.bundles = new Set(index.bundleNames())
    // The folders that hold a `sites/` folder: a site import, whose `meta/` is the project's.
    const imports = new Set<string>()
    for (const path of index.filePaths()) {
      const parts = path.split('/')
      for (let i = 0; i < parts.length - 1; i++) if (parts[i] === 'sites') imports.add(parts.slice(0, i).join('/'))
    }
    const complete = (attribute: IndexedAttribute) => {
      if (attribute.source === 'git-ref') return true
      const meta = attribute.path.split('/').slice(0, -1)
      return meta.length > 0 && imports.has(meta.slice(0, -1).join('/'))
    }
    for (const type of index.types()) {
      if (type.attributes.some(complete)) this.objectTypes.set(type.typeId, new Set(type.attributes.map((attribute) => attribute.id)))
    }
  }

  /** The cartridge a file of the checkout lies in; null outside every cartridge. */
  cartridgeOf(path: string): Cartridge | null {
    for (const cartridge of this.roots) if (cartridge.root === '' || path.startsWith(`${cartridge.root}/`)) return cartridge
    return null
  }

  /** Whether the checkout holds a cartridge of that name. */
  holds(name: string): boolean {
    return this.cartridgeNames.has(name)
  }

  /** The storefronts whose path holds the file's cartridge. */
  storefrontsOf(path: string): Storefront[] {
    const cartridge = this.cartridgeOf(path)
    if (!cartridge || cartridge.kind !== 'cartridge') return []
    return this.storefronts.filter((storefront) => storefront.cartridges.includes(cartridge.name))
  }

  /** Where a name a file uses lives along the storefronts that count for it; `has` says whether a cartridge has it. */
  presence(path: string, has: (cartridge: string) => boolean): Presence {
    const relevant = this.storefrontsOf(path)
    if (relevant.length === 0) return { kind: 'doubt' }
    const missing: string[] = []
    let elsewhere = false
    for (const storefront of relevant) {
      if (storefront.cartridges.some((name) => this.holds(name) && has(name))) elsewhere = true
      else if (storefront.missing.length > 0) elsewhere = true
      else missing.push(storefront.id)
    }
    if (missing.length === 0) return { kind: 'found' }
    return elsewhere ? { kind: 'partial', storefronts: missing } : { kind: 'missing' }
  }

  hasTemplate(cartridge: string, name: string): boolean {
    return this.templates.get(cartridge)?.has(name) ?? false
  }

  hasForm(cartridge: string, name: string): boolean {
    return this.forms.get(cartridge)?.has(name) ?? false
  }

  hasKey(cartridge: string, bundle: string, key: string): boolean {
    return this.keys.get(cartridge)?.get(bundle)?.has(key) ?? false
  }

  /**
   * The custom attributes of an object type; null when the metadata of that type may be partial.
   * A type counts only when a site import defines some of its attributes (a `meta/` folder beside
   * a `sites/` folder, as a site template is laid out) or the `metadataRef` ref does: the metadata a
   * cartridge ships for its own attributes, or a folder of loose metadata files, says nothing of
   * the attributes defined elsewhere.
   */
  attributes(typeId: string): ReadonlySet<string> | null {
    return this.objectTypes.get(typeId) ?? null
  }
}
