// The editor frame's side of `editor.locate`: it hashes the text (SHA-256 through the frame's
// `crypto.subtle`, so a large text never travels; the text itself when that is missing), asks the
// worker, and keeps the answer in the identity store. Asked again after a save (`editor.saved`),
// while the file is not named. No DOM: main.ts draws what it decides.
import type { EditorLocated } from './protocol'
import type { Identity, IdentityStore } from './identity'

export type LocateRequests = {
  locate(input: { workspaceId: string | null; text?: string; hash?: string }): Promise<EditorLocated>
  choose(input: { workspaceId: string | null; text?: string; hash?: string; path: string }): Promise<{ ok: boolean }>
}

/** SHA-256 of a text as UTF-8, in hex; null where the frame has no `crypto.subtle`. */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type Located = { identity: Identity; line?: number; column?: number }

export class LocateClient {
  /** Answers that came back for an older text are dropped. */
  private asked = 0
  private readonly requests: LocateRequests
  private readonly workspaceId: string | null
  private readonly identity: IdentityStore

  constructor(requests: LocateRequests, workspaceId: string | null, identity: IdentityStore) {
    this.requests = requests
    this.workspaceId = workspaceId
    this.identity = identity
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
}
