// Where a held breakpoint (one clicked on a line written since the last save, marks.ts) goes through
// one edit of the buffer. Saved breakpoints are not moved this way: they are drawn through the line
// diff from the file as saved (src/pieces/debugger/line-diff.ts). Lines are 0-based. Pure.
//
// The rule for one replace of the lines `from..oldEnd` by `from..newEnd`:
// - a line above it stays, a line below it moves by the lines added or removed;
// - its first line stays, unless text ending in a line break was inserted at its start (Enter at
//   the start of a line, a pasted block): then that line's text moved down, and so does the line;
// - a line inside the range, whose text was removed or joined, goes where the range's last line's
//   tail went (`newEnd`).

/** What of a change the rule needs: where it starts, what it removed and inserted. */
export type LineChange = { from: { line: number; col: number }; removed: string; inserted: string }

const ENDS_IN_BREAK = /(\r\n|\r|\n)$/

/** Where a line goes through one change: the rule above. */
export function moveLine(line: number, fromLine: number, oldEnd: number, newEnd: number, change: LineChange): number {
  if (line < fromLine) return line
  if (line > oldEnd) return line + newEnd - oldEnd
  if (line === fromLine) return change.from.col === 0 && change.removed === '' && ENDS_IN_BREAK.test(change.inserted) ? newEnd : fromLine
  return newEnd
}

/** Whether a change can move a line at all: one edited inside a single line moves none. */
export function movesLines(fromLine: number, oldEnd: number, newEnd: number): boolean {
  return !(fromLine === oldEnd && oldEnd === newEnd)
}
