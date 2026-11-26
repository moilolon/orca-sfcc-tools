// The two status bar items, worded from the state: the sandbox at all times (its state, and the
// code version while a workspace uploads), and the upload only while it deploys, uploads or
// failed. Pure, so every state's text is tested; the worker hands each update to
// `statusBar.update`.
import { CORE_MESSAGES, type Translator } from '../../core/i18n'
import { messages, type SandboxMessageKey } from './i18n'
import type { SandboxStatus } from './protocol'

export const STATUS_ITEM = 'sandbox'
export const UPLOAD_ITEM = 'sandbox-upload'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export type StatusBarUpdate = { id: string; text?: string; tone?: Tone; icon?: 'cloud' | 'upload' | 'error'; tooltip?: string; visible: boolean }

/** A failure code in the words of the translator's language: the piece's codes, then core's. */
export function wordCode(t: Translator, code: string): string {
  const key = `error.${code}`
  if (key in messages.en) return t(messages, key as SandboxMessageKey)
  if (key in CORE_MESSAGES.en) return t(CORE_MESSAGES, key as keyof (typeof CORE_MESSAGES)['en'])
  return t(CORE_MESSAGES, 'error.unknown', { code })
}

/** The sandbox's state in one lower-case word, a start or stop being followed included. */
export function sandboxWord(t: Translator, current: SandboxStatus): string {
  const { state, following } = current.sandbox
  if (following === 'start') return t(messages, 'barStarting')
  if (following === 'stop') return t(messages, 'barStopping')
  return t(messages, ({ started: 'barStarted', stopped: 'barStopped', busy: 'barBusy', unknown: 'barUnknown' } as const)[state])
}

const SANDBOX_TONES: Record<SandboxStatus['sandbox']['state'], Tone> = { started: 'success', stopped: 'neutral', busy: 'accent', unknown: 'warning' }

export function statusBarUpdates(t: Translator, current: SandboxStatus): [StatusBarUpdate, StatusBarUpdate] {
  const { upload } = current
  const ready = current.config === 'ok' && current.role === 'ready'
  const refresh = t(messages, 'barTooltipRefresh')
  let main: StatusBarUpdate
  if (!ready) {
    main = { id: STATUS_ITEM, text: t(messages, 'barNotReady'), tone: 'warning', icon: 'cloud', tooltip: `${t(messages, 'notReadyBody')} ${refresh}`, visible: true }
  } else {
    const state = sandboxWord(t, current)
    const who =
      upload.workspaceName && upload.codeVersion ? t(messages, 'barTooltipOwner', { name: upload.workspaceName, version: upload.codeVersion }) : t(messages, 'barTooltipNoOwner')
    main = {
      id: STATUS_ITEM,
      text: upload.codeVersion ? t(messages, 'barTextOwner', { state, version: upload.codeVersion }) : t(messages, 'barText', { state }),
      tone: SANDBOX_TONES[current.sandbox.state],
      icon: 'cloud',
      tooltip: `${who} ${refresh}`,
      visible: true
    }
  }
  const version = upload.codeVersion ?? ''
  let second: StatusBarUpdate
  if (upload.state === 'failed') {
    second = { id: UPLOAD_ITEM, text: t(messages, 'barFailed'), tone: 'danger', icon: 'error', tooltip: wordCode(t, upload.reason ?? 'action_failed'), visible: true }
  } else if (upload.state === 'deploying' || upload.state === 'uploading') {
    second = {
      id: UPLOAD_ITEM,
      text: t(messages, upload.state === 'deploying' ? 'barDeploying' : 'barUploading', { version }),
      tone: 'accent',
      icon: 'upload',
      tooltip: t(messages, 'barTooltipOwner', { name: upload.workspaceName ?? '', version }),
      visible: true
    }
  } else {
    second = { id: UPLOAD_ITEM, visible: false }
  }
  return [main, second]
}
