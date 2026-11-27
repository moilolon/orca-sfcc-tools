// The editor's own undo history: Orca keeps none for a plugin's editor, so Ctrl+Z reaches the
// frame. A step is a group of changes with the selection before and after it. Typing in one place
// within `GROUP_MS` is one step; anything else (a paste, a cut, Enter, a deletion of a selection,
// an outside change) is its own. Bounded by steps and by the characters they hold. Pure.
import { comparePos, endOf, type Change, type Pos, type TextBuffer } from './buffer'

export type Selection = { readonly anchor: Pos; readonly head: Pos }

/** What made a change: typing groups with typing next to it, deleting with deleting. */
export type ChangeKind = 'type' | 'delete' | 'insert' | 'paste' | 'cut' | 'enter' | 'indent' | 'compose' | 'outside'

export type Step = {
  kind: ChangeKind
  changes: Change[]
  before: Selection
  after: Selection
  /** When the last change joined it; -Infinity once sealed. */
  time: number
}

/** Typing within this many milliseconds of the last key, where it left off, joins its step. */
export const GROUP_MS = 700
/** Steps kept; the oldest go first. */
export const MAX_STEPS = 1_000
/** Characters the steps may hold in all (a few large pastes); the oldest go first. */
export const MAX_CHARACTERS = 32 * 1024 * 1024

function size(step: Step): number {
  let n = 0
  for (const change of step.changes) n += change.removed.length + change.inserted.length
  return n
}

export class History {
  readonly done: Step[] = []
  readonly undone: Step[] = []
  private characters = 0
  private readonly now: () => number

  constructor(now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    this.now = now
  }

  clear(): void {
    this.done.length = 0
    this.undone.length = 0
    this.characters = 0
  }

  /** Records changes made together as one step, or joins the last step when they are typing that continues it. */
  record(changes: Change[], before: Selection, after: Selection, kind: ChangeKind): void {
    if (changes.length === 0) return
    const now = this.now()
    const top = this.done[this.done.length - 1]
    if (top && this.joins(top, changes, kind, now)) {
      top.changes.push(...changes)
      top.after = after
      top.time = now
    } else {
      this.done.push({ kind, changes: [...changes], before, after, time: now })
    }
    for (const change of changes) this.characters += change.removed.length + change.inserted.length
    for (const step of this.undone) this.characters -= size(step)
    this.undone.length = 0
    while (this.done.length > 1 && (this.done.length > MAX_STEPS || this.characters > MAX_CHARACTERS)) {
      this.characters -= size(this.done.shift() as Step)
    }
  }

  private joins(top: Step, changes: Change[], kind: ChangeKind, now: number): boolean {
    if (changes.length !== 1 || top.kind !== kind || now - top.time >= GROUP_MS) return false
    const last = top.changes[top.changes.length - 1]
    const change = changes[0]
    if (kind === 'type') {
      // Typing on: nothing removed, starting where the last insertion ended, on one line.
      return change.removed === '' && comparePos(change.from, last.end) === 0 && !/[\r\n]/.test(change.inserted)
    }
    if (kind === 'delete') {
      // Backspace runs end where the last one started; Delete runs start at the same place.
      const single = change.inserted === '' && !/[\r\n]/.test(change.removed)
      return single && (comparePos(endOf(change.from, change.removed), last.from) === 0 || comparePos(change.from, last.from) === 0)
    }
    return false
  }

  /** Ends the current group: the next key starts a step of its own (the caret moved, focus left). */
  seal(): void {
    const top = this.done[this.done.length - 1]
    if (top) top.time = -Infinity
  }

  get canUndo(): boolean {
    return this.done.length > 0
  }

  get canRedo(): boolean {
    return this.undone.length > 0
  }

  /** Undoes the last step on `buffer`; the selection to restore, or null with nothing to undo. */
  undo(buffer: TextBuffer): Selection | null {
    const step = this.done.pop()
    if (!step) return null
    for (let k = step.changes.length - 1; k >= 0; k--) {
      const change = step.changes[k]
      buffer.replace(change.from, change.end, change.removed)
    }
    step.time = -Infinity
    this.undone.push(step)
    return step.before
  }

  /** Redoes the last undone step on `buffer`; the selection to restore, or null. */
  redo(buffer: TextBuffer): Selection | null {
    const step = this.undone.pop()
    if (!step) return null
    for (const change of step.changes) buffer.replace(change.from, endOf(change.from, change.removed), change.inserted)
    step.time = -Infinity
    this.done.push(step)
    return step.after
  }
}
