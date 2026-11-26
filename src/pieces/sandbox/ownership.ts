// Which workspace uploads, and how far it got. Exactly one workspace uploads, the one picked by
// hand; it never follows the focused workspace (nothing here reads or listens to focus).
//
//   none ──pick──▶ deploying ──deployed──▶ watching ⇄ uploading
//                     │                       │
//                     └──failed──▶ failed ◀───┘ (the watcher ended by itself)
//
// Picking deploys the whole workspace to its own code version and activates it, then keeps
// uploading its changes with `code watch`. Picking another workspace stops the first one's
// watcher and abandons its deploy. Releasing stops the watcher and leaves the version active.
//
// Every change of ownership (restore, pick, redeploy, release, removal, a deploy ending) runs
// through one queue, so none interleaves with another and there is never more than one watcher.
// Every wait inside a queued step is bounded (a host call by `HOST_TIMEOUT_MS`, a b2c call by its
// own timeout), so a step that hangs fails with a worded reason and the queue moves on. Release
// never waits: it stops the watcher at once and cancels the picks, redeploys and restore queued
// or running before it; only the storage it clears waits its turn. After `dispose()` no queued
// step starts, and a running one stops at its next wait: nothing is deployed or activated.
//
// A code version is deleted only when its workspace's `workspace.removed` event arrives, or when
// a person deletes a version left behind by hand: a workspace missing from a list is never taken
// as removed. The active version cannot be deleted, so it waits until another one is active.
//
// Whether each workspace's last full deploy ended is stored, always before the owner: a version
// whose deploy failed or was cut short by a restart is never reloaded, and after a restart it
// shows as needing a deploy instead of being watched.
import type { JsonValue } from 'orca'
import type { B2c, Running } from '../../core/b2c'
import type { Logger, Workspace, Workspaces } from '../../core/piece'
import type { Store } from '../../core/store'
import { isLocal, type ListedWorkspace } from '../../core/workspaces'
import { versionFor, type VersionNames } from './code-version'
import type { SandboxAction, SandboxStatus, UploadState } from './protocol'
import { codeOf, SandboxError, type Timers } from './status'
import { readWatchEvent } from './uploader'

/** A full deploy of a large checkout takes minutes. */
export const DEPLOY_TIMEOUT_MS = 30 * 60_000
/** The longest a host call (the workspace list, storage, settings) may hold a queued step. */
export const HOST_TIMEOUT_MS = 5_000
/** The longest `code list` may hold a queued step; also the runner's timeout for it. */
export const LIST_TIMEOUT_MS = 60_000
const RELOAD_TIMEOUT_MS = 5 * 60_000
const DELETE_TIMEOUT_MS = 2 * 60_000

/** What is kept in the piece's storage. */
const KEYS = { owner: 'owner', versions: 'versions', pending: 'pending', deploys: 'deploys', projects: 'projects' } as const

/** The workspace that uploads, as stored: its id, its version and its name when it was picked. */
export type Owner = { workspaceId: string; codeVersion: string; name: string }

/** A workspace's last full deploy: when one last ended well, and whether the last one did. */
export type DeployRecord = { at: number | null; complete: boolean }

/**
 * The workspace list; whether it is whole (`truncated` was not set); and the projects hidden from
 * the sidebar, whose workspaces it may leave out (null when Orca cannot say).
 */
export type Listing = { workspaces: (Workspace & { projectId?: string | null })[]; complete: boolean; hidden: string[] | null }

export type Notice = { kind: 'deployed'; workspace: string; codeVersion: string } | { kind: 'deployFailed'; workspace: string; code: string }

export type OwnershipDeps = {
  b2c: B2c
  store: Store
  /** Only `setUploading` is used: ownership never asks which workspace is focused. */
  workspaces: Pick<Workspaces, 'setUploading'>
  /** The list; `signal` is aborted when the step stops waiting for it. */
  listing(signal?: AbortSignal): Promise<Listing>
  timers: Timers
  /** The prefix of new code version names, from the setting. */
  prefix(): Promise<string>
  onChange(): void
  onProblem(action: SandboxAction, code: string | null): void
  onNotice?(notice: Notice): void
  log: Logger
}

/** What a queued step awaits through: the wait is bounded, and the step stops if cancelled. */
type Live = <V>(work: Promise<V> | ((signal: AbortSignal) => Promise<V>), limit?: { ms: number; code: string }) => Promise<V>

const HOST_LIMIT = { ms: HOST_TIMEOUT_MS, code: 'host_timeout' }
const LIST_LIMIT = { ms: HOST_TIMEOUT_MS, code: 'workspace_list_unavailable' }
const CODE_LIST_LIMIT = { ms: LIST_TIMEOUT_MS, code: 'b2c_timeout' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readOwner(value: unknown): Owner | null {
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || typeof value.codeVersion !== 'string') return null
  return { workspaceId: value.workspaceId, codeVersion: value.codeVersion, name: typeof value.name === 'string' ? value.name : value.codeVersion }
}

function readDeploys(value: unknown): Record<string, DeployRecord> {
  if (!isRecord(value)) return {}
  const deploys: Record<string, DeployRecord> = {}
  for (const [id, record] of Object.entries(value)) {
    if (isRecord(record)) deploys[id] = { at: typeof record.at === 'number' ? record.at : null, complete: record.complete === true }
  }
  return deploys
}

function readStrings(value: unknown): Record<string, string> {
  return isRecord(value) ? (Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Record<string, string>) : {}
}

/** The ids of a `code list` answer. */
function listedVersions(json: unknown): Record<string, unknown>[] {
  const data = isRecord(json) && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : []
  return data.filter(isRecord)
}

/**
 * Whether a whole list shows that a workspace is gone, so a person may delete its version: never
 * when the list is cut short, and never for a workspace whose project is hidden or may be (its
 * workspaces may be left out of the list).
 */
export function checkable(listing: Listing, projectId: string | null): boolean {
  if (!listing.complete || listing.hidden === null) return false
  if (projectId === null) return listing.hidden.length === 0
  return !listing.hidden.includes(projectId)
}

export class Ownership {
  private state: UploadState = 'none'
  private owner: Owner | null = null
  private reason: string | null = null
  private lastUploadAt: number | null = null
  private files = 0
  private reloading = false
  /** The watcher was started by a restore, with no deploy in this run. */
  private restored = false
  private versions: VersionNames = {}
  /** The project of each workspace with a version, when Orca named one. */
  private projects: Record<string, string> = {}
  private deploys: Record<string, DeployRecord> = {}
  private pending: string[] = []
  /** Raised by every pick, release and removal: work started before it is stale. */
  private generation = 0
  /** Raised by every release: a pick, redeploy or restore queued or running before it stops. */
  private epoch = 0
  private deploying: AbortController | null = null
  private watcher: Running | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private deleting: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: OwnershipDeps) {}

  /** Throws when a step must not go on: the piece was disposed, or a release cancelled it. */
  private ensureLive(epoch: number, cancelable: boolean): void {
    if (this.disposed) throw new SandboxError('disposed')
    if (cancelable && epoch !== this.epoch) throw new SandboxError('superseded')
  }

  /** `work` or `code` after `ms`, whichever comes first; the signal handed to `work` aborts then. */
  private bounded<V>(work: Promise<V> | ((signal: AbortSignal) => Promise<V>), limit: { ms: number; code: string }): Promise<V> {
    const controller = new AbortController()
    const promise = typeof work === 'function' ? work(controller.signal) : work
    return new Promise<V>((resolve, reject) => {
      const timer = this.deps.timers.setTimeout(() => {
        controller.abort()
        reject(new SandboxError(limit.code))
      }, limit.ms)
      promise.then(
        (value) => {
          this.deps.timers.clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          this.deps.timers.clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  /**
   * Runs `step` once every step queued before it has ended, unless the piece was disposed (or,
   * for a cancelable step, a release came) since it was queued. Every wait of the step goes
   * through `live`, which bounds it and stops the step at once if it may not go on.
   */
  private serial<T>(step: (live: Live) => Promise<T>, cancelable = false): Promise<T> {
    const epoch = this.epoch
    const live: Live = async (work, limit = HOST_LIMIT) => {
      const value = await this.bounded(work, limit)
      this.ensureLive(epoch, cancelable)
      return value
    }
    const run = this.queue.then(() => {
      this.ensureLive(epoch, cancelable)
      return step(live)
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  snapshot(): SandboxStatus['upload'] {
    const record = this.owner ? this.deploys[this.owner.workspaceId] : undefined
    return {
      state: this.state,
      workspaceId: this.owner?.workspaceId ?? null,
      workspaceName: this.owner?.name ?? null,
      codeVersion: this.owner?.codeVersion ?? null,
      reason: this.reason,
      lastDeployAt: record?.at ?? null,
      deployed: record?.complete === true,
      restored: this.restored,
      lastUploadAt: this.lastUploadAt,
      files: this.files,
      reloading: this.reloading
    }
  }

  current(): Owner | null {
    return this.owner
  }

  versionOf(workspaceId: string): string | null {
    return this.versions[workspaceId] ?? null
  }

  /** Every stored code version, by workspace id. */
  storedVersions(): VersionNames {
    return this.versions
  }

  /** The project a workspace with a version belonged to, when Orca named one. */
  projectOf(workspaceId: string): string | null {
    return this.projects[workspaceId] ?? null
  }

  pendingCount(): number {
    return this.pending.length
  }

  /**
   * Reads what storage holds and starts the owner's watcher again, with no redeploy. An owner
   * that cannot be found in the list stays stored and shows why; one whose last deploy did not
   * end shows that it needs one.
   */
  restore(): Promise<void> {
    return this.serial(async (live) => {
      const store = this.deps.store
      this.versions = readStrings(await live(store.get<JsonValue>(KEYS.versions, {})))
      this.projects = readStrings(await live(store.get<JsonValue>(KEYS.projects, {})))
      const pending = await live(store.get<JsonValue>(KEYS.pending, []))
      this.pending = Array.isArray(pending) ? pending.filter((v): v is string => typeof v === 'string') : []
      this.deploys = readDeploys(await live(store.get<JsonValue>(KEYS.deploys, {})))
      const owner = readOwner(await live(store.get<JsonValue>(KEYS.owner, null)))
      if (owner) {
        this.owner = owner
        await live(this.deps.workspaces.setUploading(owner.workspaceId, owner.codeVersion))
        let listing: Listing | null = null
        try {
          listing = await live((signal) => this.deps.listing(signal), LIST_LIMIT)
        } catch (error) {
          if (codeOf(error) === 'disposed' || codeOf(error) === 'superseded') throw error
          listing = null
        }
        const workspace = listing?.workspaces.find((w) => w.id === owner.workspaceId)
        if (!workspace) this.fail(listing?.complete ? 'workspace_not_found' : 'workspace_list_unavailable')
        else if (!isLocal(workspace)) this.fail('workspace_remote')
        else if (!this.deploys[owner.workspaceId]?.complete) this.fail('deploy_needed')
        else await this.watch(this.generation, workspace, owner.codeVersion, true)
      }
      this.deps.onChange()
      void this.deletePending()
    }, true)
  }

  /**
   * Makes `workspaceId` the workspace that uploads. Throws, with nothing changed, when it is not
   * listed, not on this machine, or its sandbox role cannot run b2c. Otherwise the previous
   * owner's watcher and deploy stop, and the deploy runs in the background.
   */
  pick(workspaceId: string): Promise<void> {
    return this.serial(async (live) => {
      const listing = await live((signal) => this.deps.listing(signal), LIST_LIMIT)
      const workspace = listing.workspaces.find((w) => w.id === workspaceId)
      if (!workspace) throw new SandboxError('workspace_unknown')
      if (!isLocal(workspace)) throw new SandboxError('workspace_remote')
      // dw.json is read from the uploading workspace: name it first, so the check reads its file,
      // and put the previous owner back if it cannot upload.
      const previous = this.owner
      const restorePrevious = () => this.deps.workspaces.setUploading(previous?.workspaceId ?? null, previous?.codeVersion ?? null)
      await live(this.deps.workspaces.setUploading(workspace.id, this.versions[workspace.id] ?? null))
      try {
        const { config, instances } = await live(this.deps.b2c.instances())
        if (config !== 'ok' || instances.sandbox !== 'ready') throw new SandboxError(config === 'ok' ? 'sandbox_not_ready' : `config_${config}`)
        let name = this.versions[workspace.id]
        if (!name) {
          // A new name never takes a version that is already on the sandbox: it may not be ours.
          const { json } = await live(this.deps.b2c.run(['code', 'list'], { role: 'sandbox', timeoutMs: LIST_TIMEOUT_MS }), CODE_LIST_LIMIT)
          const existing = listedVersions(json).flatMap((item) => (typeof item.id === 'string' ? [item.id] : []))
          const derived = versionFor(this.versions, workspace, await live(this.deps.prefix()), [...this.pending, ...existing])
          name = derived.name
          this.versions = derived.names
          await live(this.deps.store.set(KEYS.versions, { ...this.versions }))
        }
        const projectId = workspace.projectId ?? null
        if (projectId && this.projects[workspace.id] !== projectId) {
          this.projects = { ...this.projects, [workspace.id]: projectId }
          await live(this.deps.store.set(KEYS.projects, { ...this.projects }))
        }
        // The record first: a crash before the owner is written never leaves an owner whose
        // version looks deployed.
        await this.setDeploy(live, workspace.id, { at: this.deploys[workspace.id]?.at ?? null, complete: false })
        const generation = this.abandon()
        this.owner = { workspaceId: workspace.id, codeVersion: name, name: workspace.name }
        await live(this.deps.store.set(KEYS.owner, { ...this.owner }))
        await live(this.deps.workspaces.setUploading(workspace.id, name))
        this.deps.log(`picked a workspace; deploying to ${name}`)
        this.deploy(generation, workspace, name)
      } catch (error) {
        // Not picked: the uploading workspace is the previous owner again, unless a release or
        // a dispose took over.
        const code = codeOf(error)
        if (code !== 'disposed' && code !== 'superseded') {
          if (this.owner === previous) void restorePrevious().catch(() => undefined)
          // Past the takeover the old watcher is stopped: the new owner shows why it did not deploy.
          else this.fail(code)
        }
        throw error
      }
    }, true)
  }

  /** Deploys the owner again, whole, and activates its version. */
  redeploy(): Promise<void> {
    return this.serial(async (live) => {
      const owner = this.owner
      if (!owner) throw new SandboxError('no_owner')
      const listing = await live((signal) => this.deps.listing(signal), LIST_LIMIT)
      const workspace = listing.workspaces.find((w) => w.id === owner.workspaceId)
      if (!workspace) throw new SandboxError(listing.complete ? 'workspace_not_found' : 'workspace_list_unavailable')
      if (!isLocal(workspace)) throw new SandboxError('workspace_remote')
      await this.setDeploy(live, owner.workspaceId, { at: this.deploys[owner.workspaceId]?.at ?? null, complete: false })
      const generation = this.abandon()
      this.owner = { ...owner, name: workspace.name }
      await live(this.deps.store.set(KEYS.owner, { ...this.owner }))
      this.deploy(generation, workspace, owner.codeVersion)
    }, true)
  }

  /**
   * Stops uploading at once: the watcher and any deploy stop, and every pick, redeploy or restore
   * queued or running before it is cancelled. The version stays active on the sandbox. Only
   * clearing the stored owner waits its turn in the queue.
   */
  release(): Promise<void> {
    this.epoch++
    this.abandon()
    this.owner = null
    this.state = 'none'
    this.reason = null
    this.restored = false
    this.deps.onChange()
    return this.serial(async (live) => {
      await live(this.deps.store.delete(KEYS.owner))
      await live(this.deps.workspaces.setUploading(null))
    })
  }

  /**
   * Reloads the owner's code version, in the background. Refused unless its last full deploy
   * ended: reloading activates the version.
   */
  reload(): Promise<void> {
    return this.serial(async () => {
      const owner = this.owner
      if (!owner) throw new SandboxError('no_owner')
      if (this.reloading) throw new SandboxError('sandbox_busy')
      if (this.state === 'deploying') throw new SandboxError('upload_deploying')
      if (!this.deploys[owner.workspaceId]?.complete) throw new SandboxError('deploy_needed')
      this.reloading = true
      this.deps.onChange()
      void this.deps.b2c.run(['code', 'activate', owner.codeVersion, '--reload'], { role: 'sandbox', timeoutMs: RELOAD_TIMEOUT_MS }).then(
        () => {
          this.reloading = false
          this.deps.onProblem('reload', null)
          this.deps.onChange()
          void this.deletePending()
        },
        (error) => {
          this.reloading = false
          this.deps.onProblem('reload', codeOf(error))
          this.deps.onChange()
        }
      )
    })
  }

  /**
   * The `workspace.removed` event: the workspace's code version is deleted. The owner's version
   * is the active one, so ownership clears and the version waits until another one is active.
   */
  removed(workspaceId: string): Promise<void> {
    return this.serial((live) => this.forgetNow(live, workspaceId))
  }

  /**
   * Deletes, by a person's hand, the version of a workspace that a complete list no longer holds
   * (removed while the plugin was not listening). Refused for a workspace still listed, for the
   * owner, when the list is not whole, and when its project is hidden or may be.
   */
  forget(workspaceId: string): Promise<void> {
    return this.serial(async (live) => {
      if (!(workspaceId in this.versions)) throw new SandboxError('workspace_unknown')
      if (this.owner?.workspaceId === workspaceId) throw new SandboxError('workspace_uploads')
      const listing = await live((signal) => this.deps.listing(signal), LIST_LIMIT)
      if (!listing.complete) throw new SandboxError('workspace_list_unavailable')
      if (listing.workspaces.some((w) => w.id === workspaceId)) throw new SandboxError('workspace_listed')
      if (!checkable(listing, this.projectOf(workspaceId))) throw new SandboxError('workspace_hidden')
      await this.forgetNow(live, workspaceId)
    })
  }

  private async forgetNow(live: Live, workspaceId: string): Promise<void> {
    const version = this.versions[workspaceId] ?? (this.owner?.workspaceId === workspaceId ? this.owner.codeVersion : null)
    if (this.owner?.workspaceId === workspaceId) {
      this.abandon()
      this.owner = null
      this.state = 'none'
      this.reason = null
      this.restored = false
      await live(this.deps.store.delete(KEYS.owner))
      await live(this.deps.workspaces.setUploading(null))
    }
    // The version is queued first, so a step stopped halfway never forgets a version undeleted.
    if (version && !this.pending.includes(version)) {
      this.pending = [...this.pending, version]
      await live(this.deps.store.set(KEYS.pending, [...this.pending]))
    }
    for (const key of ['versions', 'deploys', 'projects'] as const) {
      const map = this[key] as Record<string, unknown>
      if (!(workspaceId in map)) continue
      const { [workspaceId]: _gone, ...rest } = map
      ;(this as unknown as Record<string, unknown>)[key] = rest
      await live(this.deps.store.set(KEYS[key], { ...rest } as JsonValue))
    }
    this.deps.onChange()
    void this.deletePending()
  }

  /**
   * Deletes every queued version that is not active; one that is no longer listed is forgotten.
   * One pass at a time; a failure leaves the version queued for the next activation.
   */
  deletePending(): Promise<void> {
    this.deleting = this.deleting.then(() => this.deleteNow()).catch(() => undefined)
    return this.deleting
  }

  private async deleteNow(): Promise<void> {
    if (this.pending.length === 0 || this.disposed) return
    let listed: Record<string, unknown>[]
    try {
      const { json } = await this.bounded(this.deps.b2c.run(['code', 'list'], { role: 'sandbox', timeoutMs: LIST_TIMEOUT_MS }), CODE_LIST_LIMIT)
      listed = listedVersions(json)
    } catch (error) {
      this.deps.onProblem('delete', codeOf(error))
      return
    }
    let failure: string | null = null
    for (const version of [...this.pending]) {
      if (this.disposed) return
      const entry = listed.find((item) => item.id === version)
      if (entry?.active === true) continue
      if (entry) {
        try {
          await this.bounded(this.deps.b2c.run(['code', 'delete', version, '--force'], { role: 'sandbox', timeoutMs: DELETE_TIMEOUT_MS }), {
            ms: DELETE_TIMEOUT_MS,
            code: 'b2c_timeout'
          })
          this.deps.log(`deleted the code version ${version}`)
        } catch (error) {
          failure = codeOf(error)
          continue
        }
      }
      this.pending = this.pending.filter((item) => item !== version)
    }
    await this.bounded(this.deps.store.set(KEYS.pending, [...this.pending]), HOST_LIMIT).catch(() => undefined)
    this.deps.onProblem('delete', failure)
    this.deps.onChange()
  }

  /** Stops the watcher and abandons a running deploy; returns the new generation. */
  private abandon(): number {
    this.generation++
    this.deploying?.abort()
    this.deploying = null
    const watcher = this.watcher
    this.watcher = null
    watcher?.stop()
    return this.generation
  }

  private fail(code: string): void {
    this.state = 'failed'
    this.reason = code
    this.deps.onChange()
  }

  private async setDeploy(live: Live, workspaceId: string, record: DeployRecord): Promise<void> {
    this.deploys = { ...this.deploys, [workspaceId]: record }
    await live(this.deps.store.set(KEYS.deploys, { ...this.deploys }))
  }

  /**
   * Starts the deploy; it runs outside the queue, and what follows its end is queued. The record
   * already says the version is not deployed, so a restart meanwhile never watches it. Called only
   * by a step that is live, with no wait in between: nothing is deployed after a dispose.
   */
  private deploy(generation: number, workspace: Workspace | ListedWorkspace, codeVersion: string): void {
    if (this.disposed) return
    const controller = new AbortController()
    this.deploying = controller
    this.state = 'deploying'
    this.reason = null
    this.restored = false
    this.deps.onChange()
    void this.deps.b2c
      .run(['code', 'deploy', '--code-version', codeVersion, '--activate'], {
        role: 'sandbox',
        cwd: workspace.path,
        signal: controller.signal,
        timeoutMs: DEPLOY_TIMEOUT_MS
      })
      .then(
        () =>
          this.serial(async (live) => {
            if (generation !== this.generation) return
            this.deploying = null
            await this.setDeploy(live, workspace.id, { at: this.deps.timers.now(), complete: true })
            this.deps.onNotice?.({ kind: 'deployed', workspace: workspace.name, codeVersion })
            // Another version is active now: a queued one may be deleted.
            void this.deletePending()
            if (generation === this.generation) await this.watch(generation, workspace, codeVersion, false)
          }),
        (error) =>
          this.serial(async () => {
            if (generation !== this.generation) return
            this.deploying = null
            const code = codeOf(error)
            this.deps.log(`deploy failed: ${code}`)
            this.deps.onNotice?.({ kind: 'deployFailed', workspace: workspace.name, code })
            this.fail(code)
          })
      )
      .catch(() => undefined)
  }

  private async watch(generation: number, workspace: Workspace, codeVersion: string, restored: boolean): Promise<void> {
    let running: Running
    // Bounded like every wait; a watcher that starts after the bound is stopped at once.
    let starting: Promise<Running> | null = null
    try {
      running = await this.bounded(
        (starting = this.deps.b2c.start(['code', 'watch', '--code-version', codeVersion], {
          role: 'sandbox',
          cwd: workspace.path,
          jsonl: true,
          onEvent: (event) => {
            if (this.watcher !== running) return
            const signal = readWatchEvent(event)
            if (!signal) return
            if (signal.kind === 'changed') {
              if (this.state === 'watching') {
                this.state = 'uploading'
                this.deps.onChange()
              }
            } else if (signal.kind === 'uploaded') {
              this.files += signal.files
              this.lastUploadAt = this.deps.timers.now()
              this.state = 'watching'
              this.deps.onProblem('upload', null)
              this.deps.onChange()
            } else {
              this.state = 'watching'
              this.deps.onProblem('upload', 'upload_failed')
              this.deps.onChange()
            }
          }
        })),
        HOST_LIMIT
      )
    } catch (error) {
      void starting?.then(
        (late) => late.stop(),
        () => undefined
      )
      if (generation === this.generation) this.fail(codeOf(error))
      return
    }
    if (generation !== this.generation || this.disposed) {
      running.stop()
      return
    }
    this.watcher = running
    this.files = 0
    this.state = 'watching'
    this.reason = null
    this.restored = restored
    this.deps.onChange()
    void running.exited.then((exit) => {
      if (this.watcher !== running) return
      this.watcher = null
      if (exit.stopped) return
      this.fail(exit.reason ?? 'watch_ended')
    })
  }

  /** How many watchers this holds: never more than one. For tests. */
  watching(): number {
    return this.watcher ? 1 : 0
  }

  dispose(): void {
    this.disposed = true
    this.abandon()
  }
}
