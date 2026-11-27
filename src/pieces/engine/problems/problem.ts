// What a problem is (phase 6.5): a code, a severity, a range of the file's text with its line and
// column, and the names its message needs (`args`). Nothing here is worded: the panel and the
// editor word a problem from its code and args in their language (`i18n.ts`). Pure: no Node, no
// Orca.
import { lineAt, lineStarts } from '../checkout/files'

/**
 * `error`: what the platform refuses or cannot read (a route chain SFRA throws on, a form or
 * `steptypes.json` that does not parse); `warning`: a name that exists nowhere it should; `info`:
 * a name that exists on some storefronts only, the weaker warning.
 */
export type Severity = 'error' | 'warning' | 'info'

export const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info']

export type ProblemCounts = Record<Severity, number>

export function emptyCounts(): ProblemCounts {
  return { error: 0, warning: 0, info: 0 }
}

export function countProblems(problems: Iterable<readonly Problem[]>): ProblemCounts {
  const counts = emptyCounts()
  for (const list of problems) for (const each of list) counts[each.severity]++
  return counts
}

/** Every problem the engine reports, with its severity. */
export const PROBLEM_SEVERITY = {
  // Scripts and templates (`code.ts`).
  unknown_attribute: 'warning',
  unknown_preference: 'warning',
  template_missing: 'warning',
  template_partial: 'info',
  resource_missing: 'warning',
  resource_partial: 'info',
  bundle_missing: 'warning',
  // Route chains (`routes.ts`).
  route_redefined: 'error',
  route_missing: 'error',
  base_missing: 'error',
  not_exported: 'error',
  // Form definitions (`forms.ts`).
  form_malformed: 'error',
  form_unknown_element: 'warning',
  form_unknown_attribute: 'warning',
  form_duplicate_id: 'error',
  form_include_missing: 'warning',
  form_include_partial: 'info',
  // `steptypes.json` (`steptypes.ts`).
  steptypes_invalid: 'error',
  steptypes_missing_key: 'error',
  steptypes_module_missing: 'error',
  steptypes_duplicate_id: 'error'
} as const satisfies Record<string, Severity>

export type ProblemCode = keyof typeof PROBLEM_SEVERITY

export const PROBLEM_CODES = Object.keys(PROBLEM_SEVERITY) as ProblemCode[]

/**
 * The names a message is made of, each optional: `name` (an attribute, a preference, a template,
 * a form), `type` (an object type), `key` and `bundle` (a resource), `route`, `module`, `id` (a
 * form id or a step type id), `element` and `attribute` (of a form), `reason` (why XML or JSON
 * does not parse, a code), and `storefronts` (where a name is missing, comma-separated).
 */
export type ProblemArgs = Partial<Record<'name' | 'type' | 'key' | 'bundle' | 'route' | 'module' | 'id' | 'element' | 'attribute' | 'reason' | 'storefronts', string>>

export type Problem = {
  code: ProblemCode
  severity: Severity
  /** The range in the file's text (UTF-16 offsets, `end` exclusive). */
  start: number
  end: number
  /** 1-based. */
  line: number
  column: number
  args: ProblemArgs
}

/** A place in a text, with its 1-based line and column. */
export type Spot = { start: number; end: number; line: number; column: number }

/** Lines and columns of one text, its line starts computed once. */
export class Lines {
  private readonly starts: number[]
  private readonly length: number
  constructor(text: string) {
    this.starts = lineStarts(text)
    this.length = text.length
  }

  /** A range of the text, clamped to it: a range read from another version of the file stays inside this one. */
  spot(from: number, to = from): Spot {
    const start = Math.max(0, Math.min(from, this.length))
    const end = Math.max(start, Math.min(to, this.length))
    const line = lineAt(this.starts, start)
    return { start, end, line, column: start - (this.starts[line - 1] ?? 0) + 1 }
  }
}

export function problem(code: ProblemCode, spot: Spot, args: ProblemArgs = {}): Problem {
  return { code, severity: PROBLEM_SEVERITY[code], start: spot.start, end: spot.end, line: spot.line, column: spot.column, args }
}

/** Problems in the order of the text, then by code. */
export function sortProblems(problems: Problem[]): Problem[] {
  return problems.sort((a, b) => a.start - b.start || a.end - b.end || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

/** What identifies a problem across edits that move it: its code and its names, never its place. */
export function problemKey(problem: Problem): string {
  const args = Object.keys(problem.args)
    .sort()
    .map((key) => `${key}=${problem.args[key as keyof ProblemArgs]}`)
  return `${problem.code}|${args.join('|')}`
}

/**
 * How many problems of `after` are new against `before`: each key counted as many times as it
 * appears, so a second unknown attribute of the same name is new too.
 */
export function newProblems(before: readonly Problem[], after: readonly Problem[]): number {
  const known = new Map<string, number>()
  for (const each of before) known.set(problemKey(each), (known.get(problemKey(each)) ?? 0) + 1)
  let count = 0
  for (const each of after) {
    const key = problemKey(each)
    const left = known.get(key) ?? 0
    if (left > 0) known.set(key, left - 1)
    else count++
  }
  return count
}

/** The storefronts a name is missing on, for a message: at most three named, then how many more. */
export function storefrontList(ids: readonly string[]): string {
  const sorted = [...ids].sort()
  return sorted.length <= 3 ? sorted.join(', ') : `${sorted.slice(0, 3).join(', ')} +${sorted.length - 3}`
}
