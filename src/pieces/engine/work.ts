// The work the syntax layer does, counted: characters its scans read (an ISML construct's span,
// a search for an end, a token, a scan the parser throws away and reads again) and the steps of
// the facts' walk and name lookups. A test proves a parse linear in its input with it, without a
// clock (limits.test.ts): the count at four times the size is about four times the count. Pure:
// a counter that only grows, read before and after a parse; nothing else reads it.

let counted = 0

/** Adds `amount` steps of work. */
export function countWork(amount: number): void {
  counted += amount
}

/** Every step counted since the module loaded: read before and after a parse, never reset. */
export function workCounted(): number {
  return counted
}
