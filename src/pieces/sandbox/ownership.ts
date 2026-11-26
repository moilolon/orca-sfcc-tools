// Which workspace uploads, and how far it got. Exactly one workspace uploads, the one picked by
// hand; it never follows the focused workspace (nothing here listens to focus).
//
//   none ──pick──▶ deploying ──deployed──▶ watching ⇄ uploading
//                     │                       │
//                     └──failed──▶ failed ◀───┘ (the watcher ended by itself)
//
// Picking deploys the whole workspace to its own code version and activates it, then keeps
// uploading its changes with `code watch`. Picking another workspace stops the first one's
// watcher and abandons its deploy. Releasing stops the watcher and leaves the version active.
// Removing a workspace deletes its code version; the active one cannot be, so it waits in a queue
// until another version is active. After a worker restart the owner's watcher is started again
// from storage, with no redeploy.
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
const KEYS = { owner: 'owner', versions: 'versions', pending: 'pending', lastDeployAt: 'lastDeployAt' } as const

export type Owner = { workspaceId: string; codeVersion: string }

export type Notice = { kind: 'deployed'; workspace: string; codeVersion: string } | { kind: 'deployFailed'; workspace: string; code: string }

export type OwnershipDeps = {
  b2c: B2c
  store: Store
  workspaces: Workspaces
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

function isOwner(value: unknown): value is Owner {
  return isRecord(value) && typeof value.workspaceId === 'string' && typeof value.codeVersion === 'string'
}

export class Ownership {
  private state: UploadState = 'none'
  private owner: Owner | null = null
  private ownerName: string | null = null
  private reason: string | null = null
  private lastDeployAt: number | null = null
  private lastUploadAt: number | null = null
  private files = 0
  private reloading = false
  private versions: VersionNames = {}
  private pending: string[] = []
  /** Raised by every pick, release and removal: work started before it is stale. */
  private generation = 0
  private deploying: AbortController | null = null
  private watcher: Running | null = null
  private deleting: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: OwnershipDeps) {}

  snapshot(): SandboxStatus['upload'] {
    return {
      state: this.state,
      workspaceId: this.owner?.workspaceId ?? null,
      workspaceName: this.ownerName,
      codeVersion: this.owner?.codeVersion ?? null,
      reason: this.reason,
      lastDeployAt: this.lastDeployAt,
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

  pendingCount(): number {
    return this.pending.length
  }

  /**
   * Reads what storage holds and starts the owner's watcher again, with no redeploy. An owner
   * whose workspace is gone counts as removed.
   */
  async restore(): Promise<void> {
    const store = this.deps.store
    const owner = await store.get<JsonValue>(KEYS.owner, null)
    const versions = await store.get<JsonValue>(KEYS.versions, {})
    const pending = await store.get<JsonValue>(KEYS.pending, [])
    const lastDeployAt = await store.get<JsonValue>(KEYS.lastDeployAt, null)
    this.versions = isRecord(versions) ? (Object.fromEntries(Object.entries(versions).filter(([, v]) => typeof v === 'string')) as VersionNames) : {}
    this.pending = Array.isArray(pending) ? pending.filter((v): v is string => typeof v === 'string') : []
    this.lastDeployAt = typeof lastDeployAt === 'number' ? lastDeployAt : null
    if (isOwner(owner)) {
      const workspace = (await this.deps.workspaces.list()).find((w) => w.id === owner.workspaceId)
      if (!workspace) {
        this.owner = owner
        await this.removed(owner.workspaceId)
        return
      }
      this.owner = owner
      this.ownerName = workspace.name
      await this.deps.workspaces.setUploading(owner.workspaceId, owner.codeVersion)
      if (!isLocal(workspace)) this.fail('workspace_remote')
      else await this.watch(this.generation, workspace, owner.codeVersion)
    }
    this.deps.onChange()
    void this.deletePending()
  }

  /**
   * Makes `workspaceId` the workspace that uploads. Throws, with nothing changed, when it is not
   * listed, not on this machine, or its sandbox role cannot run b2c. Otherwise the previous
   * owner's watcher and deploy stop, and the deploy runs in the background.
   */
  async pick(workspaceId: string): Promise<void> {
    const workspace = (await this.deps.workspaces.list()).find((w) => w.id === workspaceId)
    if (!workspace) throw new SandboxError('workspace_unknown')
    if (!isLocal(workspace)) throw new SandboxError('workspace_remote')
    const { name, names } = versionFor(this.versions, workspace, await this.deps.prefix(), this.pending)
    // dw.json is read from the uploading workspace: name it first, so the check reads its file,
    // and put the previous owner back if it cannot upload.
    const previous = this.owner
    await this.deps.workspaces.setUploading(workspace.id, name)
    const { config, instances } = await this.deps.b2c.instances()
    if (config !== 'ok' || instances.sandbox !== 'ready') {
      await this.deps.workspaces.setUploading(previous?.workspaceId ?? null, previous?.codeVersion ?? null)
      throw new SandboxError(config === 'ok' ? 'sandbox_not_ready' : `config_${config}`)
    }
    const generation = this.abandon()
    if (names !== this.versions) {
      this.versions = names
      await this.deps.store.set(KEYS.versions, { ...names })
    }
    this.owner = { workspaceId: workspace.id, codeVersion: name }
    this.ownerName = workspace.name
    await this.deps.store.set(KEYS.owner, { ...this.owner })
    this.deps.log(`picked a workspace; deploying to ${name}`)
    this.deploy(generation, workspace, name)
  }

  /** Deploys the owner again, whole, and activates its version. */
  async redeploy(): Promise<void> {
    const owner = this.owner
    if (!owner) throw new SandboxError('no_owner')
    const workspace = (await this.deps.workspaces.list()).find((w) => w.id === owner.workspaceId)
    if (!workspace) throw new SandboxError('workspace_unknown')
    if (!isLocal(workspace)) throw new SandboxError('workspace_remote')
    this.ownerName = workspace.name
    this.deploy(this.abandon(), workspace, owner.codeVersion)
  }

  /** Stops uploading. The version stays active on the sandbox. */
  async release(): Promise<void> {
    this.abandon()
    this.owner = null
    this.ownerName = null
    this.state = 'none'
    this.reason = null
    await this.deps.store.delete(KEYS.owner)
    await this.deps.workspaces.setUploading(null)
    this.deps.onChange()
  }

  /** Reloads the owner's code version, in the background. */
  async reload(): Promise<void> {
    const owner = this.owner
    if (!owner) throw new SandboxError('no_owner')
    if (this.reloading) throw new SandboxError('sandbox_busy')
    if (this.state === 'deploying') throw new SandboxError('upload_deploying')
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
  }

  /**
   * A workspace was removed: its code version is deleted. The owner's version is the active one,
   * so ownership clears and the version waits until another version is active.
   */
  async removed(workspaceId: string): Promise<void> {
    const version = this.versions[workspaceId] ?? (this.owner?.workspaceId === workspaceId ? this.owner.codeVersion : null)
    if (this.owner?.workspaceId === workspaceId) {
      this.abandon()
      this.owner = null
      this.ownerName = null
      this.state = 'none'
      this.reason = null
      await this.deps.store.delete(KEYS.owner)
      await this.deps.workspaces.setUploading(null)
    }
    if (workspaceId in this.versions) {
      const { [workspaceId]: _gone, ...rest } = this.versions
      this.versions = rest
      await this.deps.store.set(KEYS.versions, { ...rest })
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
      const data = isRecord(json) && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : []
      listed = data.filter(isRecord)
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

  private deploy(generation: number, workspace: Workspace, codeVersion: string): void {
    const controller = new AbortController()
    this.deploying = controller
    this.state = 'deploying'
    this.reason = null
    this.deps.onChange()
    void this.deps.b2c
      .run(['code', 'deploy', '--code-version', codeVersion, '--activate'], {
        role: 'sandbox',
        cwd: workspace.path,
        signal: controller.signal,
        timeoutMs: DEPLOY_TIMEOUT_MS
      })
      .then(
        async () => {
          if (generation !== this.generation) return
          this.deploying = null
          this.lastDeployAt = this.deps.timers.now()
          await this.deps.store.set(KEYS.lastDeployAt, this.lastDeployAt)
          this.deps.onNotice?.({ kind: 'deployed', workspace: workspace.name, codeVersion })
          // Another version is active now: a queued one may be deleted.
          void this.deletePending()
          await this.watch(generation, workspace, codeVersion)
        },
        (error) => {
          if (generation !== this.generation) return
          this.deploying = null
          const code = codeOf(error)
          this.deps.log(`deploy failed: ${code}`)
          this.deps.onNotice?.({ kind: 'deployFailed', workspace: workspace.name, code })
          this.fail(code)
        }
      )
  }

  private async watch(generation: number, workspace: Workspace, codeVersion: string): Promise<void> {
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
    this.deps.onChange()
    void running.exited.then((exit) => {
      if (this.watcher !== running) return
      this.watcher = null
      if (exit.stopped) return
      this.fail(exit.reason ?? 'watch_ended')
    })
  }

  dispose(): void {
    this.disposed = true
    this.abandon()
  }
}
