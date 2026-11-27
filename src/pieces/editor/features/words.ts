// The words of the language features: the engine answers data (phase 6.4: a hover's kind and its
// entries, a problem's code and names), worded here from the engine's own texts
// (src/pieces/engine/i18n.ts) and the editor's (../i18n.ts). Pure: no DOM, no Orca.
import { t } from '../../../core/i18n'
import { messages as engineMessages, problemMessage, type EngineMessageKey } from '../../engine/i18n'
import type { CompletionKind, EngineHoverResult, Problem, Target } from '../../engine/protocol'
import { messages } from '../i18n'
import type { ListItemView, Section } from './ui'

export type EditorWord = keyof (typeof messages)['en']

/** The most entries a hover lists of one kind (copies, definitions, steps); the rest are counted. */
export const HOVER_ENTRIES = 8
/** The longest description, JSDoc or value a pop-up shows. */
export const MAX_TEXT = 900

export const word = (locale: string, key: EditorWord, vars?: Record<string, string | number>): string => t(messages, locale, key, vars)
export const engineWord = (locale: string, key: EngineMessageKey, vars?: Record<string, string | number>): string => t(engineMessages, locale, key, vars)

/** An engine code worded when the engine has words for it, else its fallback. */
function engineCode(locale: string, code: string, fallback: EngineMessageKey): string {
  return engineWord(locale, code in engineMessages.en ? (code as EngineMessageKey) : fallback)
}

const cut = (text: string, max = MAX_TEXT): string => {
  const plain = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return plain.length <= max ? plain : `${plain.slice(0, max - 1).trimEnd()}…`
}

export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
export const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

export function kindWord(locale: string, kind: CompletionKind): string {
  const key = `kind.${kind}`
  return key in messages.en ? word(locale, key as EditorWord) : kind
}

/** Where something runs: the storefronts named, or nothing when none can be named. */
function storefronts(locale: string, list: readonly string[] | null): Section[] {
  if (list === null || list.length === 0) return []
  return [{ tone: 'muted', text: engineWord(locale, 'runsOn', { storefront: list.join(', ') }) }]
}

/** At most `HOVER_ENTRIES` entries, then how many more. */
function capped<T>(locale: string, list: readonly T[], each: (entry: T) => Section[]): Section[] {
  const out = list.slice(0, HOVER_ENTRIES).flatMap(each)
  if (list.length > HOVER_ENTRIES) out.push({ tone: 'muted', text: word(locale, 'moreEntries', { count: list.length - HOVER_ENTRIES }) })
  return out
}

/** A copy that runs on a storefront: its file, or that the storefront has none. */
function copy(locale: string, storefront: string | null, path: string | null): Section {
  if (path === null) return { tone: 'muted', text: storefront ? engineWord(locale, 'notOnStorefront', { storefront }) : '' }
  return { tone: 'muted', text: storefront ? `${storefront}: ${path}` : path }
}

/**
 * A hover's sections. `describing`: the description of a `dw.*` class or member is still being
 * read, and comes in a later answer.
 */
export function hoverSections(locale: string, hover: EngineHoverResult, describing = false): Section[] {
  const out: Section[] = []
  const description = (): void => {
    if (hover.description) out.push({ tone: 'text', text: cut(hover.description) })
    else if (describing) out.push({ tone: 'muted', text: word(locale, 'readingDescription') })
    else if (hover.descriptionError) out.push({ tone: 'muted', text: engineCode(locale, hover.descriptionError, 'describe_failed') })
  }
  switch (hover.kind) {
    case 'dw-member': {
      out.push(...capped(locale, hover.members, (member) => [{ tone: 'code', text: member.signature }]))
      out.push({ tone: 'muted', text: hover.classId })
      if (hover.members.length > 0 && hover.members.every((member) => member.deprecated)) out.push({ tone: 'warning', text: engineWord(locale, 'deprecated') })
      description()
      break
    }
    case 'dw-class': {
      out.push({ tone: 'code', text: `class ${hover.classId}${hover.super ? ` extends ${hover.super}` : ''}` })
      if (hover.deprecated) out.push({ tone: 'warning', text: engineWord(locale, 'deprecated') })
      description()
      break
    }
    case 'dw-package':
      out.push({ tone: 'code', text: `package ${hover.name}` }, { tone: 'muted', text: word(locale, 'packageCounts', { classes: hover.classes, packages: hover.packages }) })
      break
    case 'module': {
      out.push({ tone: 'code', text: `require('${hover.module}')` })
      out.push(...capped(locale, hover.copies, (entry) => [copy(locale, entry.storefront, entry.path)]))
      if (hover.candidates.length > 1) out.push({ tone: 'muted', text: engineWord(locale, 'candidates', { count: hover.candidates.length }) })
      break
    }
    case 'module-member': {
      out.push({ tone: 'code', text: `${hover.module} › ${hover.name}` })
      out.push(
        ...capped(locale, hover.definitions, (entry) => [
          ...(entry.params ? [{ tone: 'code' as const, text: `${hover.name}(${entry.params.join(', ')})` }] : []),
          { tone: 'muted' as const, text: engineWord(locale, 'definedIn', { path: entry.path, line: entry.line }) },
          ...storefronts(locale, entry.storefronts),
          ...(entry.doc ? [{ tone: 'text' as const, text: cut(entry.doc) }] : [])
        ])
      )
      break
    }
    case 'super-module': {
      out.push({ tone: 'code', text: 'module.superModule' })
      if (hover.module) out.push({ tone: 'muted', text: hover.module })
      out.push(...capped(locale, hover.copies, (entry) => [copy(locale, entry.storefront, entry.path)]))
      break
    }
    case 'route': {
      out.push({ tone: 'code', text: hover.id })
      out.push(
        ...capped(locale, hover.storefronts, (entry) => [
          { tone: 'muted' as const, text: entry.controller ? `${entry.storefront}: ${entry.controller}` : engineWord(locale, 'notOnStorefront', { storefront: entry.storefront }) },
          ...entry.steps.map((step) => ({ tone: 'code' as const, text: `${step.method} ${step.name} · ${step.cartridge}:${step.line}${step === entry.serves ? ` · ${engineWord(locale, 'servesRequest')}` : ''}` })),
          ...entry.problems.map((problem) => ({ tone: 'error' as const, text: engineCode(locale, problem.code, 'route_missing') }))
        ])
      )
      out.push(
        ...capped(locale, hover.cartridges, (entry) => [
          { tone: 'muted' as const, text: `${entry.cartridge}: ${entry.path}` },
          ...entry.steps.map((step) => ({ tone: 'code' as const, text: `${step.method} ${step.name} · ${step.line}` }))
        ])
      )
      break
    }
    case 'template': {
      out.push({ tone: 'code', text: hover.name })
      out.push(...capped(locale, hover.copies, (entry) => [copy(locale, entry.locale ? `${entry.storefront} (${entry.locale})` : entry.storefront, entry.path)]))
      if (hover.candidates.length > 1) out.push({ tone: 'muted', text: engineWord(locale, 'candidates', { count: hover.candidates.length }) })
      break
    }
    case 'resource': {
      out.push({ tone: 'code', text: `${hover.bundle} › ${hover.key}` })
      out.push(
        ...capped(locale, hover.copies, (entry) =>
          entry.value === null
            ? [{ tone: 'muted' as const, text: engineWord(locale, 'notOnStorefront', { storefront: entry.storefront }) }]
            : [
                { tone: 'text' as const, text: `${entry.storefront}: ${cut(entry.value, 300)}` },
                ...(entry.path ? [{ tone: 'muted' as const, text: entry.line ? engineWord(locale, 'definedIn', { path: entry.path, line: entry.line }) : entry.path }] : [])
              ]
        )
      )
      break
    }
    case 'attribute': {
      out.push({ tone: 'code', text: `${hover.typeId}.custom.${hover.id}${hover.type ? `: ${hover.type}` : ''}` })
      if (hover.guessed) out.push({ tone: 'warning', text: engineWord(locale, 'guessed') })
      if (hover.path) out.push({ tone: 'muted', text: hover.line ? engineWord(locale, 'definedIn', { path: hover.path, line: hover.line }) : hover.path })
      break
    }
    case 'tag': {
      out.push({ tone: 'code', text: `<${hover.name}>` })
      if (hover.attributes.length > 0) out.push({ tone: 'muted', text: word(locale, 'attributes', { names: hover.attributes.slice(0, 20).join(', ') }) })
      if (hover.custom && hover.template) out.push({ tone: 'muted', text: word(locale, 'customTag', { template: hover.template }) })
      out.push(...capped(locale, hover.copies, (entry) => [copy(locale, entry.storefront, entry.path)]))
      break
    }
  }
  return out.filter((section) => section.text !== '')
}

/** The documentation page a hover links to: a `dw.*` member's or class's. */
export function hoverLink(hover: EngineHoverResult): string | null {
  if (hover.kind === 'dw-class') return hover.link || null
  if (hover.kind === 'dw-member') return hover.members[0]?.link || null
  return null
}

/** The problems at a place, worded, by severity. */
export function problemSections(locale: string, problems: readonly Pick<Problem, 'code' | 'args' | 'severity'>[]): Section[] {
  return problems.map((each) => ({ tone: each.severity, text: problemMessage(locale, each) }))
}

/** A place a definition or a reference leads to: its file, folder, line and storefronts. */
export function placeItem(locale: string, place: Pick<Target, 'path' | 'line' | 'storefronts'>, note: string | null = null): ListItemView {
  const folder = folderOf(place.path)
  const where = place.storefronts && place.storefronts.length > 0 ? place.storefronts.join(', ') : null
  return {
    label: `${fileName(place.path)}:${place.line}`,
    detail: [where, folder].filter(Boolean).join(' · ') || null,
    note: note ?? word(locale, 'line', { line: place.line }),
    deprecated: false
  }
}
