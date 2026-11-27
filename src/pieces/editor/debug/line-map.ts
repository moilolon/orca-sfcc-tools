// Where each line of the file as saved stands in the editor now, through every edit since the last
// save: what moves a breakpoint when lines are inserted or removed above it, as an editor does.
// Lines are 0-based here. Pure: no DOM, no Orca.
//
// The rule for one replace of the lines `from..oldEnd` by `from..newEnd`:
// - a line above it stays, a line below it moves by the lines added or removed;
// - its first line stays, unless text ending in a line break was inserted at its start (Enter at
//   the start of a line, a pasted block): then that line's text moved down, and so does the line;
// - a line inside the range, whose text was removed or joined, goes where the range's last line's
//   tail went (`newEnd`): Backspace at a line's start takes it to the line above.

/** What of a change the map needs: where it starts, what it removed and inserted. */
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

export class LineMap {
  /** The line now of each saved line. */
  private targets: Int32Array

  constructor(lineCount: number) {
    this.targets = new Int32Array(Math.max(0, lineCount))
    for (let i = 0; i < this.targets.length; i++) this.targets[i] = i
  }

  /** How many lines the file had when saved. */
  get size(): number {
    return this.targets.length
  }

  /** Where a saved line is now; null for one past the saved file's end. */
  current(saved: number): number | null {
    return saved >= 0 && saved < this.targets.length ? this.targets[saved] : null
  }

  /**
   * The saved lines now at `line` (several when their text was joined), in order; empty for a line
   * written since the save.
   */
  savedAt(line: number): number[] {
    const found: number[] = []
    for (let i = 0; i < this.targets.length; i++) if (this.targets[i] === line) found.push(i)
    return found
  }

  /** Follows one change of the buffer. */
  apply(fromLine: number, oldEnd: number, newEnd: number, change: LineChange): void {
    if (!movesLines(fromLine, oldEnd, newEnd)) return
    const targets = this.targets
    for (let i = 0; i < targets.length; i++) targets[i] = moveLine(targets[i], fromLine, oldEnd, newEnd, change)
  }
}
