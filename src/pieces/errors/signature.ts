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
//   - secrets, first, so no rule below leaves a fragment of one (`inv_key_#mZ#…`)    -> `<secret>`:
//       - a cookie header's value, whole: everything after `cookie:` or `set-cookie:` on the line
//       - the value after a key naming a secret, `=` or `:` between (`password=…`, `apiKey: …`,
//         `dwsecuretoken_x=…`, `"token":"…"`), a key holding one of `SECRET_WORDS` anywhere in it,
//         any letter case, up to the next separator (space, `,`, `;`, `&`, a bracket or a quote;
//         a quoted value whole), a `Bearer`/`Basic` scheme before it included
//       - the value after one of those words and a space (`with password Hunter2!`), unless it
//         is a plain lowercase word, which in a log is the sentence going on (`authorization
//         failed`, `session expired`)
//       - `Bearer …` and `Basic …` credentials (not a plain lowercase word)
//       - JWT-shaped tokens: three base64url parts joined by dots (`eyJ…` first, or each of 16
//         characters or more, with a digit)
//       - runs of 20 or more hexadecimal characters, and runs of 20 or more base64 characters
//         that look random (`looksLikeSecretRun`): never a path, a word or a class name
//   - timestamps (`2026-11-26 00:10:02.123 GMT`, ISO 8601, `Tue Nov 26 10:15:02 GMT 2026`) -> `<time>`
//   - a URL's scheme and host, so only its path is kept (`https://www.example.com/on/x` -> `/on/x`),
//     its query string and fragment, and a locale segment of its path (`/en_GB/`, `/fr/`,
//     `/default/`, `-en-gb`) -> `/<locale>/`: one error on two domains or locales is one
//   - a query string anywhere else (`?pid=12&qty=1`)                 -> removed
//   - named ids (`orderNo=00012345`, `customerNo: 77`, `id=abc`, `UUID 1f…`) -> `orderNo=#`, `UUID #`
//   - UUIDs                                                          -> `<uuid>`
//   - e-mail addresses                                               -> `<email>`
//   - a host written without a scheme (`shop.example.com`, `cdn-03.example.net:443`): a whole
//     token of two or more labels, in any letter case, ending in a top-level domain of
//     `TOP_LEVEL_DOMAINS` or a two-letter country code (three labels or more on a two-letter or
//     word-like ending, `WORD_LIKE_DOMAINS`), never a file name (`Cart.js`, `dw.json`, an
//     extension of `FILE_EXTENSIONS`), a `dw.*` name, a Java package or a script expression
//     (`request.site`, `this.store`, `logger.info`: `PACKAGE_ROOTS`)   -> `<host>`. Where the
//     text around says it is a host, two labels do: inside `[]`, `()` or `<>` (in a list there
//     too, `[a.it, b.de]`), or quotes, on any known ending but one that reads as a property
//     (`item.id`, `value.is`: `PROPERTY_ENDINGS`); right after `domain`, `host`, `hostname`,
//     `server`, `url`, `@` or `//`, on any known ending. A port or a path may follow
//     (`[brand.eu/de]`, `server brand.eu:8443`). A file name, a `dw.*` name, a Java package or a
//     script expression stays even there
//   - IP addresses, version 4 and 6                                  -> `<ip>`
//   - quoted values (`"…"`, `'…'`)                                   -> `<q>`, except a quoted script
//     path (`'app_x/cartridge/controllers/Cart.js'`), kept: it says which script failed
//   - site ids (`Sites-Example-Site`)                                -> `<site>`
//   - the line of a script location (`cart.js#118`, `cart.js:118:7`) -> removed
//   - hexadecimal ids (`0x1f`, `9f3a6c21e4`)                          -> `<hex>`
//   - request and session ids: words of 12 or more characters that look random (letters of both
//     cases and a digit, or lower case and two digits; never one with `_`, so a named constant
//     such as `PAYMENT_PROC_V2` stays, nor a class name such as `Base64Encoder`) -> `<id>`
//   - a `LETTERS-digits` token (`SKU-123456`, `GB-00012345`), whole           -> `<code>`, but a
//     code of the platform's own (`ISH-CORE-2368`, `ORA-00001`), kept with its number
//   - every other number                                             -> `#`. Only two kinds of
//     number are kept, as they say which error it is and hold nothing of a customer: an HTTP
//     status (100 to 599) right after `status`, `status code`, `statusCode`, `HTTP`, `response`,
//     `response code` or `responded with` (`status 404`, `HTTP/1.1 503`, `Response 401`), and an
//     error code right after `error code`,
//     `errorCode` or `error-code`. A bare `code` keeps nothing: an order, a gift card, a postal
//     code or a one-time code is a customer's value.
//   - runs of white space                                            -> one space
// The site and the session are never part of the signature.
//
// What is not removed: free text. A name or a street a message writes in its own words
// (`Address validation failed for Jane Doe, # Baker Street`) stays in the sample, which is kept
// only in the plugin's local data folder, bounded, and shown in the panel; the morning report
// quotes at most its first 80 characters. Signatures of messages that held a secret changed
// when the secret rules came in: such an error reads as new once.
//
// Too loose a rule hides a new error under an old one; too tight a rule repeats an old one. The
// rules are tuned on the fixtures of signature.test.ts, near misses included.
import { createHash } from 'node:crypto'
import { parseMessage, type Frame, type ParsedMessage } from './reader.ts'

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
export const TOP_LEVEL_DOMAINS: readonly string[] = [
  'com', 'net', 'org', 'info', 'biz', 'io', 'app', 'dev', 'cloud', 'shop', 'store', 'online', 'site', 'tech', 'xyz', 'edu', 'gov', 'int', 'mil', 'eu',
  'asia', 'global', 'local', 'internal', 'club', 'fashion', 'boutique', 'clothing', 'luxury', 'agency', 'website', 'mobi', 'travel', 'ltd'
]

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

/**
 * Of those, the endings a script expression in brackets ends in far more often than a brand's
 * domain (`(item.id)`, `[value.is]`): even inside brackets a two-label token on one stays. A
 * country's ending that is rarely a property (`.it`, `.at`, `.be`, `.no`, `.us`, `.me`) is a host
 * there.
 */
const PROPERTY_ENDINGS = new Set(['id', 'in', 'is', 'on', 'of', 'if', 'or', 'as', 'to', 'do', 'by', 'up', 'so', 'an', 'am', 'go'])

/** First labels that name a package, not a host: `dw.order.Basket`, `java.io.File`. */
const PACKAGE_ROOTS = new Set([
  'dw', 'java', 'javax', 'jdk', 'sun', 'org', 'com', 'net', 'io', 'jakarta', 'custom', 'system',
  // The usual roots of a script expression: `request.site`, `this.store`, `logger.info`.
  'this', 'self', 'request', 'response', 'session', 'customer', 'basket', 'cart', 'order', 'product', 'payment', 'site',
  'pdict', 'res', 'req', 'module', 'exports', 'window', 'document', 'global', 'process', 'console', 'logger', 'log',
  'config', 'options', 'params', 'args', 'result', 'event', 'error', 'err', 'utils', 'helpers',
  'obj', 'item', 'items', 'data', 'value', 'values', 'props', 'model', 'state', 'context', 'ctx', 'i18n', 'messages',
  'resource', 'resources', 'math', 'json', 'object', 'array', 'string', 'number', 'date', 'promise', 'reflect'
])

/** Top-level domains that are also ordinary words (`logger.info`, `this.store`): a host on one needs three labels. */
const WORD_LIKE_DOMAINS = new Set(['app', 'info', 'site', 'store', 'shop', 'local', 'online', 'cloud', 'dev', 'global', 'internal', 'tech'])

const HOST = /(?<![\w.@/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24})(?::\d{1,5})?(?![\w.@-]*[\w@])/gi

/**
 * A dotted token right after a word that names a host (`domain`, `host`, `hostname`, `server`,
 * `url`, then an optional `:` or `=` and an opening bracket or quote), or right after `@` or `//`,
 * in any letter case: the word before it, and the token.
 */
const NAMED_HOST =
  /(\b(?:domain|host|hostname|server|url)\b\s*[:=]?\s*[[(<'"]?|(?<![\w.+-])@|(?<![\w:/])\/\/)((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24}))(?::\d{1,5})?(?![\w.@-]*[\w@])/gi

/** How far, each way, the brackets a token stands in are looked for. */
const ENCLOSURE_REACH = 200
const OPENERS = '[(<'
const CLOSERS = '])>'

/**
 * How sure the text around a token is that it is a host: `plain` in free text; `enclosed` inside
 * `[]`, `()`, `<>` or quotes; `named` after a word that names a host, `@` or `//`.
 */
type HostContext = 'plain' | 'enclosed' | 'named'

/** Whether a dotted token is a host, in any letter case: see the rules above. */
function hostOrNot(original: string, ending: string, context: HostContext = 'plain'): string {
  const token = original.toLowerCase()
  const tld = ending.toLowerCase()
  const labels = token.replace(/:\d+$/, '').split('.')
  if (labels.length < 2) return original
  if (FILE_EXTENSIONS.includes(tld) || PACKAGE_ROOTS.has(labels[0])) return original
  if (!(TOP_LEVEL_DOMAINS.includes(tld) || tld.length === 2)) return original
  // After a word that names a host, any known ending is a host's.
  if (context === 'named') return '<host>'
  const soft = WORD_LIKE_DOMAINS.has(tld) || tld.length === 2
  // A two-letter first label with a two-letter or word-like ending is a package written
  // backwards (`de.example.ui`, `(de.ui)`).
  if (soft && labels[0].length === 2) return original
  // Inside brackets or quotes, two labels do, but on an ending that reads as a property.
  if (context === 'enclosed') return PROPERTY_ENDINGS.has(tld) ? original : '<host>'
  // In free text, an ending that is also a word (`basket.id`) stays, and on a word-like or a
  // two-letter ending two labels read as a property (`config.local`): a host needs three.
  if (NOT_HOST_ENDINGS.has(tld)) return original
  if (soft && labels.length < 3) return original
  return '<host>'
}

/**
 * Whether the token at `start`..`end` of `text` stands inside brackets (`[x]`, `(x)`, `<x>`, also
 * among other items, `[a.it, b.de]`, and with a path after it, `[brand.eu/de]`) or right inside
 * quotes, on its own line.
 */
function isEnclosed(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? ''
  if ((before === "'" || before === '"') && new RegExp(`^(?::\\d{1,5})?(?:/[^\\s${before}]*)?${before}`).test(text.slice(end))) return true
  const left = text.slice(Math.max(0, start - ENCLOSURE_REACH), start)
  const right = text.slice(end, end + ENCLOSURE_REACH)
  const lineLeft = left.slice(left.lastIndexOf('\n') + 1)
  const lineRight = right.split('\n')[0]
  const lastOpen = Math.max(...[...OPENERS].map((c) => lineLeft.lastIndexOf(c)))
  const lastClose = Math.max(...[...CLOSERS].map((c) => lineLeft.lastIndexOf(c)))
  if (lastOpen === -1 || lastOpen < lastClose) return false
  const firstClose = Math.min(...[...CLOSERS].map((c) => lineRight.indexOf(c)).filter((i) => i !== -1), Infinity)
  const firstOpen = Math.min(...[...OPENERS].map((c) => lineRight.indexOf(c)).filter((i) => i !== -1), Infinity)
  return firstClose !== Infinity && firstClose < firstOpen
}

/** A token the `HOST` rule found, seen with the text around it. */
function hostInText(token: string, tld: string, offset: number, text: string): string {
  return hostOrNot(token, tld, isEnclosed(text, offset, offset + token.length) ? 'enclosed' : 'plain')
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
const STATUS_LABEL = /(?:\bstatus(?:\s*code)?|\bstatusCode|\bHTTP(?:\/\d(?:\.\d)?)?|\bresponse(?:\s*code)?|\bresponded\s+with)\s*[:=]?\s*$/i
/** The platform's own codes, which never hold a customer's value: `ISH-CORE-2368`, `ORA-00001`. */
const VENDOR_CODE = /^(?:ISH(?:-[A-Z]+)+|ORA)-\d+$/
const VENDOR_CODE_PREFIX = /\b(?:ISH(?:-[A-Z]+)+|ORA)-$/
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
    if (whole && VENDOR_CODE_PREFIX.test(before)) return digits
    return '#'
  })
}

/** Words that, in a key or before a value, say the value is a secret. */
const SECRET_WORDS = 'password|passwd|pwd|secret|token|apikey|api_key|authorization|set-cookie|cookie|session'
/** A value up to the next separator; a quoted one whole. */
const SECRET_VALUE = `(?:(?:Bearer|Basic)\\s+)?(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;&()\\[\\]{}<>"']+)`

/** Whether a value after a secret's word and a space is the sentence going on, not a value. */
function isPlainWord(value: string): boolean {
  return /^[a-z]+$/.test(value)
}

/** Whether a run of 20 or more base64 characters looks like a key or a token, not a name or a path. */
function looksLikeSecretRun(run: string): boolean {
  const digits = (run.match(/\d/g) ?? []).length
  const lower = /[a-z]/.test(run)
  const upper = /[A-Z]/.test(run)
  if (digits === 0 && !/[+=]/.test(run)) return false
  // A UUID has a rule of its own.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run)) return false
  // A path (`app_x/cartridge/scripts`) is a secret only with base64's own `+` or padding.
  if (run.includes('/')) return /[+]|=$/.test(run) || (digits >= 4 && lower && upper)
  // A class name made of words and numbers (`Base64Encoder`) is a name.
  if (/^(?:[A-Z][a-z]{2,}|\d+)+$/.test(run)) return false
  return (lower && upper) || (lower && digits >= 4) || (upper && digits >= 4) || /[+=]/.test(run)
}

const RULES: readonly Rule[] = [
  // Secrets first (see above).
  [/\b((?:set-)?cookie)(\s*:\s*)[^\n]*/gi, '$1$2<secret>'],
  [new RegExp(`(\\b[\\w.-]*?(?:${SECRET_WORDS})[\\w.-]*["']?)(\\s*[=:]\\s*)${SECRET_VALUE}`, 'gi'), '$1$2<secret>'],
  [new RegExp(`\\b(${SECRET_WORDS})(\\s+)(${SECRET_VALUE})`, 'gi'), (whole: string, word: string, space: string, value: string) => (isPlainWord(value) || value === '<secret>' ? whole : `${word}${space}<secret>`)],
  [/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{6,})/g, (whole: string, scheme: string, space: string, value: string) => (isPlainWord(value) ? whole : `${scheme}${space}<secret>`)],
  [/\beyJ[\w-]{2,}\.[\w-]{2,}\.[\w-]{2,}/g, '<secret>'],
  [/(?<![\w.-])(?=[\w.-]*\d)[\w-]{16,}\.[\w-]{16,}\.[\w-]{16,}(?![\w.-])/g, '<secret>'],
  [/(?<![\w-])[0-9a-fA-F]{20,}(?![\w-])/g, '<secret>'],
  [/(?<![\w+/=-])[A-Za-z0-9+/_-]{20,}={0,2}(?![\w+/=-])/g, (run: string) => (looksLikeSecretRun(run) ? '<secret>' : run)],
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
  [NAMED_HOST, (whole, before: string, token: string, tld: string) => {
    const kept = hostOrNot(token, tld, 'named')
    return kept === '<host>' ? `${before}<host>` : whole
  }],
  // A replacer is handed the offset of the match (a number) and the whole text after its groups.
  [HOST, (token, tld: string, offset: string | number, text: string) => hostInText(token, tld, Number(offset), text)],
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
  [/\b[A-Z]{1,10}(?:-[A-Z]{1,10})*-\d+\b/g, (token) => (VENDOR_CODE.test(token) ? token : '<code>')]
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
