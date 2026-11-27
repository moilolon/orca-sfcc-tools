// The three-way merge of an outside write (an agent writes the file while a person edits it).
// Both sides are compared with their common base line by line (a Myers diff, each line with its
// own line break, so CRLF and LF survive as written); the changes of both sides are applied where
// they do not overlap. Where they do, the same change on both sides is applied once, and differing
// changes keep the person's version of that region: their typing is never lost, and the region
// is counted as a conflict. Pure.

/** Lines with their breaks; joined with '' they give the text back. */
export function linesOf(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []
}

/** Base lines `start..end` (end excluded) became `lines`. */
export type Hunk = { start: number; end: number; lines: string[] }

/** Beyond this many differing lines the middle of two texts counts as one change. */
export const MAX_EDIT_DISTANCE = 2_000

/** The changes that turn `a` into `b`, in order. */
export function diffLines(a: readonly string[], b: readonly string[], maxDistance = MAX_EDIT_DISTANCE): Hunk[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const A = a.slice(head, a.length - tail)
  const B = b.slice(head, b.length - tail)
  if (A.length === 0 && B.length === 0) return []
  const whole: Hunk[] = [{ start: head, end: head + A.length, lines: B }]
  if (A.length === 0 || B.length === 0) return whole
  const pairs = matches(A, B, maxDistance)
  if (pairs === null) return whole
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  for (const [x, y] of pairs) {
    if (x > i || y > j) hunks.push({ start: head + i, end: head + x, lines: B.slice(j, y) })
    i = x + 1
    j = y + 1
  }
  if (i < A.length || j < B.length) hunks.push({ start: head + i, end: head + A.length, lines: B.slice(j) })
  return hunks
}

/** The lines both keep, as index pairs in order (Myers' greedy algorithm); null past `maxDistance`. */
function matches(A: readonly string[], B: readonly string[], maxDistance: number): [number, number][] | null {
  const N = A.length
  const M = B.length
  const max = Math.min(N + M, maxDistance)
  const offset = max + 1
  const V = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found === -1; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1]) ? V[offset + k + 1] : V[offset + k - 1] + 1
      let y = x - k
      while (x < N && y < M && A[x] === B[y]) {
        x++
        y++
      }
      V[offset + k] = x
      if (x >= N && y >= M) {
        found = d
        break
      }
    }
    trace.push(V.slice(offset - d - 1, offset + d + 2))
  }
  if (found === -1) return null
  const pairs: [number, number][] = []
  let x = N
  let y = M
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]
    // `prev` holds V[-d..d] of step d - 1, at index k + d.
    const at = (k: number) => prev[k + d]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    // The diagonal run after the edit of step d, back to the point the edit reached.
    while (x > prevX && y > prevY) {
      pairs.push([x - 1, y - 1])
      x--
      y--
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    pairs.push([x - 1, y - 1])
    x--
    y--
  }
  return pairs.reverse()
}

export type MergeResult = { text: string; conflicts: number }

type Tagged = Hunk & { side: 'mine' | 'outside' }

function apply(base: readonly string[], start: number, end: number, hunks: readonly Hunk[]): string[] {
  const out: string[] = []
  let at = start
  for (const hunk of hunks) {
    for (let i = at; i < hunk.start; i++) out.push(base[i])
    out.push(...hunk.lines)
    at = hunk.end
  }
  for (let i = at; i < end; i++) out.push(base[i])
  return out
}

/** Merges `outside` and `mine`, both made from `base`. */
export function merge3(base: string, outside: string, mine: string): MergeResult {
  if (mine === base || outside === mine) return { text: outside, conflicts: 0 }
  if (outside === base) return { text: mine, conflicts: 0 }
  const B = linesOf(base)
  const all: Tagged[] = [
    ...diffLines(B, linesOf(mine)).map((hunk) => ({ ...hunk, side: 'mine' as const })),
    ...diffLines(B, linesOf(outside)).map((hunk) => ({ ...hunk, side: 'outside' as const }))
  ].sort((x, y) => x.start - y.start || x.end - y.end || (x.side === 'outside' ? -1 : 1))
  // Clusters of hunks that overlap: a change inside another, or two insertions at one place.
  const clusters: Tagged[][] = []
  let end = -1
  for (const hunk of all) {
    const last = clusters[clusters.length - 1]
    const empty = hunk.start === hunk.end
    const joins = last && (hunk.start < end || (empty && hunk.start === end && last.some((h) => h.start === h.end && h.start === hunk.start)))
    if (joins) {
      last.push(hunk)
      end = Math.max(end, hunk.end)
    } else {
      clusters.push([hunk])
      end = hunk.end
    }
  }
  const out: string[] = []
  let at = 0
  let conflicts = 0
  for (const cluster of clusters) {
    const start = Math.min(...cluster.map((h) => h.start))
    const stop = Math.max(...cluster.map((h) => h.end))
    for (let i = at; i < start; i++) out.push(B[i])
    const mineHunks = cluster.filter((h) => h.side === 'mine')
    const outsideHunks = cluster.filter((h) => h.side === 'outside')
    if (mineHunks.length === 0 || outsideHunks.length === 0) {
      out.push(...apply(B, start, stop, cluster))
    } else {
      const mineText = apply(B, start, stop, mineHunks)
      const outsideText = apply(B, start, stop, outsideHunks)
      if (mineText.join('') !== outsideText.join('')) conflicts++
      out.push(...mineText)
    }
    at = stop
  }
  for (let i = at; i < B.length; i++) out.push(B[i])
  return { text: out.join(''), conflicts }
}
