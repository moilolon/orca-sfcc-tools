// What the Problems view lists of the checkout's problems: the files that match a severity and a
// search, in path order, each with its first problems, until a number of problems is listed. Pure:
// no Node, no Orca; the worker masks what it hands out.
import { countProblems, type Problem, type Severity } from './problem'

/** How many problems the list draws per file; the rest are in the file's detail. */
export const FILE_PROBLEMS_SHOWN = 5
/** The most problems one answer lists. */
export const MAX_LISTED_PROBLEMS = 100
/** How many problems the view asks for when it says nothing. */
export const DEFAULT_LISTED_PROBLEMS = 25

export type SeverityFilter = 'all' | Severity

export type ListQuery = { severity: SeverityFilter; search: string; limit: number }

export type ListedFile = { path: string; counts: Record<Severity, number>; problems: Problem[]; more: number }

export type ListPage = { matching: { problems: number; files: number; listable: number }; page: ListedFile[] }

/** A query as given, checked: an unknown severity is all of them, a limit is kept within its bounds. */
export function listQuery(input: unknown): ListQuery {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const severity = raw.severity === 'error' || raw.severity === 'warning' || raw.severity === 'info' ? raw.severity : 'all'
  const search = typeof raw.search === 'string' ? raw.search.slice(0, 200) : ''
  const limit = typeof raw.limit === 'number' && Number.isInteger(raw.limit) && raw.limit > 0 ? Math.min(raw.limit, MAX_LISTED_PROBLEMS) : DEFAULT_LISTED_PROBLEMS
  return { severity, search, limit }
}

/** What the filter and the search keep of a file's problems; the search matches the path, or a name or the code of a problem. */
export function matchProblems(path: string, problems: readonly Problem[], severity: SeverityFilter, search: string): Problem[] {
  const words = search.trim().toLowerCase()
  const inPath = words !== '' && path.toLowerCase().includes(words)
  return problems.filter((each) => {
    if (severity !== 'all' && each.severity !== severity) return false
    if (words === '' || inPath) return true
    return each.code.includes(words) || Object.values(each.args).some((value) => typeof value === 'string' && value.toLowerCase().includes(words))
  })
}

/** The page of files a query lists, from every file with problems in path order. */
export function listPage(entries: Iterable<readonly [string, readonly Problem[]]>, query: ListQuery): ListPage {
  const page: ListedFile[] = []
  const matching = { problems: 0, files: 0, listable: 0 }
  let listed = 0
  for (const [path, problems] of entries) {
    const found = matchProblems(path, problems, query.severity, query.search)
    if (found.length === 0) continue
    matching.files++
    matching.problems += found.length
    matching.listable += Math.min(found.length, FILE_PROBLEMS_SHOWN)
    if (listed >= query.limit) continue
    const drawn = found.slice(0, Math.min(FILE_PROBLEMS_SHOWN, query.limit - listed))
    listed += drawn.length
    page.push({ path, counts: countProblems([problems]), problems: drawn, more: found.length - drawn.length })
  }
  return { matching, page }
}
