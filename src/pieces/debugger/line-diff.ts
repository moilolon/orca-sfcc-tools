// Where each line of one text stands in another: what moves a breakpoint when its file changes.
// The worker remaps the store with it on every save (the file on disk before, the text saved after),
// and the editor draws its marks with it (the file as saved, the text now), so what the editor shows
// before a save is what the store holds after it. Pure: no Node, no Orca, no imports, so the
// editor's frame loads it too.
//
// The rule: lines equal at the start and the end match; in between, the longest common run of
// equal lines matches, and each changed hunk pairs its old and new lines in order (a line edited
// in place keeps its breakpoint; a line split by Enter keeps it on its first part); the old lines
// a hunk has no new line for were deleted, and their breakpoints go. Undo gives the text back, and
// with it every line. Lines are 0-based; -1 is a deleted line.

/** Past this many cells (old lines times new lines between the equal start and end), hunks pair in order without a search. */
export const MAX_DIFF_CELLS = 1_000_000

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
  const a = endBefore - start
  const b = endAfter - start
  if (a === 0 || b === 0) return map
  const matches = a * b <= MAX_DIFF_CELLS ? common(before, start, a, after, start, b) : []
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

/** Past this many pairs in one hunk, its lines pair in order. */
const MAX_HUNK_CELLS = 10_000
/** How alike two lines must be to be one line edited. */
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
 * Pairs the old lines `i0..i1` of a hunk with its new lines `j0..j1`, in order, each with the one
 * it is most like (a line edited in place, a line split by Enter on its first part); an old line
 * like none was deleted. A large hunk pairs in order.
 */
function pairHunk(before: readonly string[], i0: number, i1: number, after: readonly string[], j0: number, j1: number, map: Int32Array): void {
  const k = i1 - i0
  const m = j1 - j0
  if (k === 0 || m === 0) return
  if (k * m > MAX_HUNK_CELLS) {
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

/** The longest common run of equal lines of two ranges, as pairs of lines, in order. */
function common(before: readonly string[], i0: number, a: number, after: readonly string[], j0: number, b: number): (readonly [number, number])[] {
  // lengths[i][j]: the longest common run of before[i0+i…] and after[j0+j…]; min(a, b) ≤ 1000 here, so 16 bits hold it.
  const width = b + 1
  const lengths = new Uint16Array((a + 1) * width)
  for (let i = a - 1; i >= 0; i--) {
    for (let j = b - 1; j >= 0; j--) {
      lengths[i * width + j] = before[i0 + i] === after[j0 + j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
    }
  }
  const pairs: (readonly [number, number])[] = []
  let i = 0
  let j = 0
  while (i < a && j < b) {
    if (before[i0 + i] === after[j0 + j]) {
      pairs.push([i0 + i, j0 + j])
      i++
      j++
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i++
    else j++
  }
  return pairs
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
    const to = line >= 1 && line <= map.length ? map[line - 1] : -1
    if (to >= 0) moved.add(to + 1)
  }
  return [...moved].sort((x, y) => x - y)
}
