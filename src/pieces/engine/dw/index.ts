// The `dw.*` index: what data/dw-api.json holds, the loader that checks it, and the queries part
// 6.4 builds completion and hover on. Pure: no Node, no Orca; the caller reads the file.
//
// The index holds facts of the interface only (names, inheritance, types, signatures, constant
// values, deprecation) and no description: those are read at run time (./describe.ts). It is
// written by scripts/generate-dw-index.ts (`npm run dw-index`).

/**
 * A type as the index writes it: a class id (`TopLevel.String`, `dw.catalog.Product`), the same
 * followed by `[]` for an array, or a word the documentation does not link (`void`, or a class it
 * has no page for).
 */
export type DwType = string

/** A parameter; `rest` for one that takes any number of values (`args: Object...`). */
export type DwParam = { name: string; type: DwType; rest?: true }

/** A constant: its type, and its value when the documentation gives one. */
export type DwConstantData = { name: string; type: DwType; value?: string | number; deprecated?: true }

export type DwPropertyData = { name: string; type: DwType; static?: true; readOnly?: true; deprecated?: true }

/**
 * A constructor or a method. `key` is the heading of its section on the page, written only when
 * it is not `name(Type, Type)` (an overload the documentation tells apart as `- Variant 1`).
 * A constructor has no `returns`.
 */
export type DwCallableData = { name: string; key?: string; params: DwParam[]; returns?: DwType; static?: true; deprecated?: true }

/**
 * One class, under its id (`dw.catalog.ProductMgr`: the package, a dot, the class name). `super`
 * is absent only for the root of the hierarchy.
 */
export type DwClassData = {
  super?: string
  subclasses?: string[]
  deprecated?: true
  constants?: DwConstantData[]
  properties?: DwPropertyData[]
  constructors?: DwCallableData[]
  methods?: DwCallableData[]
}

/** What data/dw-api.json holds. `version` is the documentation's (`26.10`), `generated` a date. */
export type DwIndexData = {
  format: 1
  version: string
  generated: string
  /** The address every page is under: a page is `<base><class id>.html`. */
  base: string
  classes: Record<string, DwClassData>
}

export const DW_INDEX_FORMAT = 1

export type DwMemberKind = 'constant' | 'property' | 'constructor' | 'method'

/**
 * A member as the queries answer it. `owner` is the class that declares it, which an inherited
 * member keeps; `key` names it on its page (its section heading), unique within the owner.
 */
export type DwMember = {
  kind: DwMemberKind
  owner: string
  name: string
  key: string
  /** A constant's or a property's type. */
  type?: DwType
  value?: string | number
  params?: readonly DwParam[]
  returns?: DwType
  static: boolean
  readOnly: boolean
  deprecated: boolean
}

export type DwClass = {
  id: string
  package: string
  name: string
  super: string | null
  subclasses: readonly string[]
  deprecated: boolean
  /** Its own members, in the order of the index; `members()` adds the inherited ones. */
  own: readonly DwMember[]
}

export type DwIndex = {
  readonly version: string
  readonly generated: string
  /** Every class, sorted by id. */
  classes(): readonly DwClass[]
  /**
   * A class by its id (`dw.catalog.ProductMgr`), its module path (`dw/catalog/ProductMgr`), or a
   * bare name: a top-level class first (`String` is `TopLevel.String`), else the one class of
   * that name, else null when none or several have it.
   */
  findClass(name: string): DwClass | null
  /** The classes of a package, by its name (`dw.catalog`) or module path (`dw/catalog`). */
  packageClasses(name: string): readonly DwClass[]
  /**
   * Every member of a class, inherited ones included: its own first, then each superclass's in
   * turn, without one a closer class redeclares (a property or constant by name, a method by
   * name and parameter types). Constructors are not inherited. Copies the documentation gives
   * with the same signature are answered once.
   */
  members(cls: DwClass): readonly DwMember[]
  /** The members of that name, overloads included, inherited ones too. */
  member(cls: DwClass, name: string): readonly DwMember[]
  /** A constant's value, inherited ones included; undefined when none is known. */
  constantValue(cls: DwClass, name: string): string | number | undefined
  /** Whether the class, or every member of that name in it, is deprecated. */
  isDeprecated(cls: DwClass, memberName?: string): boolean
  /** The documentation page of a class, at the member's section when one is given. */
  link(cls: DwClass, member?: DwMember): string
}

/** The anchor of a section heading on a page, as the documentation writes its links. */
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/\\/g, '')
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-')
}

/** The last part of a class id (`String` for `TopLevel.String`), keeping `[]`. */
export function simpleName(type: DwType): string {
  return type.slice(type.lastIndexOf('.', type.endsWith('[]') ? type.length - 3 : type.length) + 1)
}

/** The heading a constructor or a method has on its page when the index writes no `key`. */
export function callableKey(callable: Pick<DwCallableData, 'name' | 'params'>): string {
  return `${callable.name}(${callable.params.map((param) => simpleName(param.type) + (param.rest ? '...' : '')).join(', ')})`
}

/**
 * How a member reads: `static getProduct(productID: String): Product`,
 * `orderNo: String (read-only)`, `ORDER_STATUS_NEW: Number = 3`.
 */
export function signature(member: DwMember): string {
  const prefix = member.static ? 'static ' : ''
  if (member.kind === 'constructor' || member.kind === 'method') {
    const params = (member.params ?? []).map((param) => `${param.rest ? '...' : ''}${param.name}: ${simpleName(param.type)}`).join(', ')
    return `${prefix}${member.name}(${params})${member.returns ? `: ${simpleName(member.returns)}` : ''}`
  }
  const type = `${member.name}: ${simpleName(member.type ?? '')}`
  if (member.kind === 'constant') return `${prefix}${type}${member.value === undefined ? '' : ` = ${JSON.stringify(member.value)}`}`
  return `${prefix}${type}${member.readOnly ? ' (read-only)' : ''}`
}

export class DwIndexError extends Error {
  constructor(detail: string) {
    super(`dw index: ${detail}`)
    this.name = 'DwIndexError'
  }
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value) throw new DwIndexError(`${where} is not a text`)
  return value
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new DwIndexError(`${where} is not a list`)
  return value
}

function params(value: unknown, where: string): DwParam[] {
  return list(value, where).map((param, at) => {
    if (!isObject(param)) throw new DwIndexError(`${where}[${at}] is not an object`)
    return { name: text(param.name, `${where}[${at}].name`), type: text(param.type, `${where}[${at}].type`), ...(param.rest === true ? { rest: true as const } : {}) }
  })
}

/** One class's members, checked, in the order the index lists them. */
function membersOf(id: string, data: Json): DwMember[] {
  const out: DwMember[] = []
  const add = (kind: DwMemberKind, raw: unknown[], where: string) => {
    raw.forEach((entry, at) => {
      const here = `${id}.${where}[${at}]`
      if (!isObject(entry)) throw new DwIndexError(`${here} is not an object`)
      const name = text(entry.name, `${here}.name`)
      const callable = kind === 'constructor' || kind === 'method'
      const member: DwMember = {
        kind,
        owner: id,
        name,
        key: name,
        static: entry.static === true,
        readOnly: entry.readOnly === true,
        deprecated: entry.deprecated === true
      }
      if (callable) {
        member.params = params(entry.params, `${here}.params`)
        if (entry.returns !== undefined) member.returns = text(entry.returns, `${here}.returns`)
        member.key = entry.key === undefined ? callableKey({ name, params: member.params as DwParam[] }) : text(entry.key, `${here}.key`)
      } else {
        member.type = text(entry.type, `${here}.type`)
        if (typeof entry.value === 'string' || typeof entry.value === 'number') member.value = entry.value
      }
      out.push(member)
    })
  }
  add('constant', list(data.constants, `${id}.constants`), 'constants')
  add('property', list(data.properties, `${id}.properties`), 'properties')
  add('constructor', list(data.constructors, `${id}.constructors`), 'constructors')
  add('method', list(data.methods, `${id}.methods`), 'methods')
  return out
}

/** What makes two members the same slot: a closer one hides a farther one with the same. */
function slotOf(member: DwMember): string {
  const group = member.kind === 'method' ? 'm' : member.kind === 'constructor' ? 'c' : 'f'
  return member.kind === 'method' ? `${group}:${callableKey({ name: member.name, params: member.params as DwParam[] })}` : `${group}:${member.name}`
}

/** Checks `data` (the parsed data/dw-api.json) and answers queries on it. Throws a DwIndexError. */
export function loadDwIndex(data: unknown): DwIndex {
  if (!isObject(data)) throw new DwIndexError('not an object')
  if (data.format !== DW_INDEX_FORMAT) throw new DwIndexError(`format ${String(data.format)} is not ${DW_INDEX_FORMAT}`)
  const version = text(data.version, 'version')
  const generated = text(data.generated, 'generated')
  const base = text(data.base, 'base')
  if (!isObject(data.classes)) throw new DwIndexError('classes is not an object')

  const byId = new Map<string, DwClass>()
  for (const id of Object.keys(data.classes).sort()) {
    const raw = data.classes[id]
    if (!isObject(raw)) throw new DwIndexError(`${id} is not an object`)
    const dot = id.lastIndexOf('.')
    if (dot <= 0 || dot === id.length - 1) throw new DwIndexError(`${id} is not a class id`)
    byId.set(id, {
      id,
      package: id.slice(0, dot),
      name: id.slice(dot + 1),
      super: raw.super === undefined ? null : text(raw.super, `${id}.super`),
      subclasses: list(raw.subclasses, `${id}.subclasses`).map((each, at) => text(each, `${id}.subclasses[${at}]`)),
      deprecated: raw.deprecated === true,
      own: membersOf(id, raw)
    })
  }
  for (const cls of byId.values()) {
    if (cls.super !== null && !byId.has(cls.super)) throw new DwIndexError(`${cls.id}.super names ${cls.super}, which is not in the index`)
  }

  const byName = new Map<string, DwClass[]>()
  const byPackage = new Map<string, DwClass[]>()
  for (const cls of byId.values()) {
    byName.set(cls.name, [...(byName.get(cls.name) ?? []), cls])
    byPackage.set(cls.package, [...(byPackage.get(cls.package) ?? []), cls])
  }

  const resolved = new Map<string, readonly DwMember[]>()
  function members(cls: DwClass): readonly DwMember[] {
    const known = resolved.get(cls.id)
    if (known) return known
    const out: DwMember[] = []
    const taken = new Set<string>()
    const visited = new Set<string>()
    for (let at: DwClass | undefined = cls; at && !visited.has(at.id); at = at.super ? byId.get(at.super) : undefined) {
      visited.add(at.id)
      // The documentation repeats some overloads word for word as `- Variant 1`, `- Variant 2`:
      // one of each signature is kept, a deprecated one only when every copy is.
      const same = new Map<string, number>()
      for (const member of at.own) {
        if (member.kind === 'constructor' && at !== cls) continue
        if (taken.has(slotOf(member))) continue
        const twin = `${member.kind}|${signature(member)}`
        const kept = same.get(twin)
        if (kept === undefined) {
          same.set(twin, out.length)
          out.push(member)
        } else if (out[kept].deprecated && !member.deprecated) out[kept] = member
      }
      // Added once the class is done: two variants of one overload in a class both stay, and
      // only a closer class hides a member.
      for (const member of at.own) taken.add(slotOf(member))
    }
    resolved.set(cls.id, out)
    return out
  }

  const member = (cls: DwClass, name: string) => members(cls).filter((each) => each.name === name)

  return {
    version,
    generated,
    classes: () => [...byId.values()],
    findClass(name) {
      const id = name.replace(/\//g, '.')
      const exact = byId.get(id)
      if (exact) return exact
      if (id.includes('.')) return null
      const top = byId.get(`TopLevel.${id}`)
      if (top) return top
      const named = byName.get(id) ?? []
      return named.length === 1 ? named[0] : null
    },
    packageClasses: (name) => byPackage.get(name.replace(/\//g, '.')) ?? [],
    members,
    member,
    constantValue(cls, name) {
      return member(cls, name).find((each) => each.kind === 'constant')?.value
    },
    isDeprecated(cls, memberName) {
      if (memberName === undefined) return cls.deprecated
      const found = member(cls, memberName)
      return found.length > 0 && found.every((each) => each.deprecated)
    },
    link(cls, at) {
      return `${base}${cls.id}.html${at ? `#${anchorOf(at.key)}` : ''}`
    }
  }
}
