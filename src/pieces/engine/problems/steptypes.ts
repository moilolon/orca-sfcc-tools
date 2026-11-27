// The problems of a cartridge's `steptypes.json`, the custom job steps it declares. Pure: no Node,
// no Orca.
//
// The rules:
//
// - Valid JSON (`json.ts`), or one `steptypes_invalid` at the first fault, and nothing else.
// - The root is an object with a `step-types` object; each of its `script-module-step` and
//   `chunk-script-module-step` holds a step type or a list of them. A step type is an object with
//   a non-empty `@type-id` and a non-empty `module`; a missing one is `steptypes_missing_key`
//   (`key` names it). Other keys and other kinds of step are not read.
// - `module` is a script path as `require` takes it (`<cartridge>/cartridge/scripts/…`, `~/…`,
//   `*/…`, relative to the file): `steptypes_module_missing` only when the cartridge it names is
//   in the checkout and has no such script (`*/`: when no cartridge of the checkout has it). A
//   cartridge the checkout does not hold may have it: nothing then.
// - A `@type-id` declared twice in one file, or in two files of cartridges that share a
//   storefront's path (any two when there is no path), is `steptypes_duplicate_id` on each
//   declaration after the first, the files taken in path order.
import { readJson, member, type JsonValue } from './json'
import type { Lookup } from './lookup'
import { Lines, problem, type Problem, type Spot } from './problem'

const STEP_KINDS = ['script-module-step', 'chunk-script-module-step']

export type StepTypesUses = {
  kind: 'steptypes'
  own: Problem[]
  modules: (Spot & { module: string })[]
  ids: (Spot & { id: string })[]
}

/** Whether a path is a cartridge's `steptypes.json`. */
export function isStepTypesPath(path: string): boolean {
  return /(^|\/)steptypes\.json$/i.test(path)
}

export function stepTypesUses(text: string): StepTypesUses {
  const uses: StepTypesUses = { kind: 'steptypes', own: [], modules: [], ids: [] }
  const lines = new Lines(text)
  const read = readJson(text)
  if (read.fault) {
    uses.own.push(problem('steptypes_invalid', lines.spot(read.fault.start, read.fault.end), { reason: read.fault.reason }))
    return uses
  }
  const root = read.value
  const stepTypes = member(root, 'step-types')
  if (root.kind !== 'object' || !stepTypes || stepTypes.value.kind !== 'object') {
    const at = stepTypes ? lines.spot(stepTypes.keyStart, stepTypes.keyEnd) : lines.spot(root.start, root.start + 1)
    uses.own.push(problem('steptypes_missing_key', at, { key: 'step-types' }))
    return uses
  }
  for (const kind of STEP_KINDS) {
    const found = member(stepTypes.value, kind)
    if (!found) continue
    const steps: JsonValue[] = found.value.kind === 'array' ? found.value.items : [found.value]
    for (const step of steps) {
      if (step.kind !== 'object') {
        uses.own.push(problem('steptypes_missing_key', lines.spot(step.start, step.end), { key: '@type-id' }))
        continue
      }
      for (const key of ['@type-id', 'module']) {
        const value = member(step, key)
        if (!value || value.value.kind !== 'string' || !value.value.value.trim()) {
          const at = value ? lines.spot(value.value.start, value.value.end) : lines.spot(step.start, step.start + 1)
          uses.own.push(problem('steptypes_missing_key', at, { key }))
        }
      }
      const id = member(step, '@type-id')
      if (id && id.value.kind === 'string' && id.value.value.trim()) uses.ids.push({ ...lines.spot(id.value.start + 1, id.value.end - 1), id: id.value.value.trim() })
      const module = member(step, 'module')
      if (module && module.value.kind === 'string' && module.value.value.trim()) uses.modules.push({ ...lines.spot(module.value.start + 1, module.value.end - 1), module: module.value.value.trim() })
    }
  }
  return uses
}

/** Whether a step's module surely resolves to no script: false when it does, or when it cannot be told. */
function moduleMissing(lookup: Lookup, path: string, module: string): boolean {
  const plain = module.replace(/\\/g, '/')
  // A step's module is a path from the cartridges' folder, as `require` takes it.
  const resolved = lookup.index.resolveModule(path, plain)
  if (resolved.kind === 'dw') return false
  if (resolved.kind === 'path') return resolved.candidates.length === 0
  if (resolved.path !== null) return false
  return resolved.form === 'cartridge' || resolved.form === 'current' || resolved.form === 'relative'
}

/** Every step type id the checkout declares, by file: what `steptypes_duplicate_id` reads across files. */
export type StepTypeIds = ReadonlyMap<string, readonly (Spot & { id: string })[]>

export function checkStepTypes(lookup: Lookup, path: string, uses: StepTypesUses, others: StepTypeIds): Problem[] {
  const out = [...uses.own]
  for (const use of uses.modules) if (moduleMissing(lookup, path, use.module)) out.push(problem('steptypes_module_missing', use, { module: use.module }))
  const seen = new Set<string>()
  // The files before this one, in path order, whose cartridge shares a storefront with it.
  const mine = new Set(lookup.storefrontsOf(path).map((storefront) => storefront.id))
  const earlier = new Set<string>()
  for (const [other, ids] of others) {
    if (other >= path) continue
    const theirs = lookup.storefrontsOf(other).map((storefront) => storefront.id)
    const shared = lookup.storefronts.length === 0 || theirs.some((id) => mine.has(id))
    if (shared) for (const each of ids) earlier.add(each.id)
  }
  for (const use of uses.ids) {
    if (seen.has(use.id) || earlier.has(use.id)) out.push(problem('steptypes_duplicate_id', use, { id: use.id }))
    seen.add(use.id)
  }
  return out
}
