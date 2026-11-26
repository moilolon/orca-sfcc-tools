// Typed reads of the plugin's settings (declared in src/manifest.base.json) and their changes.
import type { JsonValue } from 'orca'
import type { Suffixes } from './instances'

export type SettingsValues = {
  /** The b2c executable: a name looked up on PATH, or a full path. */
  b2cPath: string
  /** A dw.json to read instead of the workspace's own; relative paths start at the workspace. */
  configFile: string
  developmentSuffix: string
  stagingSuffix: string
  productionSuffix: string
}

/** The defaults, the same as the manifest's (a test keeps them equal). */
export const DEFAULT_SETTINGS: Readonly<SettingsValues> = {
  b2cPath: 'b2c',
  configFile: '',
  developmentSuffix: '-dev',
  stagingSuffix: '-stg',
  productionSuffix: '-prd'
}

export type SettingsSource = {
  get(): Promise<Record<string, JsonValue>>
  onDidChange(listener: (change: { key: string }) => void): { dispose(): void }
}

export type Settings = {
  read(): Promise<SettingsValues>
  suffixes(): Promise<Suffixes>
  onDidChange(listener: (key: keyof SettingsValues | string) => void): { dispose(): void }
}

/** A stored value of the right type, else the default. */
export function coerceSettings(raw: Record<string, JsonValue> | null | undefined): SettingsValues {
  const values = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SettingsValues)[]) {
    const value = raw?.[key]
    if (typeof value === 'string') values[key] = value
  }
  // An empty path cannot start anything: it means the default.
  if (!values.b2cPath.trim()) values.b2cPath = DEFAULT_SETTINGS.b2cPath
  return values
}

export function createSettings(source: SettingsSource): Settings {
  const read = async () => coerceSettings(await source.get())
  return {
    read,
    async suffixes() {
      const values = await read()
      return { development: values.developmentSuffix, staging: values.stagingSuffix, production: values.productionSuffix }
    },
    onDidChange(listener) {
      return source.onDidChange(({ key }) => listener(key))
    }
  }
}
