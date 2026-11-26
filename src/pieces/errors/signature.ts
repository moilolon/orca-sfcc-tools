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
//   4. Only when it has no frame at all: its pipeline or controller (`Cart-Show`), then the only
//      sign of where it came from. Never the site: one error on two sites is one error.
//
// What is removed from the first line, in this order, each replaced by a placeholder so two texts
// that differ only there read the same:
//   - timestamps (`2026-11-26 00:10:02.123 GMT`, ISO 8601, `Tue Nov 26 10:15:02 GMT 2026`) -> `<time>`
//   - a URL's scheme and host, so only its path is kept (`https://www.example.com/on/x` -> `/on/x`),
//     its query string and fragment, and a locale segment of its path (`/en_GB/`, `/fr/`,
//     `/default/`, `-en-gb`) -> `/<locale>/`: one error on two domains or locales is one
//   - a query string anywhere else (`?pid=12&qty=1`)                 -> removed
//   - named ids (`orderNo=00012345`, `customerNo: 77`, `id=abc`, `UUID 1f…`) -> `orderNo=#`, `UUID #`
//   - UUIDs                                                          -> `<uuid>`
//   - e-mail addresses                                               -> `<email>`
//   - a host written without a scheme (`shop.example.com`, `cdn-03.example.net:443`): a whole
//     lower-case token of two or more labels ending in a top-level domain of `TOP_LEVEL_DOMAINS`
//     or a two-letter country code, never a file name (`Cart.js`, `dw.json`, an extension of
//     `FILE_EXTENSIONS`), a `dw.*` name or a Java package                -> `<host>`
//   - IP addresses, version 4 and 6                                  -> `<ip>`
//   - quoted values (`"…"`, `'…'`)                                   -> `<q>`, except a quoted script
//     path (`'app_x/cartridge/controllers/Cart.js'`), kept: it says which script failed
//   - site ids (`Sites-Example-Site`)                                -> `<site>`
//   - the line of a script location (`cart.js#118`, `cart.js:118:7`) -> removed
//   - hexadecimal ids (`0x1f`, `9f3a6c21e4`)                          -> `<hex>`
//   - request and session ids: words of 12 or more characters that look random (letters of both
//     cases and a digit, or lower case and two digits; never one with `_`, so a named constant
//     such as `PAYMENT_PROC_V2` stays, nor a class name such as `Base64Encoder`) -> `<id>`
//   - a `LETTERS-digits` token (`SKU-123456`, `GB-00012345`, `ORA-00001`), whole -> `<code>`
//   - every other number                                             -> `#`. Only two kinds of
//     number are kept, as they say which error it is and hold nothing of a customer: an HTTP
//     status (100 to 599) right after `status`, `status code`, `statusCode` or `HTTP` (`status
//     404`, `HTTP/1.1 503`, `statusCode=429`), and an error code right after `error code`,
//     `errorCode` or `error-code`. A bare `code` keeps nothing: an order, a gift card, a postal
//     code or a one-time code is a customer's value.
//   - runs of white space                                            -> one space
// The site and the session are never part of the signature.
//
// What is not removed: free text. A name or a street a message writes in its own words
// (`Address validation failed for Jane Doe, # Baker Street`) stays in the sample, which is kept
// only in the plugin's local storage, bounded, and shown only in the panel.
//
// Too loose a rule hides a new error under an old one; too tight a rule repeats an old one. The
// rules are tuned on the fixtures of signature.test.ts, near misses included.
import { createHash } from 'node:crypto'
import { parseMessage, type Frame, type ParsedMessage } from './reader'

/** How many frames, from the top, identify an error. */
export const TOP_FRAMES = 3

/** The longest normalised first line that is hashed and kept. */
export const MAX_MESSAGE_CHARS = 300

type Rule = readonly [RegExp, string | ((match: string, ...groups: string[]) => string)]

const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)'
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'

/** A locale segment of a URL path: `en_GB`, `en-gb`, `default`. */
const LOCALE_SEGMENT = /\/(?:[a-z]{2}[_-][A-Za-z]{2}|default)(?=\/|$)/g
/** A bare language (`/fr/`), only in a storefront's path; never `on` or `s`. */
const LANGUAGE_SEGMENT = /\/(?!on\b|s\b)[a-z]{2}(?=\/|$)/g
const LOCALE_SUFFIX = /-[a-z]{2}[-_][a-z]{2}(?=[/.]|$)/gi

/** A URL path with its locale segments replaced. */
function pathWithoutLocale(path: string): string {
  const storefront = /^\/(?:s|on\/demandware\.store)\//.test(path)
  const out = path.replace(LOCALE_SEGMENT, '/<locale>').replace(LOCALE_SUFFIX, '-<locale>')
  return storefront ? out.replace(LANGUAGE_SEGMENT, '/<locale>') : out
}

/** Generic top-level domains a host in free text may end in; any two-letter one is a country's. */
export const TOP_LEVEL_DOMAINS: readonly string[] = ['com', 'net', 'org', 'info', 'biz', 'io', 'app', 'dev', 'cloud', 'shop', 'store', 'online', 'site', 'tech', 'xyz', 'edu', 'gov', 'int', 'mil', 'eu', 'asia', 'global', 'local', 'internal']

/** Extensions of files: a token ending in one is a file name, never a host. */
export const FILE_EXTENSIONS: readonly string[] = [
  'js', 'mjs', 'cjs', 'ts', 'ds', 'json', 'isml', 'xml', 'xsd', 'properties', 'java', 'class', 'jar', 'html', 'htm', 'css', 'scss', 'less',
  'txt', 'log', 'csv', 'md', 'yml', 'yaml', 'sh', 'py', 'pl', 'rb', 'php', 'go', 'rs', 'cs', 'so', 'gz', 'zip', 'tar', 'pdf', 'png',
  'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'map', 'min', 'db', 'ps', 'bat', 'cmd', 'exe', 'dll', 'bak', 'tmp'
]

/**
 * Two-letter endings that are country codes but far more often a word or a property in a message
 * (`basket.id`, `value.is`): a token ending in one stays.
 */
const NOT_HOST_ENDINGS = new Set(['id', 'in', 'is', 'it', 'to', 'do', 'be', 'me', 'no', 'or', 'as', 'at', 'us', 'on', 'my', 'so', 'an', 'am', 'by', 'of', 'up', 'if', 'go'])

/** First labels that name a package, not a host: `dw.order.Basket`, `java.io.File`. */
const PACKAGE_ROOTS = new Set(['dw', 'java', 'javax', 'jdk', 'sun', 'org', 'com', 'net', 'io', 'jakarta', 'custom', 'system'])

const HOST = /(?<![\w.@/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24})(?::\d{1,5})?(?![\w.@-]*[\w@])/g

/** Whether a dotted lower-case token is a host: see the rules above. */
function hostOrNot(token: string, tld: string): string {
  const labels = token.replace(/:\d+$/, '').split('.')
  if (labels.length < 2) return token
  if (FILE_EXTENSIONS.includes(tld) || NOT_HOST_ENDINGS.has(tld) || PACKAGE_ROOTS.has(labels[0])) return token
  if (!(TOP_LEVEL_DOMAINS.includes(tld) || tld.length === 2)) return token
  return '<host>'
}

/** Whether a quoted value is a script path, which says which script failed. */
function isScriptPath(value: string): boolean {
  return /^[\w.-]+(?:\/[\w.-]+)*\/[\w.-]+\.(?:js|ds|isml)(?:[#:]\d+)*$/.test(value) || /^[\w.-]+\/cartridge\//.test(value)
}

/** Whether a word of 12 or more characters looks like a random id rather than a name. */
function looksRandom(word: string): boolean {
  if (word.includes('_')) return false
  const digits = (word.match(/\d/g) ?? []).length
  const lower = /[a-z]/.test(word)
  const upper = /[A-Z]/.test(word)
  // A class name made of words and numbers (`Base64Encoder`) is a name.
  if (/^(?:[A-Z][a-z]{2,}|\d+)+$/.test(word)) return false
  return (lower && upper && digits >= 1) || (lower && digits >= 2)
}

/** The label right before an HTTP status. `HTTP/1.1` is a label, its version digits are not kept. */
const STATUS_LABEL = /(?:\bstatus(?:\s*code)?|\bstatusCode|\bHTTP(?:\/\d(?:\.\d)?)?)\s*[:=]?\s*$/i
/** The label right before an error code. */
const ERROR_CODE_LABEL = /\berror(?:\s*|-)?code\s*[:=]?\s*$/i

/** Every number becomes `#`, but an HTTP status or an error code after its label (see above). */
function numbers(text: string): string {
  return text.replace(/\d+/g, (digits, offset: number) => {
    const before = text.slice(Math.max(0, offset - 40), offset)
    // A number that runs on into a word (`404x`) is not a status.
    const whole = !/\w/.test(text[offset + digits.length] ?? '')
    if (whole &&/^[1-5]\d\d$/.test(digits) && STATUS_LABEL.test(before)) return digits
    if (whole && ERROR_CODE_LABEL.test(before)) return digits
    return '#'
  })
}

const RULES: readonly Rule[] = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s?(?:GMT|UTC|Z|[+-]\d{2}:?\d{2}))?/g, '<time>'],
  [new RegExp(`\\b${DAY} ${MONTH} \\d{1,2} \\d{2}:\\d{2}:\\d{2}(?: [A-Z]{2,5})? \\d{4}\\b`, 'g'), '<time>'],
  // A URL: only its path stays, without its query, fragment or locale.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#'"<>()]*([^\s?#'"<>()]*)(?:[?#][^\s'"<>()]*)?/gi, (_url, path: string) => pathWithoutLocale(path || '/')],
  // A path that names the storefront's pipeline, with no scheme: its locale too.
  [/(?<![\w.])\/(?:on\/demandware\.store|s)\/[^\s?#'"<>()]*/g, (path) => pathWithoutLocale(path)],
  [/\?[\w.%-]+=[^\s'"<>)]*/g, ''],
  [/\b(UUID)\s+[\w-]+/g, '$1 #'],
  // A named id: `id`, `pid`, `uuid`, or a camel-case name ending in `Id`, `ID`, `No` or `Number`
  // (`orderNo`, `customerNo`, `basketId`), so `valid: true` is left alone.
  [/\b([a-z]\w*(?:Id|ID|No|Number)|id|ID|pid|uuid|UUID)\s*([=:])\s*(?:'[^'\n]*'|"[^"\n]*"|[^\s,;)'"]+)/g, '$1$2#'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [HOST, (token, tld: string) => hostOrNot(token, tld)],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>'],
  // IPv6: with `::`, or with at least four colons, so a time (`10:15:02`) is never one.
  [/(?<![\w:])(?=[0-9a-f:]*::|(?:[0-9a-f]{1,4}:){4})(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, '<ip>'],
  [/"([^"\n]*)"/g, (whole, value: string) => (isScriptPath(value) ? whole : '<q>')],
  // A quote that follows a letter is an apostrophe (`can't`), not the start of a value.
  [/(^|[^\w])'([^'\n]*)'(?!\w)/g, (whole, before: string, value: string) => (isScriptPath(value) ? whole : `${before}<q>`)],
  [/\bSites-[\w-]+?-Site\b/g, '<site>'],
  [/(\.(?:js|ds|isml|java))(?:[#:]\d+)+/g, '$1'],
  [/\b0x[0-9a-f]+\b/gi, '<hex>'],
  [/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>'],
  [/\b[\w-]{12,}\b/g, (word) => (looksRandom(word) ? '<id>' : word)],
  // A code of letters and a number (`SKU-123456`, `GB-00012345`, `ISH-CORE-2368`), whole: its
  // number may be a customer's (an order, a gift card, a product).
  [/\b[A-Z]{1,10}(?:-[A-Z]{1,10})*-\d+\b/g, '<code>']
]

/** A text with what varies removed, by the rules above. */
export function normalize(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement as never)
  return numbers(out).replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS)
}

/** The frames that identify an error: its top script frames, else its top Java frames. */
export function topFrames(frames: readonly Frame[]): Frame[] {
  const scripts = frames.filter((frame) => frame.script)
  return (scripts.length > 0 ? scripts : frames).slice(0, TOP_FRAMES)
}

/**
 * What identifies an error, ready to hash and to keep as its sample: the normalised first line,
 * the logger and the top frames (their lines kept for opening the file, never hashed), and, with
 * no frame, the pipeline.
 */
export type Identity = { message: string; logger: string | null; frames: Frame[]; pipeline: string | null }

export function identityOf(parsed: ParsedMessage): Identity {
  const frames = topFrames(parsed.frames)
  return { message: normalize(parsed.text), logger: parsed.logger, frames, pipeline: frames.length === 0 ? parsed.pipeline : null }
}

/** The signature of an identity: 20 hexadecimal characters of a SHA-256. */
export function signatureOfIdentity(identity: Identity): string {
  const key = JSON.stringify([identity.message, identity.logger ?? '', identity.frames.map((frame) => [frame.file, frame.function ?? '']), identity.pipeline ?? ''])
  return createHash('sha256').update(key).digest('hex').slice(0, 20)
}

/** The signature of a log message, and what it was computed from. */
export function signatureOf(message: string): { signature: string; identity: Identity } {
  const identity = identityOf(parseMessage(message))
  return { signature: signatureOfIdentity(identity), identity }
}
