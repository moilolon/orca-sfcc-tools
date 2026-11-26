// The code version each workspace uploads to: `<prefix><workspace slug>`, derived once from the
// workspace's name and then kept per workspace id, so renaming the workspace does not orphan its
// version on the sandbox. Pure: no Node or Orca imports.

/** The prefix when the setting is empty or unusable. */
export const DEFAULT_PREFIX = 'ws-'

/** The longest slug, and the longest prefix kept; a code version is a folder name on WebDAV. */
export const MAX_SLUG = 40
export const MAX_PREFIX = 16

/** The slug of a workspace that has no letter or digit in its name. */
const FALLBACK_SLUG = 'workspace'

/**
 * Lower case letters, digits and single hyphens, with accents dropped (`Tienda Señor_2` gives
 * `tienda-senor-2`), at most `MAX_SLUG` characters and never starting or ending in a hyphen.
 */
export function slugOf(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '')
  return slug || FALLBACK_SLUG
}

/**
 * The prefix as the setting gives it, kept to letters, digits, `-` and `_` (nothing a shell or a
 * URL reads), at most `MAX_PREFIX` of them. Never empty: a value that is not a text, or holds none
 * of those characters, means the default, so a workspace name alone never names a version that
 * someone else created.
 */
export function prefixOf(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PREFIX
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_PREFIX) || DEFAULT_PREFIX
}

/**
 * The name for a workspace that has none yet: `<prefix><slug>`, and `-2`, `-3`, … when another
 * workspace, or a version waiting to be deleted, already holds it.
 */
export function deriveName(prefix: string, workspaceName: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()))
  const base = `${prefix}${slugOf(workspaceName)}`
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/** The code versions kept per workspace id. */
export type VersionNames = Readonly<Record<string, string>>

/**
 * The workspace's code version: the one stored for its id, else a new one derived from its name.
 * `names` is returned with it, holding the new one when there was none.
 */
export function versionFor(
  names: VersionNames,
  workspace: { id: string; name: string },
  prefix: string,
  alsoTaken: Iterable<string> = []
): { name: string; names: VersionNames } {
  const stored = names[workspace.id]
  if (stored) return { name: stored, names }
  const name = deriveName(prefix, workspace.name, [...Object.values(names), ...alsoTaken])
  return { name, names: { ...names, [workspace.id]: name } }
}
