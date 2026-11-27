// The index of a checkout (phase 6.3): its cartridges, each storefront's cartridge path and where
// it came from, module resolution along a path, templates, resource bundles, the metadata's
// custom attributes and site preferences, and the SFRA routes of every controller. Parts 6.4
// (queries) and 6.5 (problems) read it.
//
// It reads files only through the `CheckoutFiles` it is given and a git ref only through a
// `RefReader`, so it is pure: no Node, no Orca. It keeps, per file, what `scan.ts` takes of it with
// the file's time: a rebuild reads again only a file whose time changed, and `update(paths)` reads
// only the files named (a folder named is walked again). Everything derived from the files (the
// cartridges, the paths, the bundles, the routes) is recomputed in memory after each change.
import { basename, dirname, eachLimited, extname, isUnder, joinPath, normalizePath, skippedPath, walkFiles, type CheckoutFiles } from './files'
import { isMetadataPath, parseMetadata, SITE_PREFERENCES, type AttributeDefinition, type ObjectTypeDefinition, type ObjectTypeKind } from './metadata'
import { parseProperties, type PropertyKey } from './properties'
import { DEFINING_METHODS, scanScript, scanTemplate, type ControllerFacts, type RouteOperation, type ScriptFileFacts, type TemplateFileFacts } from './scan'
import { isSiteArchivePath, parseSiteArchive, SETTING_STOREFRONT, splitCartridgePath, type PathSource, type SiteArchive } from './sites'

// ---------------------------------------------------------------------------------------------
// The git ref, read without checking it out

/** Why a git ref could not be read; worded by whoever shows it. */
export type GitFailure = 'git_not_found' | 'git_shim_refused' | 'git_failed' | 'git_timeout' | 'git_output_too_large' | 'ref_invalid' | 'ref_not_found' | 'path_invalid'

export class GitError extends Error {
  readonly code: GitFailure
  constructor(code: GitFailure) {
    super(code)
    this.code = code
  }
}

/** Reads a ref of the checkout's repository; `git.ts` starts git for it in the worker. */
export interface RefReader {
  /** The commit the ref names; null when it names none. */
  commit(ref: string): Promise<string | null>
  /** Every file below `path` at the ref (`''` for the whole tree), relative to the repository. */
  list(ref: string, path: string): Promise<string[]>
  /** A file's text at the ref; null when the ref has no such file. */
  read(ref: string, path: string): Promise<string | null>
}

// ---------------------------------------------------------------------------------------------
// What the index answers

export type CartridgeKind = 'cartridge' | 'modules'

export type Cartridge = {
  name: string
  /** Its folder, relative to the checkout. */
  root: string
  /** `cartridge`: a folder with `.project` and `cartridge/`; `modules`: SFRA's `modules` folder, where bare `require` names resolve. */
  kind: CartridgeKind
  /** Its folders under `cartridge/` (`controllers`, `scripts`, `models`, `templates/default`, `forms/default`, `static/default`, …). */
  folders: string[]
  /** The locale folders of `templates/` (`default`, `fr_FR`), `resources` left out. */
  templateLocales: string[]
  formLocales: string[]
  files: number
}

export type Storefront = {
  /** The site id; `setting` for the path of the setting. */
  id: string
  source: PathSource
  /** The path as written, first cartridge first. */
  cartridges: string[]
  /** Cartridges of the path the checkout does not hold. */
  missing: string[]
  /** The site archive it came from (a path in the checkout, or in the ref); null for the setting. */
  file: string | null
  /** Other site archives of the same site with another path, left out. */
  conflicts: number
}

/** A copy of a file on one storefront: the one that runs there, or null when none does. */
export type Copy = { storefront: string; path: string | null }

export type ModuleResolution =
  /**
   * `./x`, `../x`, `~/cartridge/x` (the current cartridge), `<cartridge>/cartridge/x`, a bare name
   * of the `modules` folder (`server`), or a cartridge's name (`main`: what its `package.json` names).
   */
  | { kind: 'file'; module: string; form: 'relative' | 'current' | 'cartridge' | 'modules' | 'main'; path: string | null }
  /** `*\/cartridge/x`: the first cartridge of each storefront's path that has it. `candidates` is every cartridge's copy. */
  | { kind: 'path'; module: string; form: 'path'; copies: Copy[]; candidates: string[] }
  /** `dw/…`: a class (`dw.catalog.ProductMgr`) or a package (`dw.system`) of the `dw.*` index, null when it has none of that name. */
  | { kind: 'dw'; module: string; form: 'dw'; id: string | null }

export type SuperModuleCopy = Copy & {
  /** Whether the file's cartridge is on that storefront's path at all. */
  onPath: boolean
}

export type SuperModuleResolution = {
  /** The file's path inside its cartridge (`cartridge/models/product.js`). */
  module: string | null
  copies: SuperModuleCopy[]
}

export type TemplateCopy = Copy & { locale: string | null }

export type TemplateResolution = {
  /** The name made plain: no leading `/`, no `.isml`. */
  name: string
  locale: string
  copies: TemplateCopy[]
  /** Every copy in any cartridge and locale folder. */
  candidates: string[]
}

export type ResourceKey = PropertyKey & {
  path: string
  cartridge: string
  /** The bundle file's name without `.properties` (`product_fr`). */
  bundle: string
}

export type ResourceCopy = { storefront: string; key: ResourceKey | null }

export type ResourceResolution = {
  key: string
  bundle: string
  locale: string
  copies: ResourceCopy[]
  /** Every definition of the key in a bundle of that name, any cartridge and locale. */
  candidates: ResourceKey[]
}

export type RouteStep = RouteOperation & { path: string; cartridge: string }

export type RouteProblemCode =
  /** `append` or `prepend` on a route the chain does not have. */
  | 'route_missing'
  /** `get`, `post` or `use` on a name the chain already has: the later one wins. */
  | 'route_redefined'
  /** `server.extend(module.superModule)` with no copy after it on the path. */
  | 'base_missing'
  /** The controller that runs does not export `server.exports()`. */
  | 'not_exported'

export type RouteProblem = { code: RouteProblemCode; path: string; start: number; end: number }

export type RouteChain = {
  storefront: string
  /** The controller copy that runs on the storefront; null when none does. */
  controller: string | null
  /** The steps in the order they run: prepends, the declaration, appends. Empty when the route is not served. */
  steps: RouteStep[]
  /** Every operation on the route along the chain, in the order they are applied. */
  applied: RouteStep[]
  problems: RouteProblem[]
}

export type RouteResolution = {
  controller: string
  name: string
  storefronts: RouteChain[]
}

export type ObjectType = {
  typeId: string
  kind: ObjectTypeKind
  attributes: AttributeDefinition[]
}

export type MetadataSource = 'checkout' | 'git-ref' | 'none'

export type IndexCounts = {
  files: number
  scripts: number
  controllers: number
  templates: number
  bundles: number
  resourceKeys: number
  objectTypes: number
  attributes: number
  sitePreferences: number
  /** Route declarations (`get`, `post`, `use`, `append`, `prepend`, `replace`) in controllers. */
  routes: number
  /** Literal `require` calls, and how many resolve (on every storefront whose path holds the file). */
  requires: number
  requiresResolved: number
  requiresUnresolved: number
  templateUses: number
  templateUsesUnresolved: number
  resourceUses: number
  resourceUsesUnresolved: number
}

export type IndexStatus = {
  cartridges: { name: string; kind: CartridgeKind; files: number }[]
  /** Cartridge names held by more than one folder: the first, by path, is used. */
  duplicates: string[]
  storefronts: Storefront[]
  /** Where the paths came from: the source of every storefront, `none` without one. */
  pathSource: PathSource | 'none'
  metadataSource: MetadataSource
  /** Why the git ref could not be read, when it was needed. */
  gitError: GitFailure | null
  counts: IndexCounts
  /** The walk stopped at a bound: some files are not indexed. */
  truncated: boolean
  /** When the last full build ended, and how long it took. */
  builtAt: number | null
  buildMs: number | null
  /** When the last update ended, and how long it took. */
  updatedAt: number | null
  updateMs: number | null
}

export type CheckoutSettings = {
  /** The `cartridgePath` setting: colon-separated; empty when unset. */
  cartridgePath?: string
  /** The `metadataRef` setting: a git ref read for site archives and metadata; empty when unset. */
  metadataRef?: string
}

export type CheckoutOptions = CheckoutSettings & {
  git?: RefReader | null
  /** The id of the class or package a `dw/…` module path names, from the `dw.*` index; null when it has none. */
  dw?: ((module: string) => string | null) | null
  now?: () => number
  /** How many files are read at once. */
  concurrency?: number
}

// ---------------------------------------------------------------------------------------------
// Files

type FileKind = 'script' | 'controller' | 'template' | 'properties' | 'site' | 'metadata' | 'package' | 'other'

type FileRecord =
  | { kind: 'script' | 'controller'; time: number | null; facts: ScriptFileFacts }
  | { kind: 'template'; time: number | null; facts: TemplateFileFacts }
  | { kind: 'properties'; time: number | null; keys: PropertyKey[] }
  | { kind: 'site'; time: number | null; site: SiteArchive | null }
  | { kind: 'metadata'; time: number | null; types: ObjectTypeDefinition[] }
  /** A cartridge's own `package.json`: its `main` is what `require('<cartridge>')` loads. */
  | { kind: 'package'; time: number | null; main: string | null }

type CartridgeEntry = Cartridge & {
  /** Its files, relative to its folder (`cartridge/scripts/x.js`). */
  paths: Set<string>
}

const MODULE_EXTENSIONS = ['.js', '.ds', '.json']
const MAX_CHAIN_DEPTH = 64

/** The locale fallbacks of a template or bundle: `fr_FR`, then `fr`, then `default`. */
export function localeFallbacks(locale: string): string[] {
  const plain = locale.trim() || 'default'
  if (plain === 'default') return ['default']
  const parts = plain.split(/[_-]/)
  const out: string[] = []
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('_'))
  out.push('default')
  return [...new Set(out)]
}

/** A template name made plain: no leading `/`, no `.isml`, `\` as `/`. */
export function templateName(name: string): string {
  return name.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.isml$/i, '')
}

/** `Controller-Name` into its two parts; the name may hold `-` too, the controller may not. */
export function splitRouteId(id: string): { controller: string; name: string } | null {
  const at = id.indexOf('-')
  if (at <= 0 || at === id.length - 1) return null
  return { controller: id.slice(0, at), name: id.slice(at + 1) }
}

type GitCache = { ref: string; commit: string; archives: SiteArchive[]; metadata: ObjectTypeDefinition[] }

export class CheckoutIndex {
  private readonly files: CheckoutFiles
  private settings: Required<CheckoutSettings>
  private readonly git: RefReader | null
  private readonly dw: ((module: string) => string | null) | null
  private readonly now: () => number
  private readonly concurrency: number

  private paths = new Set<string>()
  private records = new Map<string, FileRecord>()
  private truncated = false
  private queue: Promise<unknown> = Promise.resolve()

  // Derived
  private cartridgeList: CartridgeEntry[] = []
  private byName = new Map<string, CartridgeEntry>()
  private roots = new Map<string, CartridgeEntry>()
  private duplicates: string[] = []
  private storefrontList: Storefront[] = []
  private pathSource: PathSource | 'none' = 'none'
  private metadataSource: MetadataSource = 'none'
  private objectTypes = new Map<string, ObjectType>()
  private bundles = new Map<string, Map<string, Map<string, ResourceKey>>>()
  /** Every definition of a key, in any bundle and cartridge, the cartridges in order of their names. */
  private keyIndex = new Map<string, ResourceKey[]>()
  private gitCache: GitCache | null = null
  private refRead: Promise<GitCache | null> | null = null
  private refAllowed = false
  private gitError: GitFailure | null = null
  private routeTables = new Map<string, Map<string, Map<string, RouteChain>>>()
  private countsCache: IndexCounts | null = null
  private builtAt: number | null = null
  private buildMs: number | null = null
  private updatedAt: number | null = null
  private updateMs: number | null = null

  constructor(files: CheckoutFiles, options: CheckoutOptions = {}) {
    this.files = files
    this.settings = { cartridgePath: options.cartridgePath ?? '', metadataRef: options.metadataRef ?? '' }
    this.git = options.git ?? null
    this.dw = options.dw ?? null
    this.now = options.now ?? (() => Date.now())
    this.concurrency = Math.max(1, options.concurrency ?? 8)
  }

  /** Runs one change at a time: a build, an update and a change of settings never interleave. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Walks the whole checkout; files whose time did not change are not read again. */
  build(): Promise<void> {
    return this.serial(async () => {
      const started = this.now()
      const walked = await walkFiles(this.files)
      this.truncated = walked.truncated
      this.paths = new Set(walked.files)
      for (const path of [...this.records.keys()]) if (!this.paths.has(path)) this.records.delete(path)
      this.roots = this.findRoots()
      await this.refresh(walked.files)
      await this.derive(true)
      this.builtAt = this.now()
      this.buildMs = this.builtAt - started
    })
  }

  /**
   * Takes in the paths a watcher reported changed: a file is read again when its time changed, a
   * folder is walked again, a path gone is dropped with what was below it. A `.project` added or
   * removed changes what is a cartridge: every file is classified again (reading only those whose
   * time or kind changed).
   */
  update(changed: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const started = this.now()
      let structural = false
      let archives = false
      const touched = new Set<string>()
      const drop = (known: string) => {
        const kind = this.records.get(known)?.kind
        if (kind === 'site' || kind === 'metadata') archives = true
        if (basename(known) === '.project') structural = true
        this.drop(known)
      }
      for (const raw of new Set(changed)) {
        const path = normalizePath(raw)
        if (path === null || path === '' || skippedPath(path)) continue
        const entries = await this.files.list(path)
        if (entries) {
          const walked = await walkFiles(this.files, path)
          const present = new Set(walked.files)
          for (const known of [...this.paths]) {
            if (isUnder(known, path) && !present.has(known)) drop(known)
          }
          for (const file of walked.files) {
            if (!this.paths.has(file) && basename(file) === '.project') structural = true
            this.paths.add(file)
            touched.add(file)
          }
          continue
        }
        const time = await this.files.time(path)
        if (time === null) {
          for (const known of [...this.paths]) {
            if (isUnder(known, path)) drop(known)
          }
        } else {
          if (!this.paths.has(path) && basename(path) === '.project') structural = true
          this.paths.add(path)
          touched.add(path)
        }
      }
      if (structural) {
        this.roots = this.findRoots()
        await this.refresh([...this.paths].sort())
      } else {
        await this.refresh([...touched].sort())
      }
      // A cartridge's own file (its `.project`) changes its path's membership: the paths are rebuilt.
      await this.derive(structural || archives || [...touched].some((path) => this.records.get(path)?.kind === 'site' || this.records.get(path)?.kind === 'metadata'))
      this.updatedAt = this.now()
      this.updateMs = this.updatedAt - started
    })
  }

  /** A change of the settings: the paths are rebuilt, the git ref read again when it changed. */
  configure(settings: CheckoutSettings): Promise<void> {
    return this.serial(async () => {
      const next = { cartridgePath: settings.cartridgePath ?? this.settings.cartridgePath, metadataRef: settings.metadataRef ?? this.settings.metadataRef }
      this.settings = next
      await this.derive(true)
    })
  }

  /** The ref may point at another commit (a fetch, a commit): read it again if it does. */
  refreshRef(): Promise<void> {
    return this.serial(() => this.derive(true))
  }

  private drop(path: string): void {
    this.paths.delete(path)
    this.records.delete(path)
  }

  // ---- classification

  private findRoots(): Map<string, CartridgeEntry> {
    const projects: string[] = []
    for (const path of this.paths) if (basename(path) === '.project') projects.push(dirname(path))
    const roots = new Map<string, CartridgeEntry>()
    const hasCartridgeFolder = new Set<string>()
    for (const path of this.paths) {
      const at = path.indexOf('/cartridge/')
      if (at !== -1) {
        // Every folder that holds a `cartridge/` folder somewhere in the path.
        let from = 0
        while (true) {
          const found = path.indexOf('/cartridge/', from)
          if (found === -1) break
          hasCartridgeFolder.add(path.slice(0, found))
          from = found + 1
        }
      } else if (path.startsWith('cartridge/')) {
        hasCartridgeFolder.add('')
      }
    }
    for (const root of projects.sort()) {
      const name = root === '' ? '' : basename(root)
      if (!name) continue
      if (hasCartridgeFolder.has(root)) roots.set(root, this.emptyCartridge(name, root, 'cartridge'))
      else if (name === 'modules') roots.set(root, this.emptyCartridge(name, root, 'modules'))
    }
    return roots
  }

  private emptyCartridge(name: string, root: string, kind: CartridgeKind): CartridgeEntry {
    return { name, root, kind, folders: [], templateLocales: [], formLocales: [], files: 0, paths: new Set() }
  }

  /** The cartridge folder a path lies in: the nearest one up. */
  private rootOf(path: string): CartridgeEntry | null {
    let dir = dirname(path)
    while (true) {
      const found = this.roots.get(dir)
      if (found) return found
      if (dir === '') return null
      dir = dirname(dir)
    }
  }

  private classify(path: string): FileKind {
    const cartridge = this.rootOf(path)
    if (!cartridge) {
      if (isSiteArchivePath(path)) return 'site'
      if (isMetadataPath(path)) return 'metadata'
      return 'other'
    }
    const rel = path.slice(cartridge.root.length + 1)
    const ext = extname(rel)
    if (cartridge.kind === 'modules') return ext === '.js' || ext === '.ds' ? 'script' : 'other'
    if (rel === 'package.json') return 'package'
    if (!rel.startsWith('cartridge/')) return 'other'
    const inner = rel.slice('cartridge/'.length)
    if (/^(static|client)\//.test(inner)) return 'other'
    if (ext === '.js' || ext === '.ds') return /^controllers\/[^/]+$/.test(inner) ? 'controller' : 'script'
    if (/^templates\/resources\/[^/]+\.properties$/i.test(inner)) return 'properties'
    if (/^templates\/[^/]+\/.+\.isml$/i.test(inner) && !inner.startsWith('templates/resources/')) return 'template'
    return 'other'
  }

  /** Reads and scans the files given whose kind or time changed. */
  private async refresh(paths: readonly string[]): Promise<void> {
    await eachLimited(paths, this.concurrency, async (path) => {
      const kind = this.classify(path)
      if (kind === 'other') {
        this.records.delete(path)
        return
      }
      const time = await this.files.time(path)
      if (time === null) {
        this.drop(path)
        return
      }
      const known = this.records.get(path)
      if (known && known.kind === kind && known.time === time) return
      const text = await this.files.read(path)
      if (text === null) {
        this.drop(path)
        return
      }
      this.records.set(path, this.scan(kind, path, stripBom(text), time))
    })
  }

  private scan(kind: Exclude<FileKind, 'other'>, path: string, text: string, time: number): FileRecord {
    switch (kind) {
      case 'script':
      case 'controller':
        return { kind, time, facts: scanScript(text, { controller: kind === 'controller' }) }
      case 'template':
        return { kind, time, facts: scanTemplate(text) }
      case 'properties':
        return { kind, time, keys: parseProperties(text) }
      case 'site':
        return { kind, time, site: parseSiteArchive(text, path) }
      case 'metadata':
        return { kind, time, types: parseMetadata(text, path) }
      case 'package':
        return { kind, time, main: packageMain(text) }
    }
  }

  // ---- what is derived

  private async derive(paths: boolean): Promise<void> {
    // The ref is read at most once per change, and only when the paths are rebuilt: a file saved
    // never starts git.
    this.refRead = null
    this.refAllowed = paths
    this.routeTables.clear()
    this.countsCache = null
    this.deriveCartridges()
    this.deriveBundles()
    if (paths || this.storefrontList.length === 0) await this.derivePaths()
    else this.storefrontList = this.storefrontList.map((storefront) => ({ ...storefront, missing: storefront.cartridges.filter((name) => !this.byName.has(name)) }))
    await this.deriveMetadata()
  }

  private deriveCartridges(): void {
    for (const entry of this.roots.values()) {
      entry.paths = new Set()
      entry.files = 0
    }
    for (const path of this.paths) {
      const cartridge = this.rootOf(path)
      if (!cartridge) continue
      cartridge.paths.add(path.slice(cartridge.root.length + 1))
      cartridge.files++
    }
    const list = [...this.roots.values()].filter((entry) => entry.kind === 'modules' || entry.files > 0)
    for (const entry of list) {
      const folders = new Set<string>()
      const templates = new Set<string>()
      const forms = new Set<string>()
      for (const rel of entry.paths) {
        if (entry.kind === 'modules') continue
        const parts = rel.split('/')
        if (parts[0] !== 'cartridge' || parts.length < 3) continue
        const top = parts[1]
        if ((top === 'templates' || top === 'forms' || top === 'static') && parts.length >= 4) {
          folders.add(`${top}/${parts[2]}`)
          if (top === 'templates' && parts[2] !== 'resources') templates.add(parts[2])
          if (top === 'forms') forms.add(parts[2])
        } else {
          folders.add(top)
        }
      }
      entry.folders = [...folders].sort()
      entry.templateLocales = [...templates].sort()
      entry.formLocales = [...forms].sort()
    }
    list.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0))
    this.cartridgeList = list
    this.byName = new Map()
    const duplicates = new Set<string>()
    for (const entry of list) {
      if (this.byName.has(entry.name)) duplicates.add(entry.name)
      else this.byName.set(entry.name, entry)
    }
    this.duplicates = [...duplicates].sort()
  }

  private deriveBundles(): void {
    this.bundles = new Map()
    for (const [path, record] of this.records) {
      if (record.kind !== 'properties') continue
      const cartridge = this.rootOf(path)
      if (!cartridge || this.byName.get(cartridge.name) !== cartridge) continue
      const bundle = basename(path).replace(/\.properties$/i, '')
      let ofCartridge = this.bundles.get(cartridge.name)
      if (!ofCartridge) this.bundles.set(cartridge.name, (ofCartridge = new Map()))
      const keys = new Map<string, ResourceKey>()
      // A key written twice: the last one counts, as Java reads it.
      for (const key of record.keys) keys.set(key.key, { ...key, path, cartridge: cartridge.name, bundle })
      ofCartridge.set(bundle, keys)
    }
    this.keyIndex = new Map()
    for (const name of [...this.bundles.keys()].sort()) {
      for (const keys of (this.bundles.get(name) as Map<string, Map<string, ResourceKey>>).values()) {
        for (const definition of keys.values()) {
          const known = this.keyIndex.get(definition.key)
          if (known) known.push(definition)
          else this.keyIndex.set(definition.key, [definition])
        }
      }
    }
  }

  private checkoutArchives(): SiteArchive[] {
    const archives: SiteArchive[] = []
    for (const path of [...this.records.keys()].sort()) {
      const record = this.records.get(path) as FileRecord
      if (record.kind === 'site' && record.site) archives.push(record.site)
    }
    return archives
  }

  private checkoutMetadata(): ObjectTypeDefinition[] {
    const types: ObjectTypeDefinition[] = []
    for (const path of [...this.records.keys()].sort()) {
      const record = this.records.get(path) as FileRecord
      if (record.kind === 'metadata') types.push(...record.types)
    }
    return types
  }

  /** The ref's files, read once per rebuild of the paths; otherwise what was read last. */
  private readRefOnce(): Promise<GitCache | null> {
    if (!this.refAllowed) return Promise.resolve(this.gitCache)
    if (!this.refRead) this.refRead = this.readRef()
    return this.refRead
  }

  /** The ref's site archives and metadata, read again only when it names another commit. */
  private async readRef(): Promise<GitCache | null> {
    const ref = this.settings.metadataRef.trim()
    if (!ref || !this.git) return null
    try {
      const commit = await this.git.commit(ref)
      if (commit === null) throw new GitError('ref_not_found')
      if (this.gitCache && this.gitCache.ref === ref && this.gitCache.commit === commit) return this.gitCache
      const listed = await this.git.list(commit, '')
      const archives: SiteArchive[] = []
      const metadata: ObjectTypeDefinition[] = []
      const wanted = listed.filter((path) => !/(^|\/)cartridge\//.test(path) && (isSiteArchivePath(path) || isMetadataPath(path))).sort()
      for (const path of wanted) {
        const text = await this.git.read(commit, path)
        if (text === null) continue
        if (isSiteArchivePath(path)) {
          const site = parseSiteArchive(stripBom(text), path)
          if (site) archives.push(site)
        } else {
          metadata.push(...parseMetadata(stripBom(text), path))
        }
      }
      this.gitCache = { ref, commit, archives, metadata }
      this.gitError = null
      return this.gitCache
    } catch (error) {
      this.gitCache = null
      this.gitError = error instanceof GitError ? error.code : 'git_failed'
      return null
    }
  }

  private async derivePaths(): Promise<void> {
    if (!this.settings.metadataRef.trim()) {
      this.gitError = null
      this.gitCache = null
    }
    const setting = splitCartridgePath(this.settings.cartridgePath)
    const missing = (cartridges: string[]) => cartridges.filter((name) => !this.byName.has(name))
    if (setting.length > 0) {
      this.pathSource = 'setting'
      this.storefrontList = [{ id: SETTING_STOREFRONT, source: 'setting', cartridges: setting, missing: missing(setting), file: null, conflicts: 0 }]
      return
    }
    let archives = this.checkoutArchives()
    let source: PathSource = 'site-archive'
    if (archives.length === 0) {
      const fromRef = await this.readRefOnce()
      if (fromRef && fromRef.archives.length > 0) {
        archives = fromRef.archives
        source = 'git-ref'
      }
    }
    const bySite = new Map<string, Storefront>()
    for (const archive of archives) {
      const known = bySite.get(archive.siteId)
      if (known) {
        if (known.cartridges.join(':') !== archive.cartridges.join(':')) known.conflicts++
        continue
      }
      bySite.set(archive.siteId, { id: archive.siteId, source, cartridges: archive.cartridges, missing: missing(archive.cartridges), file: archive.path, conflicts: 0 })
    }
    this.storefrontList = [...bySite.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    this.pathSource = this.storefrontList.length > 0 ? source : 'none'
  }

  private async deriveMetadata(): Promise<void> {
    let types = this.checkoutMetadata()
    let source: MetadataSource = types.length > 0 ? 'checkout' : 'none'
    if (types.length === 0) {
      const fromRef = this.settings.metadataRef.trim() ? await this.readRefOnce() : null
      if (fromRef && fromRef.metadata.length > 0) {
        types = fromRef.metadata
        source = 'git-ref'
      }
    }
    const merged = new Map<string, ObjectType>()
    for (const type of types) {
      let known = merged.get(type.typeId)
      if (!known) merged.set(type.typeId, (known = { typeId: type.typeId, kind: type.kind, attributes: [] }))
      // An attribute defined in two files (two site import folders): the first, by path, is kept.
      for (const attribute of type.attributes) if (!known.attributes.some((a) => a.id === attribute.id)) known.attributes.push(attribute)
    }
    this.objectTypes = merged
    this.metadataSource = source
  }

  // ---- queries: cartridges and paths

  cartridges(): Cartridge[] {
    return this.cartridgeList.map(({ paths: _paths, ...cartridge }) => ({ ...cartridge, folders: [...cartridge.folders], templateLocales: [...cartridge.templateLocales], formLocales: [...cartridge.formLocales] }))
  }

  storefronts(): Storefront[] {
    return this.storefrontList.map((storefront) => ({ ...storefront, cartridges: [...storefront.cartridges], missing: [...storefront.missing] }))
  }

  /** The cartridge a file of the checkout belongs to. */
  cartridgeOf(path: string): Cartridge | null {
    const entry = this.rootOf(normalizePath(path) ?? '')
    if (!entry) return null
    return this.cartridges().find((cartridge) => cartridge.root === entry.root) ?? null
  }

  /** Every file the index holds, sorted. */
  filePaths(): string[] {
    return [...this.paths].sort()
  }

  /** What the index keeps of a script or template. */
  fileFacts(path: string): ScriptFileFacts | TemplateFileFacts | null {
    const record = this.records.get(normalizePath(path) ?? '')
    if (!record) return null
    return record.kind === 'script' || record.kind === 'controller' || record.kind === 'template' ? record.facts : null
  }

  /** The file a module path names inside a folder: as written, or with `.js`, `.ds`, `.json`, or its `index.js`. */
  private findIn(has: (path: string) => boolean, base: string): string | null {
    const candidates: string[] = []
    if (MODULE_EXTENSIONS.includes(extname(base))) candidates.push(base)
    for (const ext of MODULE_EXTENSIONS) candidates.push(base + ext)
    candidates.push(joinPath(base, 'index.js'), joinPath(base, 'index.ds'))
    for (const candidate of candidates) if (has(candidate)) return candidate
    return null
  }

  private findFile(base: string | null): string | null {
    if (base === null) return null
    return this.findIn((path) => this.paths.has(path), base)
  }

  /** The copy of `rel` (a path inside a cartridge) in the first cartridge of `cartridges` that has it, from `from` on. */
  private firstOnPath(cartridges: readonly string[], rel: string, from = 0, find = (entry: CartridgeEntry, r: string) => this.findIn((p) => entry.paths.has(p), r)): string | null {
    for (let i = from; i < cartridges.length; i++) {
      const entry = this.byName.get(cartridges[i])
      if (!entry || entry.kind !== 'cartridge') continue
      const found = find(entry, rel)
      if (found) return joinPath(entry.root, found)
    }
    return null
  }

  /** Where a `require` of `from` (a file of the checkout) leads. */
  resolveModule(from: string, module: string): ModuleResolution {
    const file = normalizePath(from) ?? ''
    if (module.startsWith('./') || module.startsWith('../')) {
      return { kind: 'file', module, form: 'relative', path: this.findFile(normalizePath(joinPath(dirname(file), module))) }
    }
    if (module.startsWith('~/')) {
      const cartridge = this.rootOf(file)
      return { kind: 'file', module, form: 'current', path: cartridge ? this.findFile(normalizePath(joinPath(cartridge.root, module.slice(2)))) : null }
    }
    if (module.startsWith('*/')) {
      const rel = normalizePath(module.slice(2)) ?? ''
      const copies = this.storefrontList.map((storefront) => ({ storefront: storefront.id, path: rel ? this.firstOnPath(storefront.cartridges, rel) : null }))
      const candidates: string[] = []
      if (rel) {
        for (const entry of this.cartridgeList) {
          if (entry.kind !== 'cartridge') continue
          const found = this.findIn((p) => entry.paths.has(p), rel)
          if (found) candidates.push(joinPath(entry.root, found))
        }
      }
      return { kind: 'path', module, form: 'path', copies, candidates }
    }
    if (module.startsWith('dw/')) return { kind: 'dw', module, form: 'dw', id: this.dw ? this.dw(module) : null }
    // `/<cartridge>/cartridge/x` is read as `<cartridge>/cartridge/x`.
    const plain = module.startsWith('/') && !module.startsWith('//') ? module.slice(1) : module
    const slash = plain.indexOf('/')
    const first = slash === -1 ? plain : plain.slice(0, slash)
    const named = this.byName.get(first)
    if (named && named.kind === 'cartridge' && slash !== -1) {
      return { kind: 'file', module, form: 'cartridge', path: this.findFile(normalizePath(joinPath(named.root, plain.slice(slash + 1)))) }
    }
    for (const entry of this.cartridgeList) {
      if (entry.kind !== 'modules') continue
      const found = this.findFile(normalizePath(joinPath(entry.root, module)))
      if (found) return { kind: 'file', module, form: 'modules', path: found }
    }
    // `require('<cartridge>')`: the main module its `package.json` names.
    if (named && named.kind === 'cartridge' && slash === -1) {
      const record = this.records.get(joinPath(named.root, 'package.json'))
      const main = record?.kind === 'package' && record.main !== null ? normalizePath(joinPath(named.root, record.main)) : null
      return { kind: 'file', module, form: 'main', path: main !== null && isUnder(main, named.root) ? this.findFile(main) : null }
    }
    return { kind: 'file', module, form: 'modules', path: null }
  }

  /** The copy `module.superModule` gives a file on each storefront: the next cartridge after its own that has the same path. */
  superModule(from: string): SuperModuleResolution {
    const file = normalizePath(from) ?? ''
    const cartridge = this.rootOf(file)
    if (!cartridge || cartridge.kind !== 'cartridge') return { module: null, copies: [] }
    const rel = file.slice(cartridge.root.length + 1)
    const ext = extname(rel)
    const base = MODULE_EXTENSIONS.includes(ext) ? rel.slice(0, -ext.length) : rel
    const copies = this.storefrontList.map((storefront) => {
      const at = storefront.cartridges.indexOf(cartridge.name)
      if (at === -1 || this.byName.get(cartridge.name) !== cartridge) return { storefront: storefront.id, path: null, onPath: false }
      return { storefront: storefront.id, path: this.firstOnPath(storefront.cartridges, base, at + 1), onPath: true }
    })
    return { module: rel, copies }
  }

  // ---- templates

  resolveTemplate(name: string, locale = 'default'): TemplateResolution {
    const plain = templateName(name)
    const fallbacks = localeFallbacks(locale)
    const fileOf = (entry: CartridgeEntry, folder: string) => {
      const rel = `cartridge/templates/${folder}/${plain}.isml`
      return entry.paths.has(rel) ? joinPath(entry.root, rel) : null
    }
    const copies: TemplateCopy[] = this.storefrontList.map((storefront) => {
      for (const folder of fallbacks) {
        for (const cartridgeName of storefront.cartridges) {
          const entry = this.byName.get(cartridgeName)
          if (!entry || entry.kind !== 'cartridge') continue
          const found = fileOf(entry, folder)
          if (found) return { storefront: storefront.id, path: found, locale: folder }
        }
      }
      return { storefront: storefront.id, path: null, locale: null }
    })
    const candidates: string[] = []
    if (plain) {
      for (const entry of this.cartridgeList) {
        if (entry.kind !== 'cartridge') continue
        for (const folder of entry.templateLocales) {
          const found = fileOf(entry, folder)
          if (found) candidates.push(found)
        }
      }
    }
    return { name: plain, locale: fallbacks[0], copies, candidates }
  }

  // ---- resource bundles

  /** `Resource.msg(key, bundle)` along each storefront's path; a null bundle is the default one, `locale`. */
  resolveResource(key: string, bundle: string | null, locale = 'default'): ResourceResolution {
    const name = bundle ?? 'locale'
    const fallbacks = localeFallbacks(locale).map((folder) => (folder === 'default' ? name : `${name}_${folder}`))
    const copies: ResourceCopy[] = this.storefrontList.map((storefront) => {
      for (const file of fallbacks) {
        for (const cartridgeName of storefront.cartridges) {
          const found = this.bundles.get(cartridgeName)?.get(file)?.get(key)
          if (found) return { storefront: storefront.id, key: found }
        }
      }
      return { storefront: storefront.id, key: null }
    })
    const candidates = (this.keyIndex.get(key) ?? []).filter((definition) => definition.bundle === name || definition.bundle.startsWith(name + '_'))
    return { key, bundle: name, locale: localeFallbacks(locale)[0], copies, candidates }
  }

  /** Every key of a bundle (all locales) in a cartridge, or in every cartridge. */
  resourceKeys(bundle: string, cartridge?: string): ResourceKey[] {
    const out: ResourceKey[] = []
    for (const [name, ofCartridge] of this.bundles) {
      if (cartridge !== undefined && name !== cartridge) continue
      for (const [file, keys] of ofCartridge) if (file === bundle || file.startsWith(bundle + '_')) out.push(...keys.values())
    }
    return out
  }

  // ---- metadata

  /** Every object type the metadata defines or extends, sorted by id. */
  types(): ObjectType[] {
    return [...this.objectTypes.values()].sort((a, b) => (a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0)).map((type) => ({ ...type, attributes: [...type.attributes] }))
  }

  /** The custom attributes of an object type (`Product`, `Order`, a custom object type). */
  attributes(typeId: string): AttributeDefinition[] {
    return [...(this.objectTypes.get(typeId)?.attributes ?? [])]
  }

  sitePreferences(): AttributeDefinition[] {
    return this.attributes(SITE_PREFERENCES)
  }

  // ---- routes

  private controllerRecord(path: string): ControllerFacts | null {
    const record = this.records.get(path)
    return record && record.kind === 'controller' ? record.facts.controller : null
  }

  /** The routes a controller file declares on a storefront, its bases applied first. */
  private routesOf(path: string, storefront: Storefront, depth: number, seen: Set<string>): Map<string, RouteChain> {
    const routes = new Map<string, RouteChain>()
    const facts = this.controllerRecord(path)
    const cartridge = this.rootOf(path)
    if (!facts || !cartridge || depth > MAX_CHAIN_DEPTH || seen.has(path)) return routes
    seen.add(path)
    const problems: RouteProblem[] = []
    let base: string | null = null
    if (facts.extends?.kind === 'superModule') {
      const at = storefront.cartridges.indexOf(cartridge.name)
      const rel = path.slice(cartridge.root.length + 1)
      base = at === -1 ? null : this.firstOnPath(storefront.cartridges, rel.replace(/\.(js|ds)$/i, ''), at + 1)
      if (!base) problems.push({ code: 'base_missing', path, start: 0, end: 0 })
    } else if (facts.extends?.kind === 'require') {
      const resolved = this.resolveModule(path, facts.extends.module)
      base = resolved.kind === 'file' ? resolved.path : resolved.kind === 'path' ? (resolved.copies.find((copy) => copy.storefront === storefront.id)?.path ?? null) : null
      if (!base) problems.push({ code: 'base_missing', path, start: 0, end: 0 })
    }
    if (base) {
      for (const [name, chain] of this.routesOf(base, storefront, depth + 1, seen)) {
        routes.set(name, { ...chain, steps: [...chain.steps], applied: [...chain.applied], problems: [...chain.problems] })
      }
    }
    for (const operation of facts.operations) {
      const step: RouteStep = { ...operation, path, cartridge: cartridge.name }
      let chain = routes.get(operation.name)
      if (DEFINING_METHODS.has(operation.method)) {
        if (chain && chain.steps.length > 0) chain.problems.push({ code: 'route_redefined', path, start: operation.start, end: operation.end })
        if (!chain) routes.set(operation.name, (chain = { storefront: storefront.id, controller: path, steps: [], applied: [], problems: [] }))
        chain.steps = [step]
      } else if (operation.method === 'replace') {
        if (!chain) routes.set(operation.name, (chain = { storefront: storefront.id, controller: path, steps: [], applied: [], problems: [] }))
        chain.steps = [step]
      } else {
        if (!chain || chain.steps.length === 0) {
          if (!chain) routes.set(operation.name, (chain = { storefront: storefront.id, controller: path, steps: [], applied: [], problems: [] }))
          chain.problems.push({ code: 'route_missing', path, start: operation.start, end: operation.end })
        } else if (operation.method === 'append') chain.steps.push(step)
        else chain.steps.unshift(step)
      }
      chain.applied.push(step)
    }
    for (const chain of routes.values()) {
      chain.controller = path
      if (problems.length) chain.problems.push(...problems)
      if (!facts.exported && !chain.problems.some((problem) => problem.code === 'not_exported' && problem.path === path)) {
        chain.problems.push({ code: 'not_exported', path, start: 0, end: 0 })
      }
    }
    return routes
  }

  /** Every controller served on a storefront, with its routes. */
  private routeTable(storefront: Storefront): Map<string, Map<string, RouteChain>> {
    const cached = this.routeTables.get(storefront.id)
    if (cached) return cached
    const table = new Map<string, Map<string, RouteChain>>()
    const names = new Set<string>()
    for (const cartridgeName of storefront.cartridges) {
      const entry = this.byName.get(cartridgeName)
      if (!entry || entry.kind !== 'cartridge') continue
      for (const rel of entry.paths) {
        const match = /^cartridge\/controllers\/([^/]+)\.(js|ds)$/i.exec(rel)
        if (match) names.add(match[1])
      }
    }
    for (const name of [...names].sort()) {
      const path = this.firstOnPath(storefront.cartridges, `cartridge/controllers/${name}`)
      if (path) table.set(name, this.routesOf(path, storefront, 0, new Set()))
    }
    this.routeTables.set(storefront.id, table)
    return table
  }

  /** Which declarations serve `Controller-Name` on each storefront, and in which order they run. */
  route(id: string): RouteResolution | null {
    const parts = splitRouteId(id)
    if (!parts) return null
    const storefronts = this.storefrontList.map((storefront) => {
      const chain = this.routeTable(storefront).get(parts.controller)?.get(parts.name)
      if (chain) return { ...chain, steps: [...chain.steps], applied: [...chain.applied], problems: [...chain.problems] }
      const controller = this.firstOnPath(storefront.cartridges, `cartridge/controllers/${parts.controller}`)
      return { storefront: storefront.id, controller, steps: [], applied: [], problems: [] }
    })
    return { controller: parts.controller, name: parts.name, storefronts }
  }

  /** Every `Controller-Name` served on a storefront, sorted. */
  routeIds(storefront: string): string[] {
    const found = this.storefrontList.find((s) => s.id === storefront)
    if (!found) return []
    const ids: string[] = []
    for (const [controller, routes] of this.routeTable(found)) for (const [name, chain] of routes) if (chain.steps.length > 0) ids.push(`${controller}-${name}`)
    return ids.sort()
  }

  // ---- status

  private unresolvedOn(path: string, copies: readonly { storefront: string; found: boolean }[], candidates: number): boolean {
    const cartridge = this.rootOf(path)
    const relevant = copies.filter((copy) => {
      const storefront = this.storefrontList.find((s) => s.id === copy.storefront)
      return !!storefront && !!cartridge && storefront.cartridges.includes(cartridge.name)
    })
    if (relevant.length === 0) return candidates === 0
    return relevant.some((copy) => !copy.found)
  }

  counts(): IndexCounts {
    if (this.countsCache) return this.countsCache
    const counts: IndexCounts = {
      files: this.paths.size,
      scripts: 0,
      controllers: 0,
      templates: 0,
      bundles: 0,
      resourceKeys: 0,
      objectTypes: this.objectTypes.size,
      attributes: 0,
      sitePreferences: this.sitePreferences().length,
      routes: 0,
      requires: 0,
      requiresResolved: 0,
      requiresUnresolved: 0,
      templateUses: 0,
      templateUsesUnresolved: 0,
      resourceUses: 0,
      resourceUsesUnresolved: 0
    }
    for (const type of this.objectTypes.values()) counts.attributes += type.attributes.length
    for (const ofCartridge of this.bundles.values()) {
      counts.bundles += ofCartridge.size
      for (const keys of ofCartridge.values()) counts.resourceKeys += keys.size
    }
    const templateCache = new Map<string, TemplateResolution>()
    for (const [path, record] of this.records) {
      if (record.kind !== 'script' && record.kind !== 'controller' && record.kind !== 'template') continue
      if (record.kind === 'template') counts.templates++
      else counts.scripts++
      if (record.kind === 'controller') {
        counts.controllers++
        counts.routes += record.facts.controller?.operations.length ?? 0
      }
      for (const use of record.facts.requires) {
        counts.requires++
        const resolved = this.resolveModule(path, use.module)
        let bad: boolean
        if (resolved.kind === 'dw') bad = resolved.id === null
        else if (resolved.kind === 'file') bad = resolved.path === null
        else bad = this.unresolvedOn(path, resolved.copies.map((copy) => ({ storefront: copy.storefront, found: copy.path !== null })), resolved.candidates.length)
        if (bad) counts.requiresUnresolved++
        else counts.requiresResolved++
      }
      for (const use of record.facts.templates) {
        counts.templateUses++
        const name = templateName(use.name)
        let resolved = templateCache.get(name)
        if (!resolved) templateCache.set(name, (resolved = this.resolveTemplate(name)))
        if (this.unresolvedOn(path, resolved.copies.map((copy) => ({ storefront: copy.storefront, found: copy.path !== null })), resolved.candidates.length)) counts.templateUsesUnresolved++
      }
      for (const use of record.facts.resources) {
        counts.resourceUses++
        const resolved = this.resolveResource(use.key, use.bundle)
        if (this.unresolvedOn(path, resolved.copies.map((copy) => ({ storefront: copy.storefront, found: copy.key !== null })), resolved.candidates.length)) counts.resourceUsesUnresolved++
      }
    }
    this.countsCache = counts
    return counts
  }

  status(): IndexStatus {
    return {
      cartridges: this.cartridgeList.map((entry) => ({ name: entry.name, kind: entry.kind, files: entry.files })),
      duplicates: [...this.duplicates],
      storefronts: this.storefronts(),
      pathSource: this.pathSource,
      metadataSource: this.metadataSource,
      gitError: this.gitError,
      counts: this.counts(),
      truncated: this.truncated,
      builtAt: this.builtAt,
      buildMs: this.buildMs,
      updatedAt: this.updatedAt,
      updateMs: this.updateMs
    }
  }
}

/** The `main` of a `package.json`, when it is a string; null for anything else or broken JSON. */
function packageMain(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown
    const main = parsed && typeof parsed === 'object' ? (parsed as { main?: unknown }).main : undefined
    return typeof main === 'string' && main.trim() ? main.trim() : null
  } catch {
    return null
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
