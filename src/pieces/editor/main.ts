// The plugin's editor, the entry of `contributes.customEditors`: Orca transpiles it and loads it
// in an isolated editor frame, where it may import only relative files. It draws the surface
// (surface/view.ts) over the editing model, keeps the document in sync with Orca (sync.ts), colours
// the text with the engine's lexers (highlight/), takes Orca's editor typography and theme, and
// asks the worker which file it shows (locate-client.ts), with a one-line notice when it cannot
// tell. The features of 7.2 and 7.3 build on `editor` below.
import { t } from '../../core/i18n'
import { guessLanguage, languageOfPath, LEXERS } from './highlight/language'
import { IdentityStore } from './identity'
import { LocateClient } from './locate-client'
import { messages } from './i18n'
import { EditorModel } from './surface/model'
import { SurfaceView, type Typography } from './surface/view'
import { startSync } from './sync'
import { STYLES } from './styles'

type Notice = { text: string; choices?: string[]; onChoose?: (path: string) => void; dismissible?: boolean }

/** How long the frame waits for `editor.locate`: Orca's longest request timeout. */
const LOCATE_TIMEOUT_MS = 120_000

const api = globalThis.orca
const word = (key: keyof (typeof messages)['en'], vars?: Record<string, string | number>) => t(messages, api.locale, key, vars)

function skeleton(): { surface: HTMLDivElement; notice: HTMLDivElement } {
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.appendChild(style)
  const app = document.createElement('div')
  app.id = 'app'
  const notice = document.createElement('div')
  notice.className = 'ed-notice'
  notice.setAttribute('role', 'status')
  notice.hidden = true
  const surface = document.createElement('div')
  surface.id = 'surface'
  app.append(notice, surface)
  document.body.appendChild(app)
  return { surface, notice }
}

/** The notice line above the text: one line on why, and at most one choice. */
function showNotice(host: HTMLDivElement, notice: Notice | null): void {
  host.replaceChildren()
  host.hidden = notice === null
  if (!notice) return
  const text = document.createElement('span')
  text.className = 'ed-notice-text'
  text.textContent = notice.text
  host.appendChild(text)
  if (notice.choices && notice.onChoose) {
    const select = document.createElement('select')
    select.setAttribute('aria-label', word('pick'))
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = word('pick')
    placeholder.disabled = true
    placeholder.selected = true
    select.appendChild(placeholder)
    for (const choice of notice.choices) {
      const option = document.createElement('option')
      option.value = choice
      option.textContent = choice
      select.appendChild(option)
    }
    const use = document.createElement('button')
    use.type = 'button'
    use.textContent = word('use')
    use.disabled = true
    select.addEventListener('change', () => (use.disabled = !select.value))
    const choose = notice.onChoose
    use.addEventListener('click', () => {
      if (select.value) choose(select.value)
    })
    host.append(select, use)
  } else if (notice.dismissible) {
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = word('dismiss')
    dismiss.addEventListener('click', () => showNotice(host, null))
    host.appendChild(dismiss)
  }
}

function typographyOf(value: unknown): Typography {
  const raw = (value ?? {}) as { cssFontFamily?: unknown; fontSize?: unknown; fontWeight?: unknown; lineHeight?: unknown; fontLigatures?: unknown }
  return {
    fontFamily: typeof raw.cssFontFamily === 'string' && raw.cssFontFamily ? raw.cssFontFamily : undefined,
    fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : undefined,
    fontWeight: typeof raw.fontWeight === 'string' ? raw.fontWeight : undefined,
    lineHeight: typeof raw.lineHeight === 'number' ? raw.lineHeight : undefined,
    fontLigatures: typeof raw.fontLigatures === 'boolean' ? raw.fontLigatures : undefined
  }
}

async function main(): Promise<void> {
  const { surface, notice } = skeleton()
  const sync = await startSync(api)
  const model = new EditorModel(sync.initial, { readOnly: sync.readOnly })
  const view = new SurfaceView(surface, model, { lexer: LEXERS[guessLanguage(sync.initial)], label: word('editorLabel') })
  const identity = new IdentityStore()

  // Every edit goes to Orca (the session coalesces them); a composition in progress does not.
  model.onUpdate((event) => {
    if (event.textChanged && !event.provisional) sync.change(model.text())
  })
  let lastMerge = sync.lastMerge()
  sync.onReplace((text) => {
    model.replaceAll(text)
    const merge = sync.lastMerge()
    if (merge && merge !== lastMerge && merge.conflicts > 0) showNotice(notice, { text: word('merged'), dismissible: true })
    lastMerge = merge
    if (identity.value.state !== 'identified') void locate()
  })

  // Typography and theme from Orca: read once, then on every change.
  try {
    view.setTypography(typographyOf(await api.host.call('editor.readTypography')))
  } catch {
    // Orca's defaults stay.
  }
  api.on('editor.typography.changed', (typography) => view.setTypography(typographyOf(typography)))
  api.on('theme', () => view.redrawAll())

  // Which file this is: asked once the frame knows its workspace, again after a save.
  let workspaceId: string | null = null
  try {
    workspaceId = (await api.host.call('workspace.readContext'))?.workspaceId ?? null
  } catch {
    workspaceId = null
  }
  const client = new LocateClient(
    {
      // A workspace's first index can take a while on a busy disk: the longest wait Orca allows.
      locate: (input) => api.plugin.request('editor.locate', input, { timeoutMs: LOCATE_TIMEOUT_MS }),
      choose: (input) => api.plugin.request('editor.choose', input)
    },
    workspaceId,
    identity
  )
  identity.subscribe((current) => {
    if (current.state === 'identified') {
      const language = languageOfPath(current.path)
      if (language) view.setLexer(LEXERS[language])
      showNotice(notice, null)
    } else if (current.state === 'ambiguous') {
      const total = current.candidates.length + current.more
      showNotice(notice, {
        text: current.more > 0 ? word('sameTextMore', { count: total, shown: current.candidates.length }) : word('sameText', { count: total }),
        choices: current.candidates,
        onChoose: (path) => void client.choose(model.text(), path)
      })
    } else if (current.state === 'unknown') {
      showNotice(notice, { text: word('notIdentified') })
    }
  })
  async function locate(): Promise<void> {
    const located = await client.locate(model.text())
    if (located.line) view.revealLine(located.line, located.column)
  }
  api.plugin.on('editor.saved', (payload) => {
    if (identity.value.state !== 'identified' && (payload?.workspaceId ?? null) === workspaceId) void locate()
  })
  view.focus()
  await locate()
}

main().catch((error: unknown) => {
  // Without a document there is nothing to edit. Only the code reaches the log, never the text.
  console.error(`sfcc editor: ${(error as { code?: string } | null)?.code ?? 'failed to start'}`)
})
