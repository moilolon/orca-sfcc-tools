// Where each line of one text stands in another: what moves a breakpoint when its file changes.
// The worker remaps the store with it after every save (the file on disk before, the text saved
// after), and the editor draws its marks with it (the file as saved, the text now), so what the
// editor shows before a save is what the store holds after it. Pure: no Node, no Orca, no
// imports, so the editor's frame loads it too.
//
// The rule: lines equal at the start and the end match; in between, a shortest edit script
// (Myers' O(ND) diff) matches the rest of the equal lines. Its cost is bounded (`MAX_DIFF_WORK`
// steps): past it, the lines that occur once on both sides and keep their order anchor the match
// (patience), each anchor grown over the equal lines around it, so unchanged lines stay right in a
// file of any size. Each changed hunk then pairs its lines: as many new lines as old ones pair in
// order (a line rewritten in place keeps its breakpoint, even emptied while it is retyped); an
// uneven hunk pairs each old line with the new one it is most like (a line split by Enter keeps
// it on its first part; a blank line put before an edited one does not take it), and an old line
// like none was deleted, with its breakpoint. Undo gives the text back, and with it every line.
// Lines are 0-based; -1 is a deleted line.

/** Steps (line comparisons and diagonals tried) the exact diff may take before patience anchors take over. */
export const MAX_DIFF_WORK = 1_000_000
/** Edits the exact diff may find (its trace grows with their square); past them, patience anchors take over. */
export const MAX_DIFF_EDITS = 1_000

/** For each line of `before`, its line in `after`, or -1 when it was deleted. */
export function mapLines(before: readonly string[], after: readonly string[]): Int32Array {
  const n = before.length
  const m = after.length
  const map = new Int32Array(n).fill(-1)
  let start = 0
  while (start < n && start < m && before[start] === after[start]) {
    map[start] = start
    start++
  }
  let endBefore = n
  let endAfter = m
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
    map[endBefore] = endAfter
  }
  if (endBefore === start || endAfter === start) return map
  const matches = myers(before, start, endBefore, after, start, endAfter) ?? anchors(before, start, endBefore, after, start, endAfter)
  // Each hunk between two matches pairs its lines.
  let i = start
  let j = start
  for (const [mi, mj] of [...matches, [endBefore, endAfter] as const]) {
    pairHunk(before, i, mi, after, j, mj, map)
    if (mi < endBefore) map[mi] = mj
    i = mi + 1
    j = mj + 1
  }
  return map
}

/**
 * The equal lines of a shortest edit script between `before[a0..a1)` and `after[b0..b1)`, in
 * order (Myers, "An O(ND) difference algorithm"); null once it would take more than MAX_DIFF_WORK steps.
 */
function myers(before: readonly string[], a0: number, a1: number, after: readonly string[], b0: number, b1: number): (readonly [number, number])[] | null {
  const n = a1 - a0
  const m = b1 - b0
  const maxD = Math.min(n + m, MAX_DIFF_EDITS)
  const offset = maxD + 1
  const v = new Int32Array(2 * maxD + 3)
  const trace: Int32Array[] = []
  let work = 0
  for (let d = 0; d <= maxD; d++) {
    // The furthest x on each diagonal after d - 1 edits, kept for d's diagonals only.
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      const from = x
      while (x < n && y < m && before[a0 + x] === after[b0 + y]) {
        x++
        y++
      }
      work += 1 + x - from
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, d, n, m, a0, b0)
    }
    if (work > MAX_DIFF_WORK) return null
  }
  return null
}

/** Reads the equal lines back from the trace of a script of `d` edits. */
function backtrack(trace: Int32Array[], d: number, n: number, m: number, a0: number, b0: number): (readonly [number, number])[] {
  const pairs: (readonly [number, number])[] = []
  let x = n
  let y = m
  for (let step = d; step > 0; step--) {
    const row = trace[step]
    // row[i] is diagonal k = i - step - 1.
    const at = (k: number) => row[k + step + 1]
    const k = x - y
    const down = k === -step || (k !== step && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const startX = down ? prevX : prevX + 1
    while (x > startX && y > startX - k) {
      x--
      y--
      pairs.push([a0 + x, b0 + y])
    }
    x = prevX
    y = prevX - prevK
  }
  while (x > 0 && y > 0) {
    x--
    y--
    pairs.push([a0 + x, b0 + y])
  }
  return pairs.reverse()
}

/**
 * The match when the exact diff costs too much: lines that occur once in each range, in an order
 * both keep (the longest increasing run of their positions), each grown over the equal lines
 * before and after it.
 */
function anchors(before: readonly string[], a0: number, a1: number, after: readonly string[], b0: number, b1: number): (readonly [number, number])[] {
  const seen = new Map<string, { a: number; b: number; inA: number; inB: number }>()
  for (let i = a0; i < a1; i++) {
    const entry = seen.get(before[i]) ?? { a: i, b: -1, inA: 0, inB: 0 }
    entry.inA++
    seen.set(before[i], entry)
  }
  for (let j = b0; j < b1; j++) {
    const entry = seen.get(after[j])
    if (!entry) continue
    entry.inB++
    entry.b = j
  }
  const unique = [...seen.values()].filter((entry) => entry.inA === 1 && entry.inB === 1).sort((p, q) => p.a - q.a)
  // The longest run of unique lines whose positions increase on both sides (patience sorting).
  const tails: number[] = []
  const previous = new Int32Array(unique.length).fill(-1)
  for (let u = 0; u < unique.length; u++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (unique[tails[mid]].b < unique[u].b) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[u] = tails[lo - 1]
    tails[lo] = u
  }
  const chosen: number[] = []
  for (let u = tails.length > 0 ? tails[tails.length - 1] : -1; u >= 0; u = previous[u]) chosen.push(u)
  chosen.reverse()
  // Each anchor grown over the equal lines around it, up to the next one.
  const pairs: (readonly [number, number])[] = []
  let lastA = a0 - 1
  let lastB = b0 - 1
  for (let c = 0; c < chosen.length; c++) {
    const anchor = unique[chosen[c]]
    const nextA = c + 1 < chosen.length ? unique[chosen[c + 1]].a : a1
    const nextB = c + 1 < chosen.length ? unique[chosen[c + 1]].b : b1
    let back = 0
    while (anchor.a - back - 1 > lastA && anchor.b - back - 1 > lastB && before[anchor.a - back - 1] === after[anchor.b - back - 1]) back++
    for (let t = back; t > 0; t--) pairs.push([anchor.a - t, anchor.b - t])
    pairs.push([anchor.a, anchor.b])
    let ahead = 1
    while (anchor.a + ahead < nextA && anchor.b + ahead < nextB && before[anchor.a + ahead] === after[anchor.b + ahead]) {
      pairs.push([anchor.a + ahead, anchor.b + ahead])
      ahead++
    }
    lastA = anchor.a + ahead - 1
    lastB = anchor.b + ahead - 1
  }
  return pairs
}

/** Past this many pairs in one uneven hunk, its lines pair in order. */
const MAX_HUNK_CELLS = 10_000
/** How alike two lines must be to be one line edited, in a hunk of uneven size. */
const MIN_SIMILARITY = 0.4

/**
 * How alike two lines are, from 0 to 1: the share of the longer one that the common start and end
 * cover, indentation aside. Two blank lines are alike; a blank line and a written one are not.
 */
export function similarity(x: string, y: string): number {
  const a = x.trim()
  const b = y.trim()
  if (a === b) return 1
  if (!a || !b) return 0
  const max = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++
  let suffix = 0
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++
  return (prefix + suffix) / Math.max(a.length, b.length)
}

/**
 * Pairs the old lines `i0..i1` of a hunk with its new lines `j0..j1`. As many new lines as old
 * ones: in order, each rewritten in place. Otherwise each with the one it is most like, in order;
 * an old line like none was deleted. A large uneven hunk pairs in order.
 */
function pairHunk(before: readonly string[], i0: number, i1: number, after: readonly string[], j0: number, j1: number, map: Int32Array): void {
  const k = i1 - i0
  const m = j1 - j0
  if (k === 0 || m === 0) return
  if (k === m || k * m > MAX_HUNK_CELLS) {
    for (let t = 0; t < Math.min(k, m); t++) map[i0 + t] = j0 + t
    return
  }
  // best[a][b]: the most similarity old lines a… and new lines b… can pair for.
  const width = m + 1
  const best = new Float64Array((k + 1) * width)
  const alike = new Float64Array(k * m)
  for (let a = k - 1; a >= 0; a--) {
    for (let b = m - 1; b >= 0; b--) {
      const score = similarity(before[i0 + a], after[j0 + b])
      alike[a * m + b] = score
      const paired = score >= MIN_SIMILARITY ? score + best[(a + 1) * width + b + 1] : -1
      best[a * width + b] = Math.max(paired, best[(a + 1) * width + b], best[a * width + b + 1])
    }
  }
  let a = 0
  let b = 0
  while (a < k && b < m) {
    const score = alike[a * m + b]
    if (score >= MIN_SIMILARITY && score + best[(a + 1) * width + b + 1] >= best[a * width + b]) {
      map[i0 + a] = j0 + b
      a++
      b++
    } else if (best[(a + 1) * width + b] >= best[a * width + b + 1]) a++
    else b++
  }
}

/** The lines of a text as the editor's buffer splits them: CRLF, LF and a lone CR are breaks, a leading BOM is not text. */
export function textLines(text: string): string[] {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/)
}

/**
 * Breakpoint lines (1-based) of `before` carried to `after`: moved with their text, dropped with a
 * deleted line (or one past the end of `before`, which held nothing), once each, in order.
 */
export function remapLines(lines: readonly number[], before: readonly string[], after: readonly string[]): number[] {
  const map = mapLines(before, after)
  const moved = new Set<number>()
  for (const line of lines) {
    const to = Number.isInteger(line) && line >= 1 && line <= map.length ? map[line - 1] : -1
    if (to >= 0) moved.add(to + 1)
  }
  return [...moved].sort((x, y) => x - y)
}
