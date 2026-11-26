// The signature of an error: a hash of what identifies it, with what varies between two
// occurrences of it removed. Pure: no Orca import and no Node import beyond hashing, so the
// command line of phase 4 runs it outside Orca.
//
// What identifies an error, and is hashed:
//   1. The first line of its message, after the pipe fields (thread, site, pipeline, session),
//      normalised by the rules below. It holds the error class (`TypeError: …`) and its text.
//   2. Its logger (`custom.Cart`, `system.core`).
//   3. Its top frames (`TOP_FRAMES`), each by file and function, never by line. Script frames
//      (`.js`, `.ds`, `.isml`) when the trace has any, since the Java frames under a script error
//      are the engine's own and the same for every script; the Java frames otherwise.
//
// What is removed from the first line, in this order, each replaced by a placeholder so two texts
// that differ only there read the same:
//   - timestamps (`2026-11-26 00:10:02.123 GMT`, ISO 8601)        -> `<time>`
//   - the query string and fragment of a URL                        -> removed
//   - UUIDs                                                          -> `<uuid>`
//   - e-mail addresses                                               -> `<email>`
//   - quoted values (`"…"`, `'…'`)                                   -> `<q>`
//   - site ids (`Sites-Example-Site`): one error on two sites is one -> `<site>`
//   - the line of a script location (`cart.js#118`, `cart.js:118:7`) -> removed
//   - hexadecimal ids (`0x1f`, `9f3a6c21e4`)                          -> `<hex>`
//   - request and session ids: words of 16 or more characters mixing letters and digits -> `<id>`
//   - every other number                                             -> `#`
//   - runs of white space                                            -> one space
// The site, the pipeline and the session are not part of the signature at all.
//
// Too loose a rule hides a new error under an old one; too tight a rule repeats an old one. The
// rules are tuned on the fixtures of signature.test.ts, near misses included.
import { createHash } from 'node:crypto'
import { parseMessage, type Frame, type ParsedMessage } from './reader'

/** How many frames, from the top, identify an error. */
export const TOP_FRAMES = 3

/** The longest normalised first line that is hashed and kept. */
export const MAX_MESSAGE_CHARS = 300

const RULES: readonly (readonly [RegExp, string])[] = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s?(?:GMT|UTC|Z|[+-]\d{2}:?\d{2}))?/g, '<time>'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'"<>]*)[?#][^\s'"<>)]*/gi, '$1'],
  [/\?[\w.%-]+=[^\s'"<>)]*/g, ''],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/"[^"\n]*"/g, '<q>'],
  // A quote that follows a letter is an apostrophe (`can't`), not the start of a value.
  [/(^|[^\w])'[^'\n]*'(?!\w)/g, '$1<q>'],
  [/\bSites-[\w-]+?-Site\b/g, '<site>'],
  [/(\.(?:js|ds|isml|java))(?:[#:]\d+)+/g, '$1'],
  [/\b0x[0-9a-f]+\b/gi, '<hex>'],
  [/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>'],
  [/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{16,}\b/g, '<id>'],
  [/\d+/g, '#'],
  [/\s+/g, ' ']
]

/** A text with what varies removed, by the rules above. */
export function normalize(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out.trim().slice(0, MAX_MESSAGE_CHARS)
}

/** The frames that identify an error: its top script frames, else its top Java frames. */
export function topFrames(frames: readonly Frame[]): Frame[] {
  const scripts = frames.filter((frame) => frame.script)
  return (scripts.length > 0 ? scripts : frames).slice(0, TOP_FRAMES)
}

/**
 * What identifies an error, ready to hash and to keep as its sample: the normalised first line,
 * the logger and the top frames (their lines kept for opening the file, never hashed).
 */
export type Identity = { message: string; logger: string | null; frames: Frame[] }

export function identityOf(parsed: ParsedMessage): Identity {
  return { message: normalize(parsed.text), logger: parsed.logger, frames: topFrames(parsed.frames) }
}

/** The signature of an identity: 20 hexadecimal characters of a SHA-256. */
export function signatureOfIdentity(identity: Identity): string {
  const key = JSON.stringify([identity.message, identity.logger ?? '', identity.frames.map((frame) => [frame.file, frame.function ?? ''])])
  return createHash('sha256').update(key).digest('hex').slice(0, 20)
}

/** The signature of a log message, and what it was computed from. */
export function signatureOf(message: string): { signature: string; identity: Identity } {
  const identity = identityOf(parseMessage(message))
  return { signature: signatureOfIdentity(identity), identity }
}
