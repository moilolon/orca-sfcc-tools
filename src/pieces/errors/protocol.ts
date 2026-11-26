// The errors piece's requests (named `errors.*`) and panel events; src/protocol.ts imports this
// file. Nothing here carries a host, a local path or a raw log entry: a row holds the counters and
// the masked sample of one signature.
import type { Role, RoleState } from '../../core/instances'

/** A frame of a sample: the script's path on the instance, its function and line. */
export type ErrorFrame = {
  file: string
  function: string | null
  line: number | null
  /** Whether the script is a file of a cartridge of the workspace, so it can be opened. */
  openable: boolean
  /** Its path in the workspace, `/` between its parts, when it is openable: where a breakpoint goes. */
  path: string | null
}

/** One signature of an environment's seen list. */
export type ErrorRow = {
  signature: string
  /** Milliseconds since the epoch, of the oldest and newest occurrence read. */
  firstSeen: number
  lastSeen: number
  count: number
  /** When it was marked as seen; null while it is new. */
  markedAt: number | null
  /** The normalised first line of the newest occurrence, masked. */
  message: string
  logger: string | null
  /** Fields of the entry's first line: the pipeline or controller, and the level. Never the site. */
  pipeline: string | null
  level: string | null
  frames: ErrorFrame[]
}

/** What the section shows of an environment. */
export type RoleErrors = {
  role: Role
  /** Whether dw.json lets b2c read this environment; only `ready` is read. */
  state: RoleState
  /** A read is running now. */
  reading: boolean
  /** When the last read ended well, or null. */
  lastRead: number | null
  /** The code of the last read's failure (`b2c_failed`, `b2c_timeout`, …), cleared by a good one. */
  error: string | null
  /**
   * When the last read may have left entries unread since this time (b2c reads only the end of
   * each file and at most `MAX_ENTRIES`); null when it read everything. Shown, never notified.
   */
  missedSince: number | null
  /** The sandbox is read every this many minutes; 0 when only by hand. Always 0 for the others. */
  intervalMinutes: number
  /** New first, then by the newest occurrence. */
  rows: ErrorRow[]
}

export type OpenFrameResult = { opened: boolean; reason?: string }

declare module 'orca' {
  interface PluginRequests {
    /** The environment's seen list and the state of its reads. */
    'errors.list': { input: { role: Role }; output: RoleErrors }
    /**
     * Starts a read of the environment's log (or joins the one running) and answers at once, with
     * `reading` true; `errors.changed` tells when the read ended. One read per environment at a time.
     */
    'errors.refresh': { input: { role: Role }; output: RoleErrors }
    /** Marks signatures as seen for good. */
    'errors.mark': { input: { role: Role; signatures: string[] }; output: RoleErrors }
    /** Drops a signature from the list: its next occurrence is new again. */
    'errors.forget': { input: { role: Role; signature: string }; output: RoleErrors }
    /** Opens the file of a frame of a signature's sample in Orca's editor, at its line. */
    'errors.open': { input: { role: Role; signature: string; frame: number }; output: OpenFrameResult }
  }
  interface PluginPanelEvents {
    /** An environment's list or read state changed: the panel asks for it again. */
    'errors.changed': { role: Role; newCount: number }
  }
}
