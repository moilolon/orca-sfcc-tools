// The problems of one file, whatever it is: a server script or template (`code.ts`, and
// `routes.ts` for a controller), a form definition (`forms.ts`) or a `steptypes.json`
// (`steptypes.ts`). Two steps: `readUses` reads what the text names (the costly part, done when a
// file changes), `checkUses` checks it against the checkout as `Lookup` read it. Pure: no Node, no
// Orca.
import { analyse } from '../query/analysis'
import type { QueryContext } from '../query/modules'
import { MAX_PARSED_CHARACTERS } from '../checkout/scan'
import { checkCode, codeUses, type CodeUses } from './code'
import { checkForm, formUses, isFormPath, type FormUses } from './forms'
import type { Lookup } from './lookup'
import { Lines, sortProblems, type Problem } from './problem'
import { checkRoutes, hasRouteProblems } from './routes'
import { checkStepTypes, isStepTypesPath, stepTypesUses, type StepTypeIds, type StepTypesUses } from './steptypes'

/** At most this many problems are kept per file: past it, a file has more than anyone reads. */
export const MAX_FILE_PROBLEMS = 500

/** What a file names, read once from its text. A controller keeps its lines, to place its route problems. */
export type FileUses = (CodeUses & { lines: Lines | null }) | FormUses | StepTypesUses

export type ProblemFileKind = 'code' | 'form' | 'steptypes'

/**
 * What a path is to the problems: a server script or template of a cartridge (`.js`/`.ds` under
 * `cartridge/` but `static/` and `client/`, `.isml` under `cartridge/templates/<locale>/`), a form
 * definition, a `steptypes.json`; null for anything else. `cartridgeRoot` is the folder of the
 * file's cartridge, relative to the checkout.
 */
export function problemFileKind(path: string, cartridgeRoot: string | null): ProblemFileKind | null {
  if (cartridgeRoot === null) return null
  const rel = cartridgeRoot === '' ? path : path.slice(cartridgeRoot.length + 1)
  if (isStepTypesPath(rel) && (rel === 'steptypes.json' || rel === 'cartridge/steptypes.json')) return 'steptypes'
  if (isFormPath(path) && rel.startsWith('cartridge/forms/')) return 'form'
  if (!rel.startsWith('cartridge/')) return null
  const inner = rel.slice('cartridge/'.length)
  if (/^(static|client)\//.test(inner)) return null
  if (/\.(js|ds)$/i.test(inner)) return 'code'
  if (/^templates\/[^/]+\/.+\.isml$/i.test(inner) && !inner.startsWith('templates/resources/')) return 'code'
  return null
}

/** Whether a script is a controller: its route problems are placed in its lines. */
function isController(path: string): boolean {
  return /\/cartridge\/controllers\/[^/]+\.(js|ds)$/i.test(path)
}

/** Reads what a text names, as the file `path` of the kind given. */
export function readUses(ctx: QueryContext, path: string, kind: ProblemFileKind, text: string): FileUses {
  if (kind === 'form') return formUses(text)
  if (kind === 'steptypes') return stepTypesUses(text)
  const uses = codeUses(ctx, analyse(path, text))
  return { ...uses, lines: isController(path) && text.length <= MAX_PARSED_CHARACTERS ? new Lines(text) : null }
}

/** The problems of a file from what it names, against the checkout as `lookup` read it. */
export function checkUses(lookup: Lookup, path: string, uses: FileUses, stepTypeIds: StepTypeIds): Problem[] {
  let out: Problem[]
  if (uses.kind === 'form') out = checkForm(lookup, path, uses)
  else if (uses.kind === 'steptypes') out = checkStepTypes(lookup, path, uses, stepTypeIds)
  else {
    out = checkCode(lookup, path, uses)
    if (uses.lines && hasRouteProblems(lookup, path)) out.push(...checkRoutes(lookup, path, uses.lines))
  }
  sortProblems(out)
  return out.length > MAX_FILE_PROBLEMS ? out.slice(0, MAX_FILE_PROBLEMS) : out
}
