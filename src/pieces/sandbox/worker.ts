// The sandbox piece's worker half, listed in src/worker/pieces.ts: the workspace that uploads
// (ownership.ts), the state of the sandbox (status.ts), the requests of its view, its palette
// commands, the `workspace.removed` event and two status bar items. Only the sandbox role is ever
// used, and only once dw.json makes it `ready`: otherwise every command answers why, and runs
// nothing.
import type { Disposable, PieceContext, WorkerPiece } from '../../core/piece'
import { hiddenProjects, isLocal, listWorkspaces } from '../../core/workspaces'
import { DEFAULT_PREFIX, prefixOf } from './code-version'
import { messages } from './i18n'
import { checkable, HOST_TIMEOUT_MS, Ownership, type Listing, type Notice } from './ownership'
import type { SandboxAction, SandboxStatus } from './protocol'
import { codeOf, REAL_TIMERS, SandboxError, SandboxWatch, type Timers } from './status'
import { sandboxWord, statusBarUpdates, wordCode } from './status-bar'

/** The setting that holds the prefix of code version names. */
export const PREFIX_SETTING = 'codeVersionPrefix'

/** The palette commands, as `contributes.commands` in manifest.json names them. */
export const COMMANDS = {
  pick: 'sandbox.pick',
  release: 'sandbox.release',
  deploy: 'sandbox.deploy',
  reload: 'sandbox.reload',
  refresh: 'sandbox.refresh',
  start: 'sandbox.start',
  stop: 'sandbox.stop'
} as const

/** How often the sandbox list is read again while nothing is followed. */
export const SLOW_REFRESH_MS = 15 * 60_000

/** The fewest milliseconds between two posts of the state: a checkout can change many files. */
const POST_GAP_MS = 250

export type SandboxHandle = Disposable & {
  /** Resolves once the owner was restored and the sandbox list read for the first time. */
  readonly ready: Promise<void>
  /** Posts the state and updates the status bar now, instead of after the usual gap. */
  flush(): Promise<void>
  status(): Promise<SandboxStatus>
}

const NO_ROLES = { sandbox: 'absent', development: 'absent', staging: 'absent', production: 'absent' } as const

/**
 * `listing` replaces how the workspace list and its completeness are read (tests); by default,
 * Orca's `workspace.list`.
 */
export function startSandbox(ctx: PieceContext, timers: Timers = REAL_TIMERS, listing?: (signal?: AbortSignal) => Promise<Listing>): SandboxHandle {
  const { orca, b2c, workspaces, t } = ctx
  const list =
    listing ??
    (async (signal?: AbortSignal): Promise<Listing> => {
      const [listed, hidden] = await Promise.all([listWorkspaces(orca.host, { signal }), hiddenProjects(orca.host, { signal })])
      return { ...listed, hidden }
    })
  let problem: SandboxStatus['problem'] = null
  let disposed = false

  function onProblem(action: SandboxAction, code: string | null): void {
    if (code) problem = { action, code }
    else if (problem?.action === action) problem = null
    changed()
  }

  function onNotice(notice: Notice): void {
    const params =
      notice.kind === 'deployed'
        ? { title: t(messages, 'noticeDeployed', { version: notice.codeVersion }), body: t(messages, 'noticeDeployedBody', { name: notice.workspace }) }
        : { title: t(messages, 'noticeDeployFailed'), body: t(messages, 'noticeDeployFailedBody', { name: notice.workspace, reason: word(notice.code) }) }
    void orca.host.call('notifications.show', params).catch(() => undefined)
  }

  const sandbox = new SandboxWatch({ b2c, timers, onChange: () => changed(), onProblem })
  const ownership = new Ownership({
    b2c,
    store: ctx.store,
    workspaces,
    listing: list,
    timers,
    async prefix() {
      try {
        return prefixOf(await orca.settings.get(PREFIX_SETTING))
      } catch {
        return DEFAULT_PREFIX
      }
    },
    onChange: () => changed(),
    onProblem,
    onNotice,
    log: ctx.log
  })

  /** A failure code in the words of the panel's language. */
  const word = (code: string) => wordCode(t, code)

  async function roles() {
    try {
      return await b2c.instances()
    } catch {
      return { config: 'missing' as const, instances: { ...NO_ROLES } }
    }
  }

  /** Throws the reason when the sandbox role cannot run b2c. */
  async function ensureReady(): Promise<void> {
    const { config, instances } = await roles()
    if (config !== 'ok') throw new SandboxError(`config_${config}`)
    if (instances.sandbox !== 'ready') throw new SandboxError('sandbox_not_ready')
  }

  async function status(): Promise<SandboxStatus> {
    // Never held by a host that does not answer: an unread list shows nothing to delete.
    const unread: Listing = { workspaces: [], complete: false, hidden: null }
    const listed = await new Promise<Listing>((resolve) => {
      const controller = new AbortController()
      const timer = timers.setTimeout(() => {
        controller.abort()
        resolve(unread)
      }, HOST_TIMEOUT_MS)
      list(controller.signal).then(
        (value) => (timers.clearTimeout(timer), resolve(value)),
        () => (timers.clearTimeout(timer), resolve(unread))
      )
    })
    const { config, instances } = await roles()
    const upload = ownership.snapshot()
    const ids = new Set(listed.workspaces.map((workspace) => workspace.id))
    const project = await anchorProject(listed, upload.workspaceId)
    // Only a whole list says a workspace is gone; even then only a person deletes its version.
    // Only a whole list says a workspace is gone, and not for a project hidden from the sidebar;
    // even then only a person deletes its version.
    const leftovers = listed.complete
      ? Object.entries(ownership.storedVersions())
          .filter(([id]) => !ids.has(id) && id !== upload.workspaceId)
          .map(([workspaceId, codeVersion]) => ({ workspaceId, codeVersion, checkable: checkable(listed, ownership.projectOf(workspaceId)) }))
      : []
    return {
      role: instances.sandbox,
      config,
      sandbox: sandbox.snapshot(),
      upload,
      workspaces: listed.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        branch: workspace.branch ?? null,
        local: isLocal(workspace),
        inProject: project === null || workspace.id === upload.workspaceId || (workspace.projectId ?? null) === project,
        codeVersion: ownership.versionOf(workspace.id),
        owner: workspace.id === upload.workspaceId
      })),
      pendingDeletes: ownership.pendingCount(),
      leftovers,
      problem
    }
  }

  /**
   * The project the view lists first: the uploading workspace's, else the focused one's (only to
   * choose what is shown, never what uploads). Null when neither is listed with a project, and the
   * view then lists every workspace as one.
   */
  async function anchorProject(listed: Listing, ownerId: string | null): Promise<string | null> {
    const projectOf = (id: string | null | undefined) => (id ? (listed.workspaces.find((workspace) => workspace.id === id)?.projectId ?? null) : null)
    const owner = projectOf(ownerId)
    if (owner) return owner
    const focused = await new Promise<string | null>((resolve) => {
      const timer = timers.setTimeout(() => resolve(null), HOST_TIMEOUT_MS)
      workspaces.focused().then(
        (workspace) => (timers.clearTimeout(timer), resolve(workspace?.id ?? null)),
        () => (timers.clearTimeout(timer), resolve(null))
      )
    })
    return projectOf(focused)
  }

  async function refresh(): Promise<void> {
    try {
      await ensureReady()
    } catch (error) {
      sandbox.notReady(codeOf(error))
      return
    }
    await sandbox.refresh()
  }

  // Posting the state: at most one post per gap, the last state always posted.
  let lastPost = 0
  let scheduled: unknown = null
  let posting: Promise<void> | null = null
  function changed(): void {
    if (disposed || scheduled !== null) return
    const wait = Math.max(0, lastPost + POST_GAP_MS - timers.now())
    scheduled = timers.setTimeout(() => {
      scheduled = null
      void post()
    }, wait)
  }
  async function post(): Promise<void> {
    if (disposed) return
    lastPost = timers.now()
    const current = await status()
    posting = Promise.all([orca.panels.post('sandbox.changed', current), updateStatusBar(current)]).then(
      () => undefined,
      () => undefined
    )
    await posting
  }

  async function updateStatusBar(current: SandboxStatus): Promise<void> {
    await Promise.all(statusBarUpdates(t, current).map((update) => orca.host.call('statusBar.update', update).catch(() => undefined)))
  }

  // What each request and command does; a refusal throws a SandboxError or a B2cError.
  const actions = {
    async pick(workspaceId: string) {
      await ownership.pick(workspaceId)
    },
    async release() {
      await ownership.release()
    },
    async deploy() {
      await ensureReady()
      await ownership.redeploy()
    },
    async reload() {
      await ensureReady()
      await ownership.reload()
    },
    async start() {
      await ensureReady()
      await sandbox.fire('start')
    },
    async stop() {
      await ensureReady()
      await sandbox.fire('stop')
    }
  }

  /** A request answers with the state after the action; a refusal rejects with its code. */
  async function answer(action: () => Promise<void>): Promise<SandboxStatus> {
    await action()
    changed()
    return status()
  }

  /** A command answers in words: what it started, or why it did not run. */
  async function reply(action: () => Promise<string>): Promise<string> {
    try {
      return await action()
    } catch (error) {
      return word(codeOf(error))
    } finally {
      changed()
    }
  }

  const disposables: Disposable[] = [
    orca.panels.handle('sandbox.status', () => status()),
    orca.panels.handle('sandbox.refresh', () => answer(refresh)),
    orca.panels.handle('sandbox.pick', (input) => answer(() => actions.pick(String(input?.workspaceId ?? '')))),
    orca.panels.handle('sandbox.release', () => answer(actions.release)),
    orca.panels.handle('sandbox.forget', (input) => answer(() => ownership.forget(String(input?.workspaceId ?? '')))),
    orca.panels.handle('sandbox.deploy', () => answer(actions.deploy)),
    orca.panels.handle('sandbox.reload', () => answer(actions.reload)),
    orca.panels.handle('sandbox.start', () => answer(actions.start)),
    orca.panels.handle('sandbox.stop', () => answer(actions.stop)),
    orca.commands.register(COMMANDS.pick, () =>
      reply(async () => {
        // An explicit pick by hand, of the workspace the person ran it in: the only time the
        // focused workspace decides anything.
        const focused = await workspaces.focused()
        if (!focused) throw new SandboxError('no_focused_workspace')
        await actions.pick(focused.id)
        const owner = ownership.current()
        return t(messages, 'replyPicked', { name: focused.name, version: owner?.codeVersion ?? '' })
      })
    ),
    orca.commands.register(COMMANDS.release, () =>
      reply(async () => {
        const owner = ownership.current()
        await actions.release()
        return owner ? t(messages, 'replyReleased', { version: owner.codeVersion }) : t(messages, 'replyNothingUploads')
      })
    ),
    orca.commands.register(COMMANDS.deploy, () =>
      reply(async () => {
        await actions.deploy()
        const upload = ownership.snapshot()
        return t(messages, 'replyDeploy', { name: upload.workspaceName ?? '', version: upload.codeVersion ?? '' })
      })
    ),
    orca.commands.register(COMMANDS.reload, () =>
      reply(async () => {
        await actions.reload()
        return t(messages, 'replyReload', { version: ownership.current()?.codeVersion ?? '' })
      })
    ),
    orca.commands.register(COMMANDS.refresh, () =>
      reply(async () => {
        await ensureReady()
        await refresh()
        const current = await status()
        if (current.sandbox.reason) return word(current.sandbox.reason)
        return t(messages, 'replyStatus', { state: sandboxWord(t, current) })
      })
    ),
    orca.commands.register(COMMANDS.start, () =>
      reply(async () => {
        await actions.start()
        return t(messages, 'replyStart')
      })
    ),
    orca.commands.register(COMMANDS.stop, () =>
      reply(async () => {
        await actions.stop()
        return t(messages, 'replyStop')
      })
    ),
    orca.events.on('workspace.removed', async (event) => {
      await ownership.removed(event.workspaceListId ?? event.workspaceId)
    }),
    // A changed setting can change what dw.json is read and whether the sandbox is ready.
    ctx.settings.onDidChange(() => changed())
  ]

  let slowTimer: unknown = null
  function scheduleSlowRefresh(): void {
    if (disposed) return
    slowTimer = timers.setTimeout(() => {
      slowTimer = null
      void refresh().finally(scheduleSlowRefresh)
    }, SLOW_REFRESH_MS)
  }

  const ready = (async () => {
    try {
      await ownership.restore()
    } catch (error) {
      ctx.log(`could not restore the upload: ${codeOf(error)}`)
    }
    await refresh()
    scheduleSlowRefresh()
    changed()
  })()

  return {
    ready,
    status,
    async flush() {
      if (scheduled !== null) timers.clearTimeout(scheduled)
      scheduled = null
      await post()
    },
    dispose() {
      disposed = true
      if (scheduled !== null) timers.clearTimeout(scheduled)
      if (slowTimer !== null) timers.clearTimeout(slowTimer)
      sandbox.dispose()
      ownership.dispose()
      for (const disposable of disposables.reverse()) disposable.dispose()
    }
  }
}

export const piece: WorkerPiece = {
  id: 'sandbox',
  activate(ctx) {
    // Not awaited: restoring the owner and reading the list must not hold the other pieces.
    return startSandbox(ctx)
  }
}
