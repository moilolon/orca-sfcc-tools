// The keys of the language features, read inside the editor frame (no manifest keybinding, so no
// new approval). None is one of Orca's own shortcuts (its keybinding list: Mod+K, Mod+P, Mod+E,
// Mod+B, Mod+L, Mod+Shift+E/F/G, F7 and Shift+F7, Alt+Z, …): F12 and Shift+F12 as most editors
// have them, Ctrl+Space and Ctrl+Shift+Space (Ctrl on a Mac too: Cmd+Space is the system's), and
// Mod+I for the hover at the caret. Pure: a key is described, not a DOM event.

/** A key as the frame's keydown event gives it. */
export type KeyPress = { key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }

/** What a key asks of the features. */
export type FeatureKey = 'complete' | 'signature' | 'hover' | 'definition' | 'references'

/** The shortcuts, as a person reads them (the hint of a check, the pull request). */
export const SHORTCUTS: Readonly<Record<FeatureKey, string>> = {
  complete: 'Ctrl+Space',
  signature: 'Ctrl+Shift+Space',
  hover: 'Mod+I',
  definition: 'F12, Mod+click',
  references: 'Shift+F12'
}

const isSpace = (key: string) => key === ' ' || key === 'Spacebar'

export function featureKey(press: KeyPress, isMac: boolean): FeatureKey | null {
  const mod = isMac ? press.meta : press.ctrl
  const other = isMac ? press.ctrl : press.meta
  if (press.key === 'F12' && !press.ctrl && !press.meta && !press.alt) return press.shift ? 'references' : 'definition'
  if (isSpace(press.key) && press.ctrl && !press.meta && !press.alt) return press.shift ? 'signature' : 'complete'
  if ((press.key === 'i' || press.key === 'I') && mod && !other && !press.alt && !press.shift) return 'hover'
  return null
}

/** What a key does to an open list: move, accept, close. Other keys go on to the editor. */
export type ListKey = 'up' | 'down' | 'pageUp' | 'pageDown' | 'accept' | 'close'

export function listKey(press: KeyPress, acceptsTab: boolean): ListKey | null {
  if (press.ctrl || press.meta || press.alt) return null
  switch (press.key) {
    case 'ArrowUp':
      return press.shift ? null : 'up'
    case 'ArrowDown':
      return press.shift ? null : 'down'
    case 'PageUp':
      return press.shift ? null : 'pageUp'
    case 'PageDown':
      return press.shift ? null : 'pageDown'
    case 'Enter':
      return press.shift ? null : 'accept'
    case 'Tab':
      return acceptsTab && !press.shift ? 'accept' : null
    case 'Escape':
      return 'close'
  }
  return null
}
