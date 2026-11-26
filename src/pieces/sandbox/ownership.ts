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
//
// A code version is deleted only when its workspace's `workspace.removed` event arrives, or when
// a person deletes a version left behind by hand: a workspace missing from a list is never taken
// as removed. The active version cannot be deleted, so it waits until another one is active.
//
// Whether each workspace's last full deploy ended is stored: a version whose deploy failed or was
// cut short by a restart is never reloaded, and after a restart it shows as needing a deploy
// instead of being watched.
import type { JsonValue } from 'orca'
import type { B2c, Running } from '../../core/b2c'
import type { Logger, Workspace, Workspaces } from '../../core/piece'
import type { Store } from '../../core/store'
import { isLocal } from '../../core/workspaces'
import { versionFor, type VersionNames } from './code-version'
import type { SandboxAction, SandboxStatus, UploadState } from './protocol'
import { codeOf, SandboxError, type Timers } from './status'
import { readWatchEvent } from './uploader'

/** A full deploy of a large checkout takes minutes. */
export const DEPLOY_TIMEOUT_MS = 30 * 60_000
const RELOAD_TIMEOUT_MS = 5 * 60_000
const LIST_TIMEOUT_MS = 60_000
const DELETE_TIMEOUT_MS = 2 * 60_000

/** What is kept in the piece's storage. */
const KEYS = { owner: 'owner', versions: 'versions', pending: 'pending', deploys: 'deploys' } as const

/** The workspace that uploads, as stored: its id, its version and its name when it was picked. */
export type Owner = { workspaceId: string; codeVersion: string; name: string }

/** A workspace's last full deploy: when one last ended well, and whether the last one did. */
export type DeployRecord = { at: number | null; complete: boolean }

/** The workspace list, and whether it is whole (`truncated` was not set). */
export type Listing = { workspaces: Workspace[]; complete: boolean }

export type Notice = { kind: 'deployed'; workspace: string; codeVersion: string } | { kind: 'deployFailed'; workspace: string; code: string }

export type OwnershipDeps = {
  b2c: B2c
  store: Store
  /** Only `setUploading` is used: ownership never asks which workspace is focused. */
  workspaces: Pick<Workspaces, 'setUploading'>
  listing(): Promise<Listing>
  timers: Timers
  /** The prefix of new code version names, from the setting. */
  prefix(): Promise<string>
  onChange(): void
  onProblem(action: SandboxAction, code: string | null): void
  onNotice?(notice: Notice): void
  log: Logger
}

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

/** The ids of a `code list` answer. */
function listedVersions(json: unknown): Record<string, unknown>[] {
  const data = isRecord(json) && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : []
  return data.filter(isRecord)
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
  private deploys: Record<string, DeployRecord> = {}
  private pending: string[] = []
  /** Raised by every pick, release and removal: work started before it is stale. */
  private generation = 0
  private deploying: AbortController | null = null
  private watcher: Running | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private deleting: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: OwnershipDeps) {}

  /** Runs `step` once every change queued before it has ended, whether it worked or not. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step, step)
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

  pendingCount(): number {
    return this.pending.length
  }

  /**
   * Reads what storage holds and starts the owner's watcher again, with no redeploy. An owner
   * that cannot be found in the list stays stored and shows why; one whose last deploy did not
   * end shows that it needs one.
   */
  restore(): Promise<void> {
    return this.serial(async () => {
      const store = this.deps.store
      const versions = await store.get<JsonValue>(KEYS.versions, {})
      this.versions = isRecord(versions) ? (Object.fromEntries(Object.entries(versions).filter(([, v]) => typeof v === 'string')) as VersionNames) : {}
      const pending = await store.get<JsonValue>(KEYS.pending, [])
      this.pending = Array.isArray(pending) ? pending.filter((v): v is string => typeof v === 'string') : []
      this.deploys = readDeploys(await store.get<JsonValue>(KEYS.deploys, {}))
      const owner = readOwner(await store.get<JsonValue>(KEYS.owner, null))
      if (owner) {
        this.owner = owner
        await this.deps.workspaces.setUploading(owner.workspaceId, owner.codeVersion)
        let listing: Listing | null = null
        try {
          listing = await this.deps.listing()
        } catch {
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
    })
  }

  /**
   * Makes `workspaceId` the workspace that uploads. Throws, with nothing changed, when it is not
   * listed, not on this machine, or its sandbox role cannot run b2c. Otherwise the previous
   * owner's watcher and deploy stop, and the deploy runs in the background.
   */
  pick(workspaceId: string): Promise<void> {
    return this.serial(async () => {
      const workspace = (await this.deps.listing()).workspaces.find((w) => w.id === workspaceId)
      if (!workspace) throw new SandboxError('workspace_unknown')
      if (!isLocal(workspace)) throw new SandboxError('workspace_remote')
      // dw.json is read from the uploading workspace: name it first, so the check reads its file,
      // and put the previous owner back if it cannot upload.
      const previous = this.owner
      const restorePrevious = () => this.deps.workspaces.setUploading(previous?.workspaceId ?? null, previous?.codeVersion ?? null)
      await this.deps.workspaces.setUploading(workspace.id, this.versions[workspace.id] ?? null)
      const { config, instances } = await this.deps.b2c.instances()
      if (config !== 'ok' || instances.sandbox !== 'ready') {
        await restorePrevious()
        throw new SandboxError(config === 'ok' ? 'sandbox_not_ready' : `config_${config}`)
      }
      let name = this.versions[workspace.id]
      if (!name) {
        // A new name never takes a version that is already on the sandbox: it may not be ours.
        let existing: string[]
        try {
          const { json } = await this.deps.b2c.run(['code', 'list'], { role: 'sandbox', timeoutMs: LIST_TIMEOUT_MS })
          existing = listedVersions(json).flatMap((item) => (typeof item.id === 'string' ? [item.id] : []))
        } catch (error) {
          await restorePrevious()
          throw error
        }
        const derived = versionFor(this.versions, workspace, await this.deps.prefix(), [...this.pending, ...existing])
        name = derived.name
        this.versions = derived.names
        await this.deps.store.set(KEYS.versions, { ...this.versions })
      }
      const generation = this.abandon()
      this.owner = { workspaceId: workspace.id, codeVersion: name, name: workspace.name }
      await this.deps.store.set(KEYS.owner, { ...this.owner })
      await this.deps.workspaces.setUploading(workspace.id, name)
      this.deps.log(`picked a workspace; deploying to ${name}`)
      await this.deploy(generation, workspace, name)
    })
  }

  /** Deploys the owner again, whole, and activates its version. */
  redeploy(): Promise<void> {
    return this.serial(async () => {
      const owner = this.owner
      if (!owner) throw new SandboxError('no_owner')
      const listing = await this.deps.listing()
      const workspace = listing.workspaces.find((w) => w.id === owner.workspaceId)
      if (!workspace) throw new SandboxError(listing.complete ? 'workspace_not_found' : 'workspace_list_unavailable')
      if (!isLocal(workspace)) throw new SandboxError('workspace_remote')
      this.owner = { ...owner, name: workspace.name }
      await this.deps.store.set(KEYS.owner, { ...this.owner })
      await this.deploy(this.abandon(), workspace, owner.codeVersion)
    })
  }

  /** Stops uploading. The version stays active on the sandbox. */
  release(): Promise<void> {
    return this.serial(async () => {
      this.abandon()
      this.owner = null
      this.state = 'none'
      this.reason = null
      this.restored = false
      await this.deps.store.delete(KEYS.owner)
      await this.deps.workspaces.setUploading(null)
      this.deps.onChange()
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
    return this.serial(() => this.forgetNow(workspaceId))
  }

  /**
   * Deletes, by a person's hand, the version of a workspace that a complete list no longer holds
   * (removed while the plugin was not listening). Refused for a workspace still listed, for the
   * owner, and when the list is not whole.
   */
  forget(workspaceId: string): Promise<void> {
    return this.serial(async () => {
      if (!(workspaceId in this.versions)) throw new SandboxError('workspace_unknown')
      if (this.owner?.workspaceId === workspaceId) throw new SandboxError('workspace_uploads')
      const listing = await this.deps.listing()
      if (!listing.complete) throw new SandboxError('workspace_list_unavailable')
      if (listing.workspaces.some((w) => w.id === workspaceId)) throw new SandboxError('workspace_listed')
      await this.forgetNow(workspaceId)
    })
  }

  private async forgetNow(workspaceId: string): Promise<void> {
    const version = this.versions[workspaceId] ?? (this.owner?.workspaceId === workspaceId ? this.owner.codeVersion : null)
    if (this.owner?.workspaceId === workspaceId) {
      this.abandon()
      this.owner = null
      this.state = 'none'
      this.reason = null
      this.restored = false
      await this.deps.store.delete(KEYS.owner)
      await this.deps.workspaces.setUploading(null)
    }
    if (workspaceId in this.versions) {
      const { [workspaceId]: _gone, ...rest } = this.versions
      this.versions = rest
      await this.deps.store.set(KEYS.versions, { ...rest })
    }
    if (workspaceId in this.deploys) {
      const { [workspaceId]: _gone, ...rest } = this.deploys
      this.deploys = rest
      await this.deps.store.set(KEYS.deploys, { ...rest })
    }
    if (version && !this.pending.includes(version)) {
      this.pending = [...this.pending, version]
      await this.deps.store.set(KEYS.pending, [...this.pending])
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
      const { json } = await this.deps.b2c.run(['code', 'list'], { role: 'sandbox', timeoutMs: LIST_TIMEOUT_MS })
      listed = listedVersions(json)
    } catch (error) {
      this.deps.onProblem('delete', codeOf(error))
      return
    }
    let failure: string | null = null
    for (const version of [...this.pending]) {
      const entry = listed.find((item) => item.id === version)
      if (entry?.active === true) continue
      if (entry) {
        try {
          await this.deps.b2c.run(['code', 'delete', version, '--force'], { role: 'sandbox', timeoutMs: DELETE_TIMEOUT_MS })
          this.deps.log(`deleted the code version ${version}`)
        } catch (error) {
          failure = codeOf(error)
          continue
        }
      }
      this.pending = this.pending.filter((item) => item !== version)
    }
    await this.deps.store.set(KEYS.pending, [...this.pending])
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

  private async setDeploy(workspaceId: string, record: DeployRecord): Promise<void> {
    this.deploys = { ...this.deploys, [workspaceId]: record }
    await this.deps.store.set(KEYS.deploys, { ...this.deploys })
  }

  /**
   * Starts the deploy; it runs outside the queue, and what follows its end is queued. The record
   * says the version is not deployed until it ends well, so a restart meanwhile never watches it.
   */
  private async deploy(generation: number, workspace: Workspace, codeVersion: string): Promise<void> {
    await this.setDeploy(workspace.id, { at: this.deploys[workspace.id]?.at ?? null, complete: false })
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
          this.serial(async () => {
            if (generation !== this.generation || this.disposed) return
            this.deploying = null
            await this.setDeploy(workspace.id, { at: this.deps.timers.now(), complete: true })
            this.deps.onNotice?.({ kind: 'deployed', workspace: workspace.name, codeVersion })
            // Another version is active now: a queued one may be deleted.
            void this.deletePending()
            await this.watch(generation, workspace, codeVersion, false)
          }),
        (error) =>
          this.serial(async () => {
            if (generation !== this.generation || this.disposed) return
            this.deploying = null
            const code = codeOf(error)
            this.deps.log(`deploy failed: ${code}`)
            this.deps.onNotice?.({ kind: 'deployFailed', workspace: workspace.name, code })
            this.fail(code)
          })
      )
  }

  private async watch(generation: number, workspace: Workspace, codeVersion: string, restored: boolean): Promise<void> {
    let running: Running
    try {
      running = await this.deps.b2c.start(['code', 'watch', '--code-version', codeVersion], {
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
      })
    } catch (error) {
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
