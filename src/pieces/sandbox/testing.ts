// Fakes the sandbox piece's tests share: a b2c runner that records every command and lets a test
// hold a deploy or end a watcher, timers a test moves by hand, and storage and a workspace host
// over plain values. Only tests import this file. Every value is invented; hosts are under
// example.com.
import type { JsonValue } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import { B2cError, type B2c, type B2cEvent, type Exit, type InstancesState, type RunOptions, type RunResult, type Running, type StartOptions } from '../../core/b2c'
import { createStore, type Store } from '../../core/store'
import { createWorkspaces } from '../../core/workspaces'
import type { Workspaces } from '../../core/piece'
import type { Timers } from './status'

export const SANDBOX_HOST = 'sandbox-01.example.com'

export const READY: InstancesState = { config: 'ok', instances: { sandbox: 'ready', development: 'absent', staging: 'absent', production: 'absent' } }

/** For `assert.rejects`: the error carries this code. */
export function coded(code: string): (error: unknown) => boolean {
  return (error) => !!error && typeof error === 'object' && (error as { code?: unknown }).code === code
}

/** Lets pending promise callbacks run. */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

type Deferred = { promise: Promise<RunResult>; resolve(json?: unknown): void; reject(code: string): void; args: string[]; options: RunOptions }

export class FakeRunning implements Running {
  stopped = false
  private finish!: (exit: Exit) => void
  readonly exited = new Promise<Exit>((resolve) => (this.finish = resolve))
  constructor(
    readonly args: readonly string[],
    readonly options: StartOptions
  ) {}
  /** b2c prints a JSON line on stderr. */
  emit(json: unknown): void {
    if (!this.stopped) this.options.onEvent?.({ json } as B2cEvent)
  }
  /** The process ends by itself. */
  exit(exitCode = 1, reason?: Exit['reason']): void {
    this.finish({ exitCode, stopped: false, ...(reason ? { reason } : {}) })
  }
  write(): boolean {
    return false
  }
  end(): void {}
  stop(): void {
    this.stopped = true
    this.finish({ exitCode: null, stopped: true })
  }
}

export class FakeB2c implements B2c {
  readonly runs: { args: string[]; options: RunOptions }[] = []
  readonly watchers: FakeRunning[] = []
  readonly held: Deferred[] = []
  state: InstancesState = READY
  /** What `sandbox list` answers, or the code it fails with. */
  sandboxList: unknown | { fail: string } = { data: [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', state: 'started', hostName: SANDBOX_HOST, createdAt: '2024-01-02T03:04:05Z' }] }
  /** The code versions `code list` answers with. */
  codeVersions: { id: string; active: boolean }[] = []
  /** Commands whose first words are here wait for the test; others answer at once. */
  hold = new Set<string>()
  /** Commands that fail, by their first words, with a code. */
  fail = new Map<string, string>()

  private matches(args: readonly string[], key: string): boolean {
    return args.slice(0, key.split(' ').length).join(' ') === key
  }

  commands(): string[] {
    return this.runs.map((run) => run.args.join(' '))
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.runs.push({ args: [...args], options })
    for (const [key, code] of this.fail) if (this.matches(args, key)) throw new B2cError(code as never)
    if ([...this.hold].some((key) => this.matches(args, key))) {
      let resolve!: (json?: unknown) => void
      let reject!: (code: string) => void
      const promise = new Promise<RunResult>((ok, ko) => {
        resolve = (json) => ok({ stdout: '', stderr: '', json })
        reject = (code) => ko(new B2cError(code as never))
      })
      options.signal?.addEventListener('abort', () => reject('aborted'))
      this.held.push({ promise, resolve, reject, args: [...args], options })
      return promise
    }
    if (this.matches(args, 'sandbox list')) {
      const list = this.sandboxList
      if (list && typeof list === 'object' && 'fail' in list) throw new B2cError((list as { fail: string }).fail as never)
      return { stdout: '', stderr: '', json: list }
    }
    if (this.matches(args, 'code list')) return { stdout: '', stderr: '', json: { data: this.codeVersions.map((v) => ({ ...v })) } }
    if (this.matches(args, 'code deploy') && args.includes('--activate')) this.activate(args[args.indexOf('--code-version') + 1])
    if (this.matches(args, 'code activate')) this.activate(args[2])
    if (this.matches(args, 'code delete')) this.codeVersions = this.codeVersions.filter((v) => v.id !== args[2])
    return { stdout: '', stderr: '', json: undefined }
  }

  /** What a successful activation does on the sandbox. */
  activate(version: string): void {
    if (!this.codeVersions.some((v) => v.id === version)) this.codeVersions.push({ id: version, active: false })
    this.codeVersions = this.codeVersions.map((v) => ({ ...v, active: v.id === version }))
  }

  /** Ends the oldest held command well (activating a held deploy's version) or with a code. */
  release(index = 0, code?: string): void {
    const held = this.held[index]
    if (!held) throw new Error('nothing held')
    if (code) held.reject(code)
    else {
      if (held.args[0] === 'code' && held.args[1] === 'deploy') this.activate(held.args[held.args.indexOf('--code-version') + 1])
      held.resolve(undefined)
    }
  }

  async start(args: readonly string[], options: StartOptions = {}): Promise<Running> {
    this.runs.push({ args: [...args], options })
    const running = new FakeRunning(args, options)
    this.watchers.push(running)
    return running
  }

  async version(): Promise<string | null> {
    return '2.11.0'
  }
  async instances(): Promise<InstancesState> {
    return this.state
  }
  async mask(text: string): Promise<string> {
    return text
  }
  async isHost(role: string, value: unknown): Promise<boolean> {
    return role === 'sandbox' && typeof value === 'string' && value.toLowerCase() === SANDBOX_HOST
  }
}

export class FakeTimers implements Timers {
  time = 1_000_000
  private next = 1
  private readonly pending = new Map<number, { at: number; fn: () => void }>()
  now(): number {
    return this.time
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++
    this.pending.set(id, { at: this.time + ms, fn })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number)
  }
  /** Moves the clock and runs every timer that falls due, in order. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms
    for (;;) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.pending.delete(due[0])
      this.time = Math.max(this.time, due[1].at)
      due[1].fn()
      await settle()
    }
    this.time = end
    await settle()
  }
}

export function memoryStorage(initial: Record<string, JsonValue> = {}) {
  const data = new Map<string, JsonValue>(Object.entries(initial))
  return {
    data,
    source: {
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: JsonValue) => void data.set(key, value),
      delete: async (key: string) => void data.delete(key),
      keys: async () => [...data.keys()]
    }
  }
}

export type Listed = { id: string; kind: 'worktree' | 'folder'; name: string; path: string; branch: string | null; hostId: string | null }

export const SHOP: Listed = { id: 'w-shop', kind: 'worktree', name: 'Shop', path: 'C:/work/shop', branch: 'main', hostId: 'local' }
export const FIX: Listed = { id: 'w-fix', kind: 'worktree', name: 'Checkout Fix', path: 'C:/work/checkout-fix', branch: 'fix', hostId: 'local' }
export const REMOTE: Listed = { id: 'w-remote', kind: 'folder', name: 'Shop on a server', path: '/srv/shop', branch: null, hostId: 'ssh:build-01' }

/** A workspace host whose list and focus a test changes, and the real core workspaces over it. */
export function fakeWorkspaces(listed: Listed[] = [SHOP, FIX, REMOTE], storage = memoryStorage()) {
  const state = { listed, focused: null as string | null }
  const host = {
    call: async (method: string) => {
      if (method === 'workspace.list') return { workspaces: state.listed, truncated: false }
      if (method === 'workspace.readContext') return state.focused ? { workspaceId: state.focused, branch: '', displayName: '', terminals: [] } : null
      throw new Error(`unexpected host call: ${method}`)
    }
  } as unknown as OrcaWorkerApi['host']
  const workspaces: Workspaces = createWorkspaces(host, createStore(storage.source, 'core'))
  return { state, workspaces, storage }
}

export function pieceStore(storage = memoryStorage()): Store {
  return createStore(storage.source, 'sandbox')
}
