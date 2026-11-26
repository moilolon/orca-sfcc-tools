// Typed access to the plugin's own storage, one namespace per piece: a piece's key `seen` is
// stored as `errors.seen`, so pieces never read or overwrite each other's data.
import type { JsonValue } from 'orca'

export type StorageSource = {
  get(key: string): Promise<JsonValue | null>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export type Store = {
  readonly namespace: string
  get<T extends JsonValue>(key: string, fallback: T): Promise<T>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<void>
  /** This namespace's keys, without the prefix. */
  keys(): Promise<string[]>
}

export function createStore(storage: StorageSource, namespace: string): Store {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw new Error(`invalid store namespace: ${namespace}`)
  const prefix = `${namespace}.`
  return {
    namespace,
    async get<T extends JsonValue>(key: string, fallback: T): Promise<T> {
      const value = await storage.get(prefix + key)
      return value === null || value === undefined ? fallback : (value as T)
    },
    set: (key, value) => storage.set(prefix + key, value),
    delete: (key) => storage.delete(prefix + key),
    async keys() {
      return (await storage.keys()).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
    }
  }
}
