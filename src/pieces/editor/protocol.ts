// The editor piece's requests (named `editor.*`) and the event its worker posts to the open
// editors. src/protocol.ts imports this file.
//
// The editor frame gets the document's text and the focused workspace, never the file's path
// (spike S3). `editor.locate` names the file: the path the plugin recorded when it had just opened
// the file itself, else the files of the workspace whose text matches. A save names the file only
// for the editor that saved it (`editor.saved`, matched in the frame). The text travels as given
// (`text`) or as its SHA-256 in hex (`hash`), computed on the text exactly as the editor holds it
// (a BOM and every line break included, as UTF-8).

/** The text the editor shows, as itself or as its hash; one of the two. */
export type EditorText = { text?: string; hash?: string }

export type EditorLocateInput = EditorText & {
  /** The workspace the frame belongs to, as `workspace.readContext` names it when the frame mounts. */
  workspaceId: string | null
}

/**
 * Which file the editor shows, its path relative to the workspace with `/` between parts; with the
 * line (and column) to show first when the plugin opened the file at a line. `candidates` when
 * several files hold this text and none was chosen yet (sorted, at most `MAX_CANDIDATES`); null
 * when no file holds it (unsaved edits, a new file) or the workspace is not on this machine.
 */
export type EditorLocated = { path: string; line?: number; column?: number } | { candidates: string[]; more: number } | null

export type EditorChooseInput = EditorText & { workspaceId: string | null; path: string }

declare module 'orca' {
  interface PluginRequests {
    'editor.locate': { input: EditorLocateInput; output: EditorLocated }
    /** Keeps the person's choice among identical files, per workspace and text. */
    'editor.choose': { input: EditorChooseInput; output: { ok: boolean } }
  }
  interface PluginPanelEvents {
    /**
     * A file was saved from an editor tab: its path (relative to the workspace) and the hash of
     * the text saved. Only the editor that was flushed for this save takes the path as its own;
     * the others ask again only when they could not name their file.
     */
    'editor.saved': { workspaceId: string | null; path: string; hash: string }
  }
}
