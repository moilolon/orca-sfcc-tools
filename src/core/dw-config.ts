// The only module that reads dw.json. It turns one role's keys into the environment b2c reads,
// and that answer goes to src/core/b2c.ts and nowhere else: the rest of the plugin only learns
// whether a role is configured. Nothing read here is stored, logged or put in an error message.
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { suffixFor, type Role, type Suffixes } from './instances'

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

/** A thrown error that carries only a code: never a path's content or a value. */
export class ConfigError extends Error {
  readonly code = 'config_invalid'
  constructor() {
    super('config_invalid')
  }
}

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * One role's variables from the parsed file, or null when the role is not configured (no
 * `hostname` with its suffix). No fallback: a missing suffixed key stays missing, it never takes
 * the plain key's value, so a role never gets another role's credentials.
 */
export function mapRole(config: unknown, role: Role, suffixes: Suffixes): B2cEnvironment | null {
  const suffix = suffixFor(role, suffixes)
  if (suffix === null || !config || typeof config !== 'object' || Array.isArray(config)) return null
  const source = config as Record<string, unknown>
  if (!present(source[`hostname${suffix}`])) return null
  const env: B2cEnvironment = {}
  for (const [key, variable] of Object.entries(DW_KEYS)) {
    const value = source[`${key}${suffix}`]
    if (present(value)) env[variable] = value
  }
  return env
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

export type DwConfigOptions = { root: string | null; configFile: string; suffixes: Suffixes }

/**
 * One role's variables for b2c, or null when the role is not configured or there is no file.
 * Only src/core/b2c.ts calls it. A file that is not JSON throws a ConfigError, whose message is
 * its code alone (JSON.parse's own message quotes the text, so it is never passed on).
 */
export async function resolveRole(role: Role, options: DwConfigOptions, fs: FileSystem = nodeFiles): Promise<B2cEnvironment | null> {
  if (!options.root) return null
  const found = await locateConfig(options.root, options.configFile, fs)
  if (!found) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(found.text.replace(/^﻿/, ''))
  } catch {
    throw new ConfigError()
  }
  return mapRole(parsed, role, options.suffixes)
}
