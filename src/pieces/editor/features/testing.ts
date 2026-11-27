// What the features' tests share: a model with its features over a fake UI, a fake engine whose
// answers the test releases (or that answers after a delay), timers the test runs, and the real
// engine piece mounted over the invented checkout of src/pieces/engine/fixtures/. No DOM.
import { mockHost, mountWorker } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { translator } from '../../../core/i18n'
import type { B2c } from '../../../core/b2c'
import type { PieceContext } from '../../../core/piece'
import { createSettings } from '../../../core/settings'
import { createStore } from '../../../core/store'
import { createWorkspaces } from '../../../core/workspaces'
import { MemoryFiles } from '../../engine/checkout/memory'
import type { EngineCompletion, EngineDefinition, EngineHover, EngineIndexStatus, EngineProblems, EngineQuery, EngineReferences, EngineSignature } from '../../engine/protocol'
import { FakeRef } from '../../engine/checkout/testing'
import { committedDw } from '../../engine/query/testing'
import { problemFiles } from '../../engine/problems/testing'
import { createEnginePiece } from '../../engine/worker'
import { IdentityStore, type Identity } from '../identity'
import type { Language } from '../highlight/language'
import type { EditorOpenInput, EditorOpenResult } from '../protocol'
import type { Pos } from '../surface/buffer'
import type { Underline } from '../surface/view'
import { EditorModel } from '../surface/model'
import type { FeatureContext, FeatureName } from './context'
import { fileFor, QueryDocument } from './document'
import { Features } from './features'
import type { KeyPress } from './keys'
import type { EngineRequests, EngineText } from './requests'
import type { FeatureUi, HintView, HoverView, ListView, SignatureView } from './ui'

export const WORKSPACE = 'w-shop'
export const ROOT = 'C:/work/shop'

/** Records what the features draw: the last of each, and every hint. */
export class FakeUi implements FeatureUi {
  lastList: ListView | null = null
  lastHover: HoverView | null = null
  lastSignature: SignatureView | null = null
  lastHint: HintView | null = null
  hints: string[] = []
  lastUnderlines: Underline[] = []
  draws = 0
  /** What is shown now: read through a call, so a test's earlier assertion does not narrow it. */
  now(): { list: ListView | null; hover: HoverView | null; signature: SignatureView | null } {
    return { list: this.lastList, hover: this.lastHover, signature: this.lastSignature }
  }
  underlinesNow(): Underline[] {
    return this.lastUnderlines
  }
  list(view: ListView | null): void {
    this.lastList = view
    this.draws++
  }
  hover(view: HoverView | null): void {
    this.lastHover = view
    this.draws++
  }
  signature(view: SignatureView | null): void {
    this.lastSignature = view
    this.draws++
  }
  hint(view: HintView | null): void {
    this.lastHint = view
    if (view) this.hints.push(view.text)
  }
  underlines(list: Underline[]): void {
    this.lastUnderlines = list
    this.draws++
  }
}

/** Timers the test runs by moving a clock. */
export class Clock {
  now = 0
  private timers: { run: () => void; at: number; cleared: boolean }[] = []
  set = (run: () => void, ms: number): unknown => {
    const timer = { run, at: this.now + ms, cleared: false }
    this.timers.push(timer)
    return timer
  }
  clear = (handle: unknown): void => {
    if (handle) (handle as { cleared: boolean }).cleared = true
  }
  /** Moves the clock, running every timer due on the way. */
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      const due = this.timers.filter((timer) => !timer.cleared && timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.cleared = true
      this.now = Math.max(this.now, due.at)
      due.run()
    }
    this.now = end
    this.timers = this.timers.filter((timer) => !timer.cleared)
  }
}

type Kind = 'complete' | 'hover' | 'definition' | 'references' | 'signature' | 'problems' | 'open'
export type Asked = { kind: Kind; input: Record<string, unknown>; resolve: (answer: unknown) => void; reject: (error: unknown) => void }

/** A fake engine: every request waits until the test answers it (`answer`), or a handler answers at once. */
export class FakeEngine {
  readonly asked: Asked[] = []
  handlers: Partial<Record<Kind, (input: Record<string, unknown>) => unknown>> = {}
  private request<T>(kind: Kind, input: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const record = input as Record<string, unknown>
      const handler = this.handlers[kind]
      if (handler) {
        this.asked.push({ kind, input: record, resolve: () => {}, reject: () => {} })
        resolve(handler(record) as T)
        return
      }
      this.asked.push({ kind, input: record, resolve: resolve as (answer: unknown) => void, reject })
    })
  }
  /** The requests of a kind, oldest first. */
  of(kind: Kind): Asked[] {
    return this.asked.filter((each) => each.kind === kind)
  }
  last(kind: Kind): Asked {
    const list = this.of(kind)
    const last = list[list.length - 1]
    if (!last) throw new Error(`no ${kind} request`)
    return last
  }
  readonly requests: EngineRequests = {
    complete: (query) => this.request<EngineCompletion>('complete', query),
    hover: (query) => this.request<EngineHover>('hover', query),
    definition: (query) => this.request<EngineDefinition>('definition', query),
    references: (query) => this.request<EngineReferences>('references', query),
    signature: (query) => this.request<EngineSignature>('signature', query),
    problems: (query: EngineText) => this.request<EngineProblems>('problems', query),
    open: (input: EditorOpenInput) => this.request<EditorOpenResult>('open', input)
  }
}

/** Lets every pending promise callback run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A text with `‸` marking the caret: the text without it, and the caret's position. */
export function marked(text: string): { text: string; caret: Pos } {
  const at = text.indexOf('‸')
  if (at === -1) return { text, caret: { line: 0, col: 0 } }
  const plain = text.slice(0, at) + text.slice(at + 1)
  const before = plain.slice(0, at).split('\n')
  return { text: plain, caret: { line: before.length - 1, col: before[before.length - 1].length } }
}

export type Harness = {
  model: EditorModel
  document: QueryDocument
  ui: FakeUi
  clock: Clock
  features: Features
  identity: IdentityStore
  times: Partial<Record<FeatureName, number[]>>
  revealed: Pos[]
  /** Types text at the caret as a key would: the model takes it, then the features hear it. */
  type(text: string): void
  /** A key down; true when a feature took it. */
  key(key: string, mods?: Partial<Omit<KeyPress, 'key'>>): boolean
  offset(): number
}

export type HarnessOptions = {
  requests: EngineRequests
  identity?: Identity
  language?: Language
  isMac?: boolean
  /** A real clock (the latency tests); the manual one otherwise. */
  realTime?: boolean
}

/** A model over `text` (its caret at `‸`) with the features, drawing into a fake UI. */
export function harness(source: string, options: HarnessOptions): Harness {
  const { text, caret } = marked(source)
  const model = new EditorModel(text)
  model.setSelection(caret)
  const document = new QueryDocument(model)
  const ui = new FakeUi()
  const clock = new Clock()
  const identity = new IdentityStore()
  identity.set(options.identity ?? { state: 'unknown' })
  const times: Partial<Record<FeatureName, number[]>> = {}
  const revealed: Pos[] = []
  const told = new Set<string>()
  const real = options.realTime === true
  const ctx: FeatureContext = {
    model,
    document,
    requests: options.requests,
    ui,
    file: () => fileFor(identity.value, options.language ?? 'isml'),
    locale: 'en',
    reveal: (at) => {
      model.setSelection(at)
      revealed.push(at)
    },
    now: real ? () => performance.now() : () => clock.now,
    setTimer: real ? (run, ms) => setTimeout(run, ms) : clock.set,
    clearTimer: real ? (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) : clock.clear,
    measured: (feature, ms) => (times[feature] ??= []).push(ms),
    tellOnce: (key, said) => {
      if (told.has(key)) return
      told.add(key)
      ui.hint({ anchor: model.selection.head, text: said })
    }
  }
  const features = new Features(ctx, { isMac: options.isMac ?? false })
  model.onUpdate((event) => {
    if (event.provisional) return
    if (event.textChanged) features.changed(ctx.now())
    else features.caretMoved(ctx.now())
  })
  identity.subscribe(() => features.identityChanged())
  return {
    model,
    document,
    ui,
    clock,
    features,
    identity,
    times,
    revealed,
    type(typed: string) {
      for (const char of typed) {
        const started = ctx.now()
        model.type(char)
        features.typed(char, started)
      }
    },
    key(key, mods = {}) {
      return features.keyDown({ key, ctrl: false, meta: false, alt: false, shift: false, ...mods }, ctx.now())
    },
    offset: () => document.caret()
  }
}

/** An answer's state for a fake: answered from a ready index. */
export const READY = { index: 'ready' as const, error: null }

/** A located file of the invented workspace. */
export const located = (path: string): Identity => ({ state: 'identified', workspaceId: WORKSPACE, path })

/** The real engine piece over the invented checkout (with the problems' fixtures) as workspace `w-shop`, built. */
export async function realEngine(extra: Record<string, string> = {}): Promise<{ requests: EngineRequests; opened: EditorOpenInput[]; dispose: () => Promise<void> }> {
  const files: MemoryFiles = problemFiles(extra)
  const piece = createEnginePiece({
    files: () => files,
    watch: () => ({ dispose() {} }),
    git: () => new FakeRef({}, {}),
    exists: async () => true,
    api: async () => committedDw(),
    describer: () => ({ describe: async (classId: string, member?: string) => `An invented description of ${member ?? classId}.` }),
    pause: async () => {}
  })
  let disposable: { dispose(): void | Promise<void> } | void = undefined
  const host = mockHost({
    capabilities: ['storage:own', 'settings:own', 'workspace:read', 'workspace:write', 'notifications:show'],
    results: {
      'workspace.list': { workspaces: [{ id: WORKSPACE, kind: 'worktree', name: 'Shop', path: ROOT, branch: 'main', hostId: 'local' }], truncated: false },
      'workspace.readContext': { workspaceId: WORKSPACE, branch: 'main', displayName: 'Shop', terminals: [] }
    }
  })
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        const ctx: PieceContext = {
          orca,
          b2c: { mask: async (text: string) => text } as unknown as B2c,
          settings: createSettings(orca.settings),
          store: createStore(orca.storage, 'engine'),
          workspaces: createWorkspaces(orca.host, createStore(orca.storage, 'core')),
          t: translator(() => 'en'),
          log: () => {}
        }
        disposable = await piece.activate(ctx)
      },
      deactivate: () => disposable?.dispose()
    },
    { host }
  )
  const request = <T>(name: string, input: unknown): Promise<T> => worker.request(name as never, input as never) as Promise<T>
  // The first build, and the first pass over the checkout.
  for (let i = 0; i < 4000; i++) {
    const status = await request<EngineIndexStatus>('engine.index.status', {})
    const list = await request<{ state: string }>('engine.problems.list', {})
    if (status.state === 'ready' && list.state === 'ready') break
    if (status.state === 'failed') throw new Error('the invented checkout did not build')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const opened: EditorOpenInput[] = []
  const requests: EngineRequests = {
    complete: (query: EngineQuery) => request('engine.complete', query),
    hover: (query) => request('engine.hover', query),
    definition: (query) => request('engine.definition', query),
    references: (query) => request('engine.references', query),
    signature: (query) => request('engine.signature', query),
    problems: (query) => request('engine.problems', query),
    open: async (input) => {
      opened.push(input)
      return { opened: true }
    }
  }
  return { requests, opened, dispose: async () => void (await disposable?.dispose()) }
}
