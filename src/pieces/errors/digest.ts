// What one read of a log becomes, shared by the worker and the command line of bin/errors.ts, so
// both ask b2c the same thing and keep the same signatures and samples: the arguments of a read,
// the occurrences of each signature, and each signature's sample, masked and normalised.
//
// Pure over the `mask` it is given (the runner's own), with no Orca import: the command line
// loads it under plain Node, so it imports explicit `.ts` files only.
import { ERROR_LEVELS, parseMessage, type LogEntry, type ParsedMessage } from './reader.ts'
import type { Sample } from './seen.ts'
import { identityOf, normalize, signatureOfIdentity } from './signature.ts'

/** The most entries one read asks for. b2c also reads only the last 64 KB of each file. */
export const MAX_ENTRIES = 200
/** How much of a file b2c reads, from its end. */
export const FILE_WINDOW_BYTES = 64 * 1024
/** Entries of one file adding up to this much mean its window was (nearly) full. */
export const FULL_WINDOW_BYTES = 48 * 1024

/** The arguments of one read: ERROR and FATAL entries of the files named, since `since`, at most `MAX_ENTRIES`. */
export function readArguments(filters: readonly string[], since: number): string[] {
  // `--no-normalize`: the frames keep the instance's own script paths, so a signature does not
  // depend on the checkout, and no local path reaches the sample. `--level`: a file the setting
  // names may mix levels (`custom-*`); only errors are read.
  return [
    'logs',
    'get',
    '--no-normalize',
    ...filters.map((filter) => `--filter=${filter}`),
    ...ERROR_LEVELS.map((level) => `--level=${level}`),
    `--count=${MAX_ENTRIES}`,
    `--since=${new Date(since).toISOString()}`
  ]
}

/** The arguments of the listing that comes before each read of the worker: the same files. */
export function listArguments(filters: readonly string[]): string[] {
  return ['logs', 'list', ...filters.map((filter) => `--filter=${filter}`)]
}

/** The number of entries b2c returned, whatever their level. */
export function returnedCount(json: unknown): number {
  const entries = json && typeof json === 'object' ? (json as { entries?: unknown }).entries : undefined
  return Array.isArray(entries) ? entries.length : 0
}

/**
 * Whether b2c's answer was cut: it kept `MAX_ENTRIES`, or the error entries of one file add up to
 * nearly its whole window. Entries since the last read may then never be seen.
 */
export function windowFull(json: unknown, entries: readonly LogEntry[]): boolean {
  if (returnedCount(json) >= MAX_ENTRIES) return true
  const bytesPerFile = new Map<string, number>()
  for (const entry of entries) bytesPerFile.set(entry.file, (bytesPerFile.get(entry.file) ?? 0) + entry.bytes)
  return [...bytesPerFile.values()].some((bytes) => bytes >= FULL_WINDOW_BYTES)
}

/** Each entry's signature and time, oldest first, and the newest entry of each signature. */
export function occurrencesOf(entries: readonly LogEntry[]): { occurrences: { signature: string; at: number }[]; newest: Map<string, { parsed: ParsedMessage; level: string }> } {
  const occurrences: { signature: string; at: number }[] = []
  const newest = new Map<string, { parsed: ParsedMessage; level: string }>()
  for (const entry of entries) {
    const parsed = parseMessage(entry.message)
    const signature = signatureOfIdentity(identityOf(parsed))
    occurrences.push({ signature, at: entry.timestamp })
    // Entries come oldest first: the last one of a signature is its newest.
    newest.set(signature, { parsed, level: entry.level })
  }
  return { occurrences, newest }
}

/** Texts masked with one call to `mask`. A text holds no line break, so the lines map back. */
async function maskAll(texts: readonly string[], mask: (text: string) => Promise<string>): Promise<string[]> {
  if (texts.length === 0) return []
  const masked = (await mask(texts.map((text) => text.replace(/[\r\n]+/g, ' ')).join('\n'))).split('\n')
  return texts.map((_, index) => masked[index] ?? '')
}

/**
 * The samples of the newest entry of each signature. Masked, then normalised (a host in the text
 * is masked whole before its digits go, and a URL loses its host), then masked again. The level is
 * one of ERROR_LEVELS, never a text of the log; the site is not kept.
 */
export async function maskedSamples(newest: ReadonlyMap<string, { parsed: ParsedMessage; level: string }>, mask: (text: string) => Promise<string>): Promise<Map<string, Sample>> {
  const plan = [...newest].map(([signature, { parsed, level }]) => ({ signature, parsed, level, identity: identityOf(parsed) }))
  // A sample as a list of texts, and back: message, logger, pipeline, then each frame's file and function.
  const flatten = (sample: Sample) => [sample.message, sample.logger ?? '', sample.pipeline ?? '', ...sample.frames.flatMap((frame) => [frame.file, frame.function ?? ''])]
  const rebuild = (sample: Sample, texts: string[]): Sample => {
    let i = 0
    const next = () => texts[i++] ?? ''
    const message = next()
    const logger = next()
    const pipeline = next()
    return {
      message,
      logger: sample.logger === null ? null : logger,
      pipeline: sample.pipeline ? pipeline : null,
      level: sample.level ?? null,
      frames: sample.frames.map((frame) => {
        const file = next()
        const name = next()
        return { file, function: frame.function === null ? null : name, line: frame.line }
      })
    }
  }
  const maskEach = async (samples: Sample[]): Promise<Sample[]> => {
    const masked = await maskAll(samples.flatMap(flatten), mask)
    let offset = 0
    return samples.map((sample) => {
      const size = flatten(sample).length
      return rebuild(sample, masked.slice(offset, (offset += size)))
    })
  }
  const raw: Sample[] = plan.map(({ parsed, level, identity }) => ({
    message: parsed.text,
    logger: identity.logger,
    pipeline: parsed.pipeline,
    level: ERROR_LEVELS.includes(level.toUpperCase()) ? level.toUpperCase() : null,
    frames: identity.frames.map((frame) => ({ file: frame.file, function: frame.function, line: frame.line }))
  }))
  const normalised = (await maskEach(raw)).map((sample) => ({ ...sample, message: normalize(sample.message) }))
  const twice = await maskEach(normalised)
  return new Map(twice.map((sample, index) => [plan[index].signature, sample]))
}
