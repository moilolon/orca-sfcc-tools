// The editor frame's side of `editor.locate`: it hashes the text (SHA-256 through the frame's
// `crypto.subtle`, so a large text never travels; the text itself when that is missing), asks the
// worker, and keeps the answer in the identity store. No DOM: main.ts draws what it decides.
//
// A save names a file only for the editor that saved it. Orca flushes an editor's pending edits
// just before it saves that editor's tab (`editor.flush`), and only that one; the worker then
// posts every save with its path and the hash of the text saved (`editor.saved`). An editor takes
// the path only when it was flushed within `OWN_SAVE_MS`, with that same text, and when the saves
// that match within `SAVE_SETTLE_MS` name one file (two tabs of identical files saved together
// name two, and prove nothing). Any other editor with the same text, an identical copy in another
// cartridge, is never named by it: it asks again only while it could not name its file.
import type { EditorLocated } from './protocol'
import type { Identity, IdentityStore } from './identity'

export type LocateRequests = {
  locate(input: { workspaceId: string | null; text?: string; hash?: string }): Promise<EditorLocated>
  choose(input: { workspaceId: string | null; text?: string; hash?: string; path: string }): Promise<{ ok: boolean }>
}

/** How long after an editor was flushed a save of its text is taken as its own. */
export const OWN_SAVE_MS = 5_000
/** How long the saves that may be an editor's own are gathered before it decides. */
export const SAVE_SETTLE_MS = 300

/** SHA-256 of a text as UTF-8, in hex; null where the frame has no `crypto.subtle`. */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type Located = { identity: Identity; line?: number; column?: number }

export type LocateClientOptions = {
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
}

/** A flush of this editor: when, the hash of its text then, and the saves gathered for it. */
type Flush = { at: number; hash: Promise<string | null>; paths: Set<string>; deciding: boolean }

export class LocateClient {
  /** Answers that came back for an older text are dropped. */
  private asked = 0
  private readonly requests: LocateRequests
  private readonly workspaceId: string | null
  private readonly identity: IdentityStore
  private readonly now: () => number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private flush: Flush | null = null

  constructor(requests: LocateRequests, workspaceId: string | null, identity: IdentityStore, options: LocateClientOptions = {}) {
    this.requests = requests
    this.workspaceId = workspaceId
    this.identity = identity
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
  }

  private async textInput(text: string): Promise<{ text?: string; hash?: string }> {
    const hash = await sha256Hex(text)
    return hash ? { hash } : { text }
  }

  /** Asks which file holds `text`; sets the identity, and gives the line to show when the plugin opened the file at one. */
  async locate(text: string): Promise<Located> {
    const mine = ++this.asked
    if (this.workspaceId === null) {
      const identity: Identity = { state: 'unknown' }
      this.identity.set(identity)
      return { identity }
    }
    let answer: EditorLocated = null
    try {
      answer = await this.requests.locate({ workspaceId: this.workspaceId, ...(await this.textInput(text)) })
    } catch {
      answer = null
    }
    if (mine !== this.asked) return { identity: this.identity.value }
    let identity: Identity
    if (answer && 'path' in answer) identity = { state: 'identified', workspaceId: this.workspaceId, path: answer.path }
    else if (answer && 'candidates' in answer) identity = { state: 'ambiguous', workspaceId: this.workspaceId, candidates: answer.candidates, more: answer.more }
    else identity = { state: 'unknown' }
    this.identity.set(identity)
    return answer && 'path' in answer ? { identity, line: answer.line, column: answer.column } : { identity }
  }

  /** The person picked one of identical files: kept by the worker for this workspace and text. */
  async choose(text: string, path: string): Promise<boolean> {
    if (this.workspaceId === null) return false
    let ok = false
    try {
      ok = (await this.requests.choose({ workspaceId: this.workspaceId, path, ...(await this.textInput(text)) })).ok
    } catch {
      ok = false
    }
    if (ok) {
      this.asked++
      this.identity.set({ state: 'identified', workspaceId: this.workspaceId, path })
    }
    return ok
  }

  /** Orca flushed this editor: it is about to save this editor's tab, with this text. */
  flushed(text: string): void {
    this.flush = { at: this.now(), hash: sha256Hex(text), paths: new Set(), deciding: false }
  }

  /**
   * A save the worker saw. Its own (flushed just before, same text, one file named): the file is
   * this one. Another's: nothing, unless this editor could not name its file and asks again.
   * Resolves `own`, `other`, or `pending` while the saves of one flush are being gathered.
   */
  async saved(event: { workspaceId: string | null; path: string; hash: string }, text: () => string): Promise<'own' | 'other' | 'pending'> {
    if (event.workspaceId !== this.workspaceId || this.workspaceId === null) return 'other'
    const flush = this.flush
    if (flush && this.now() - flush.at <= OWN_SAVE_MS && (await flush.hash) === event.hash && flush === this.flush) {
      flush.paths.add(event.path)
      if (flush.deciding) return 'pending'
      flush.deciding = true
      return new Promise((resolve) => {
        this.setTimer(() => {
          if (this.flush === flush) this.flush = null
          const workspaceId = this.workspaceId
          if (flush.paths.size === 1 && workspaceId !== null) {
            this.asked++
            this.identity.set({ state: 'identified', workspaceId, path: [...flush.paths][0] })
            resolve('own')
          } else resolve('other')
        }, SAVE_SETTLE_MS)
      })
    }
    if (this.identity.value.state !== 'identified') void this.locate(text())
    return 'other'
  }
}
