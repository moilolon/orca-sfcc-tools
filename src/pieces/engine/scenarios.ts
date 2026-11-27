// The engine piece's check scenarios: each state of the Problems view worth a look, drawn by
// `orca plugin check` and captured with `orca plugin shot . --scenario <name>`. src/panel/checks.ts
// merges them; every name starts with `engine`. Each stubs the piece's requests with invented
// problems of an invented checkout (two storefronts, a garden shop and its outlet), listed by the
// same code as the worker's (`problems/list.ts`), so no checkout is read.
import type { PieceScenarios } from '../../panel/scenarios'
import { countProblems, PROBLEM_SEVERITY, type Problem, type ProblemArgs, type ProblemCode } from './problems/problem'
import { listPage, listQuery, matchProblems } from './problems/list'
import type { ProblemsList, ProblemsOfFile, ProblemsState } from './protocol'

const MINUTE = 60_000
const BASE = 'cartridges/app_garden_base/cartridge'
const CORE = 'cartridges/app_garden_core/cartridge'
const OUTLET = 'cartridges/app_garden_outlet'

function made(code: ProblemCode, line: number, args: ProblemArgs = {}, column = 5): Problem {
  return { code, severity: PROBLEM_SEVERITY[code], start: line * 40 + column, end: line * 40 + column + 8, line, column, args }
}

/** Invented problems, by file, in path order. */
function invented(): [string, Problem[]][] {
  return [
    [`${BASE}/controllers/Product.js`, [made('route_missing', 31, { route: 'QuickView' }, 1), made('template_partial', 34, { name: 'product/quickView', storefronts: 'GardenShop' }, 16)]],
    [`${BASE}/forms/default/newsletter.xml`, [made('form_unknown_attribute', 3, { attribute: 'required', element: 'field' }, 46), made('form_duplicate_id', 4, { id: 'email' }, 19)]],
    [
      `${BASE}/scripts/helpers/priceHelper.js`,
      [
        made('unknown_attribute', 12, { name: 'gardenSize', type: 'Product' }, 28),
        made('unknown_preference', 18, { name: 'gardenFreeShipping' }, 52),
        made('resource_missing', 22, { key: 'label.discount', bundle: 'product' }, 30),
        made('bundle_missing', 25, { bundle: 'garden' }, 44),
        made('unknown_attribute', 31, { name: 'gardenSeason', type: 'Product' }, 28),
        made('resource_partial', 40, { key: 'label.sale', bundle: 'product', storefronts: 'GardenShop' }, 30)
      ]
    ],
    [`${BASE}/templates/default/product/productDetails.isml`, [made('template_missing', 1, { name: 'common/layout/page' }, 23), made('resource_missing', 8, { key: 'label.stock.low', bundle: 'product' }, 25)]],
    [`${CORE}/controllers/Product.js`, [made('route_redefined', 27, { route: 'Compare' }, 1)]],
    [`${OUTLET}/steptypes.json`, [made('steptypes_module_missing', 9, { module: 'app_garden_outlet/cartridge/scripts/jobs/cleanStock.js' }, 21), made('steptypes_duplicate_id', 16, { id: 'custom.Garden.CleanStock' }, 22)]]
  ]
}

/** 1,000 invented problems over 200 files: what the view draws a page of. */
function many(): [string, Problem[]][] {
  return Array.from({ length: 200 }, (_, file) => [
    `${BASE}/scripts/generated/module${String(file).padStart(3, '0')}.js`,
    Array.from({ length: 5 }, (_, i) => (i % 2 === 0 ? made('unknown_attribute', 10 + i * 7, { name: `gardenField${i}`, type: 'Product' }) : made('resource_missing', 10 + i * 7, { key: `label.key${i}`, bundle: 'garden' })))
  ])
}

function listAnswer(entries: [string, Problem[]][], state: ProblemsState, input: unknown, overrides: Partial<ProblemsList> = {}): ProblemsList {
  const query = listQuery(input)
  const { matching, page } = state === 'ready' ? listPage(entries, query) : { matching: { problems: 0, files: 0, listable: 0 }, page: [] }
  const now = Date.now()
  return {
    workspaceId: state === 'none' ? null : 'w-garden',
    state,
    error: state === 'failed' ? 'analysis_failed' : null,
    busy: false,
    counts: state === 'ready' ? countProblems(entries.map(([, problems]) => problems)) : { error: 0, warning: 0, info: 0 },
    files: state === 'ready' ? entries.length : 0,
    matching,
    page,
    analysedAt: state === 'ready' ? now - 3 * MINUTE : null,
    analysisMs: state === 'ready' ? 4_200 : null,
    version: 1,
    ...overrides
  }
}

function fileAnswer(entries: [string, Problem[]][], input: unknown): ProblemsOfFile {
  const path = (input as { path?: string }).path ?? ''
  const query = listQuery(input)
  const found = matchProblems(path, entries.find(([each]) => each === path)?.[1] ?? [], query.severity, query.search)
  return { path, problems: found.slice(0, query.limit), total: found.length, version: 1 }
}

/** Answers every request of the view from one state. */
function requests(entries: [string, Problem[]][], state: ProblemsState, overrides: Partial<ProblemsList> = {}) {
  return {
    'engine.problems.list': (input: unknown) => listAnswer(entries, state, input, overrides),
    'engine.problems.refresh': (input: unknown) => listAnswer(entries, state, input, overrides),
    'engine.problems.file': (input: unknown) => fileAnswer(entries, input),
    'engine.problems.open': () => ({ opened: true })
  }
}

export const scenarios: PieceScenarios = {
  /** Problems of every severity in six files: counts, the filter, the files and their first problems. */
  engine: { requests: requests(invented(), 'ready') },
  /** A pass over the checkout runs again after a change: the list stays, a line says so. */
  engineBusy: { requests: requests(invented(), 'ready', { busy: true }) },
  /** The checkout has no problem. */
  engineClean: { requests: requests([], 'ready') },
  /** Notes only, picked by the filter, and none: nothing matches. */
  engineNoMatch: {
    persisted: { plugin: { engineSeverity: 'info' } },
    requests: requests(
      invented().map(([path, problems]) => [path, problems.filter((each) => each.severity !== 'info')] as [string, Problem[]]).filter(([, problems]) => problems.length > 0),
      'ready'
    )
  },
  /** The detail of one file: all its problems, with a way back. */
  engineFile: { persisted: { plugin: { engineFile: `${BASE}/scripts/helpers/priceHelper.js` } }, requests: requests(invented(), 'ready') },
  /** No workspace to analyse: none uploads, none is focused, or it is on another host. */
  engineNone: { requests: requests([], 'none') },
  /** The index is being built. */
  engineIndexing: { requests: requests([], 'indexing') },
  /** The first pass over the checkout runs. */
  engineAnalysing: { requests: requests([], 'analysing') },
  /** The pass failed. */
  engineFailed: { requests: requests([], 'failed') },
  /** 1,000 problems in 200 files: a page drawn, *Show more* under it. */
  engineMany: { requests: requests(many(), 'ready') }
}
