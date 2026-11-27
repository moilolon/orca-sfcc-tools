// The command line of bin/errors.ts, for a bot's morning report: its arguments, the plugin's own
// runner over the dw.json given, the report (report.ts) and the exit code.
//
//   node bin/errors.ts --config-file <dw.json> --role <role>... [--json] [--since <time>] [--lang <en|es>]
//
// The dw.json is read by src/core/dw-config.ts alone, through the runner, as the plugin reads it
// with its `configFile` setting; its values reach b2c only in the child's environment, and its
// path is never printed. Each role reads its keys with the plugin's default suffixes.
//
// Exit 0 with a report, 1 when an environment, the seen list or the last report could not be read
// (the report still says which), 2 when the arguments are wrong.
//
// Under plain Node 22.18 or later (type stripping): explicit `.ts` imports only.
import { dirname, resolve } from 'node:path'
import { createB2c, type B2cDeps } from '../../core/b2c.ts'
import { languageOf, t } from '../../core/i18n.ts'
import { isRole, type Role } from '../../core/instances.ts'
import { DEFAULT_SETTINGS, type Settings } from '../../core/settings.ts'
import { dataFiles, dataFolder } from './data-folder.ts'
import { cliMessages, type CliMessageKey } from './i18n.ts'
import { buildReport, commitReport, formatJson, formatText, reportOk } from './report.ts'

export type CliOptions = { configFile: string; roles: Role[]; json: boolean; since: number | null; lang: string | null; help: boolean }

type UsageReason = 'usage.config' | 'usage.role' | 'usage.roleUnknown' | 'usage.since' | 'usage.lang' | 'usage.unknown'

/** `90m`, `12h`, `2d` ago, or an ISO 8601 time; null when it is neither. */
export function parseSince(text: string, now: number): number | null {
  const duration = /^(\d{1,5})([mhd])$/.exec(text.trim())
  if (duration) return now - Number(duration[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as 'm' | 'h' | 'd']
  if (!/^\d{4}-\d{2}-\d{2}/.test(text.trim())) return null
  const at = Date.parse(text.trim())
  return Number.isNaN(at) ? null : at
}

/** The arguments, or why they are wrong. `--flag value` and `--flag=value` both work. */
export function parseArguments(argv: readonly string[], now: number): CliOptions | { error: UsageReason } {
  const options: CliOptions = { configFile: '', roles: [], json: false, since: null, lang: null, help: false }
  let configs = 0
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const value = () => (equals === -1 ? argv[++i] : arg.slice(equals + 1))
    if (name === '--help' || name === '-h') options.help = true
    else if (name === '--json' && equals === -1) options.json = true
    else if (name === '--config-file') {
      const path = value()
      if (!path || configs++ > 0) return { error: 'usage.config' }
      options.configFile = path
    } else if (name === '--role') {
      const role = value()
      if (!isRole(role)) return { error: role ? 'usage.roleUnknown' : 'usage.role' }
      if (!options.roles.includes(role)) options.roles.push(role)
    } else if (name === '--since') {
      const since = parseSince(value() ?? '', now)
      if (since === null) return { error: 'usage.since' }
      options.since = since
    } else if (name === '--lang') {
      const lang = value()
      if (lang !== 'en' && lang !== 'es') return { error: 'usage.lang' }
      options.lang = lang
    } else return { error: 'usage.unknown' }
  }
  if (options.help) return options
  if (!options.configFile) return { error: 'usage.config' }
  if (options.roles.length === 0) return { error: 'usage.role' }
  return options
}

/** Settings as the plugin's defaults, with `configFile` the file given. */
function settingsFor(configFile: string): Settings {
  const values = { ...DEFAULT_SETTINGS, configFile }
  return {
    read: async () => values,
    suffixes: async () => ({ development: values.developmentSuffix, staging: values.stagingSuffix, production: values.productionSuffix }),
    onDidChange: () => ({ dispose() {} })
  }
}

export type CliDeps = {
  write?: (text: string) => Promise<void>
  writeError?: (text: string) => Promise<void>
  env?: Record<string, string | undefined>
  now?: () => number
  cwd?: string
  /** The data folder; default `dataFolder()`. */
  dataFolder?: string
  /** What the runner is given beyond the settings and the folder of the file (tests: a fake b2c). */
  runner?: Partial<Omit<B2cDeps, 'settings' | 'configRoot' | 'knownRoots'>>
}

function writer(stream: NodeJS.WriteStream): (text: string) => Promise<void> {
  return (text) => new Promise((done, fail) => stream.write(text, (error) => (error ? fail(error) : done())))
}

/** Runs the command line; answers its exit code. */
export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const write = deps.write ?? writer(process.stdout)
  const writeError = deps.writeError ?? writer(process.stderr)
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const parsed = parseArguments(argv, now())
  const langOf = (lang: string | null) => languageOf(lang ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? 'en')
  const say = (lang: string | null, key: CliMessageKey, vars?: Record<string, string | number>) => t(cliMessages, langOf(lang), key, vars)
  if ('error' in parsed) {
    const lang = argv.includes('--lang=es') || argv.join(' ').includes('--lang es') ? 'es' : null
    await writeError(`${say(lang, 'usage', { reason: say(lang, parsed.error) })}\n`)
    return 2
  }
  if (parsed.help) {
    await write(`${say(parsed.lang, 'help')}\n`)
    return 0
  }
  const configFile = resolve(deps.cwd ?? process.cwd(), parsed.configFile)
  const b2c = createB2c({ env, ...deps.runner, settings: settingsFor(configFile), configRoot: async () => dirname(configFile) })
  const files = dataFiles(deps.dataFolder ?? dataFolder({ env }))
  const { report, cursors } = await buildReport({ b2c, roles: parsed.roles, seenPath: files.seen, reportPath: files.report, now, since: parsed.since ?? undefined })
  await write(parsed.json ? formatJson(report) : formatText(report, langOf(parsed.lang)))
  // Printed whole: only now do the cursors move.
  try {
    await commitReport(files.report, report, cursors)
  } catch {
    // The next report reads the same window again: nothing is lost, it is only repeated.
    return 1
  }
  return reportOk(report) ? 0 : 1
}
