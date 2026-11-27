// Which file the editor shows, as the frame knows it: what the features that read other files
// (7.2: go to definition, completion of other files' names) look at before they ask the engine.
// Pure: a small store with listeners.

export type Identity =
  /** Not asked yet, or the worker has not answered. */
  | { state: 'pending' }
  /** The file, its path relative to the workspace. */
  | { state: 'identified'; workspaceId: string; path: string }
  /** Several files hold this text and the person has not chosen. */
  | { state: 'ambiguous'; workspaceId: string; candidates: string[]; more: number }
  /** No file holds this text (unsaved edits, a new file), or no workspace on this machine. */
  | { state: 'unknown' }

export class IdentityStore {
  private current: Identity = { state: 'pending' }
  private readonly listeners: ((identity: Identity) => void)[] = []

  get value(): Identity {
    return this.current
  }

  /** Whether the features that read other files may run. */
  get crossFile(): boolean {
    return this.current.state === 'identified'
  }

  set(identity: Identity): void {
    this.current = identity
    for (const listener of [...this.listeners]) listener(identity)
  }

  subscribe(listener: (identity: Identity) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const at = this.listeners.indexOf(listener)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }
}
