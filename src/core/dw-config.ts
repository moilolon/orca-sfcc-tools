// The only module that reads dw.json. It turns each role's keys into the environment b2c reads,
// and that answer goes to src/core/b2c.ts and nowhere else: the rest of the plugin only learns
// the state of the file and of each role. Nothing read here is stored, logged or put in an error
// message.
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ROLES, suffixFor, type ConfigState, type Role, type RoleState, type Suffixes } from './instances'

/** The keys of dw.json the plugin reads (each with the role's suffix) and the variable b2c gets. */
export const DW_KEYS = {
  hostname: 'SFCC_SERVER',
  username: 'SFCC_USERNAME',
  password: 'SFCC_PASSWORD',
  'client-id': 'SFCC_CLIENT_ID',
  'client-secret': 'SFCC_CLIENT_SECRET',
  'short-code': 'SFCC_SHORTCODE',
  'tenant-id': 'SFCC_TENANT_ID'
} as const

export type B2cEnvironment = Partial<Record<(typeof DW_KEYS)[keyof typeof DW_KEYS], string>>

/**
 * Why a role with a host cannot run: it has no credentials one of its sign-in methods can use,
 * or one of its values holds a control character (a NUL cannot go in an environment at all).
 */
export type IncompleteReason = 'credentials_missing' | 'value_invalid'

/**
 * One role as dw.json has it. `vars` holds every value found under the role's keys, whatever the
 * state, so all of them can be masked; only a `ready` role's are ever handed to b2c.
 */
export type RoleConfig = { readonly state: RoleState; readonly reason?: IncompleteReason; readonly vars: B2cEnvironment }

export type LoadedConfig = { readonly state: ConfigState; readonly roles: Readonly<Record<Role, RoleConfig>> }

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/**
 * Whether the role's variables hold credentials one of its sign-in methods can use: a client id
 * and secret, or on the sandbox also a user and password.
 */
export function hasCredentials(role: Role, vars: B2cEnvironment): boolean {
  if (vars.SFCC_CLIENT_ID && vars.SFCC_CLIENT_SECRET) return true
  return role === 'sandbox' && !!vars.SFCC_USERNAME && !!vars.SFCC_PASSWORD
}

/**
 * One role from the parsed file. `absent` without a `hostname` under its suffix; `incomplete`
 * with a host but no usable credentials, or with a value b2c cannot be given; `ready` otherwise.
 * No fallback: a missing suffixed key stays missing, it never takes the plain key's value, so a
 * role never gets another role's credentials.
 */
export function mapRole(config: unknown, role: Role, suffixes: Suffixes): RoleConfig {
  const suffix = suffixFor(role, suffixes)
  if (suffix === null || !config || typeof config !== 'object' || Array.isArray(config)) return { state: 'absent', vars: {} }
  const source = config as Record<string, unknown>
  const vars: B2cEnvironment = {}
  for (const [key, variable] of Object.entries(DW_KEYS)) {
    const value = source[`${key}${suffix}`]
    if (present(value)) vars[variable] = value
  }
  if (!vars.SFCC_SERVER) return { state: 'absent', vars }
  if (Object.values(vars).some((value) => CONTROL_CHARACTER.test(value))) return { state: 'incomplete', reason: 'value_invalid', vars }
  if (!hasCredentials(role, vars)) return { state: 'incomplete', reason: 'credentials_missing', vars }
  return { state: 'ready', vars }
}

export type FileSystem = { readText(path: string): Promise<string | null> }

const nodeFiles: FileSystem = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  }
}

/**
 * The main checkout of a Git worktree, from its `.git` file (`gitdir: <main>/.git/worktrees/<n>`)
 * and that folder's `commondir`; null when `root` is not a linked worktree.
 */
export async function mainCheckoutOf(root: string, fs: FileSystem = nodeFiles): Promise<string | null> {
  const dotGit = await fs.readText(join(root, '.git'))
  const match = dotGit?.match(/^gitdir:\s*(.+?)\s*$/m)
  if (!match) return null
  const gitDir = resolve(root, match[1])
  const common = (await fs.readText(join(gitDir, 'commondir')))?.trim()
  const commonDir = common ? resolve(gitDir, common) : null
  return commonDir ? dirname(commonDir) : null
}

/**
 * The file to read for a workspace: the `configFile` setting when given (relative to the
 * workspace), else `dw.json` at the workspace root, else at the main checkout's root.
 */
export async function locateConfig(root: string, configFile: string, fs: FileSystem = nodeFiles): Promise<{ path: string; text: string } | null> {
  const candidates: string[] = []
  if (configFile.trim()) {
    candidates.push(isAbsolute(configFile) ? configFile : resolve(root, configFile))
  } else {
    candidates.push(join(root, 'dw.json'))
    const main = await mainCheckoutOf(root, fs)
    if (main) candidates.push(join(main, 'dw.json'))
  }
  for (const path of candidates) {
    const text = await fs.readText(path)
    if (text !== null) return { path, text }
  }
  return null
}

/**
 * The folder whose dw.json `locateConfig` reads for `root`: `root` itself (always, when the
 * `configFile` setting names a file), else its main checkout when only that one holds a
 * `dw.json`; null when neither does.
 */
export async function configFolderOf(root: string, configFile: string, fs: FileSystem = nodeFiles): Promise<string | null> {
  if (configFile.trim()) return root
  if ((await fs.readText(join(root, 'dw.json'))) !== null) return root
  const main = await mainCheckoutOf(root, fs)
  if (main && (await fs.readText(join(main, 'dw.json'))) !== null) return main
  return null
}

export type DwConfigOptions = { root: string | null; configFile: string; suffixes: Suffixes }

function everyRole(map: (role: Role) => RoleConfig): Record<Role, RoleConfig> {
  const roles = {} as Record<Role, RoleConfig>
  for (const role of ROLES) roles[role] = map(role)
  return roles
}

/**
 * The file's state and every role's. Only src/core/b2c.ts calls it. It never throws: no
 * workspace or no file is `missing`, and a file that is not a JSON object is `invalid`, with
 * every role absent (JSON.parse's own message quotes the text, so it is never passed on).
 */
export async function loadConfig(options: DwConfigOptions, fs: FileSystem = nodeFiles): Promise<LoadedConfig> {
  const none = (state: ConfigState): LoadedConfig => ({ state, roles: everyRole(() => ({ state: 'absent', vars: {} })) })
  if (!options.root) return none('missing')
  const found = await locateConfig(options.root, options.configFile, fs)
  if (!found) return none('missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(found.text.replace(/^﻿/, ''))
  } catch {
    return none('invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none('invalid')
  return { state: 'ok', roles: everyRole((role) => mapRole(parsed, role, options.suffixes)) }
}
