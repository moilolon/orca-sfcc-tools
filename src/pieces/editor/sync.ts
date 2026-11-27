// The only code of the editor frame that talks to Orca about the document: `orca.document.session`
// with the three-way merge of merge.ts. The surface hands it the whole text after each change (the
// session sends at most one edit at a time and coalesces the rest), and hears from it when the
// file changed outside: an agent wrote it, or a write landed while an edit waited (a conflict the
// session merged), or the file changed on disk under unsaved edits. A save asks the frame for its
// pending edits (`editor.flush`), and the session sends them before Orca saves.
import type { EditorSession, OrcaFrameApi } from 'orca/frame'
import { merge3, type MergeResult } from './merge'

/** Milliseconds the session waits after the last change before sending it. */
export const SEND_DEBOUNCE_MS = 150

export type MergeReport = MergeResult & { at: number }

export type DocumentSync = {
  /** The text when the editor opened. */
  readonly initial: string
  readonly readOnly: boolean
  /** The text now, as the editor last handed it, or as the last outside change set it. */
  readonly value: string
  /** Hands the session the editor's whole text. */
  change(text: string): void
  /** Sends what is pending now (Orca's save asks for it through `editor.flush` too). */
  flush(): Promise<void>
  /** An outside change, after merging with what the editor holds: the editor shows this text. */
  onReplace(handler: (text: string) => void): () => void
  /** The last merge, with how many regions both sides changed differently (the editor's text kept there). */
  lastMerge(): MergeReport | null
  dispose(): void
}

export async function startSync(api: OrcaFrameApi, options: { debounceMs?: number; now?: () => number } = {}): Promise<DocumentSync> {
  const document = api.document
  if (!document) throw Object.assign(new Error('Not a custom editor frame'), { code: 'not_permitted' })
  let merged: MergeReport | null = null
  const now = options.now ?? (() => Date.now())
  const session: EditorSession<string> = await document.session<string>({
    debounceMs: options.debounceMs ?? SEND_DEBOUNCE_MS,
    merge: (base, outside, mine) => {
      const result = merge3(base, outside, mine)
      merged = { ...result, at: now() }
      return result.text
    }
  })
  const initial = typeof session.value === 'string' ? session.value : ''
  const handlers: ((text: string) => void)[] = []
  const subscription = session.onReplace((value) => {
    const text = typeof value === 'string' ? value : ''
    for (const handler of [...handlers]) handler(text)
  })
  return {
    initial,
    readOnly: session.readOnly,
    get value() {
      return session.value
    },
    change(text) {
      if (session.readOnly || text === session.value) return
      session.change(text)
    },
    flush: () => session.flush(),
    onReplace(handler) {
      handlers.push(handler)
      return () => {
        const at = handlers.indexOf(handler)
        if (at >= 0) handlers.splice(at, 1)
      }
    },
    lastMerge: () => merged,
    dispose() {
      subscription.dispose()
      handlers.length = 0
      session.dispose()
    }
  }
}
