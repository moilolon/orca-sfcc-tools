// The attributes each of ISML's own tags takes, for completion and hover. The tag set is the
// parser's (`ISML_TAGS`); a custom tag takes the attributes its `<ismodule>` declares. Pure.
import { ISML_TAGS } from '../isml/parser'

export const ISML_TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  isactivedatacontext: ['category'],
  isactivedatahead: [],
  isanalyticsoff: [],
  isbreak: [],
  iscache: ['type', 'hour', 'minute', 'varyby', 'if', 'status'],
  iscomment: [],
  iscomponent: ['pipeline', 'locale', 'encoding'],
  iscontent: ['type', 'encoding', 'compact', 'charset'],
  iscontinue: [],
  iscookie: ['name', 'value', 'comment', 'domain', 'path', 'maxAge', 'version', 'secure'],
  isdecorate: ['template'],
  iselse: [],
  iselseif: ['condition'],
  isif: ['condition'],
  isinclude: ['template', 'url', 'sf-toolkit'],
  isloop: ['items', 'iterator', 'alias', 'var', 'status', 'begin', 'end', 'step'],
  ismodule: ['template', 'name', 'attribute'],
  isnext: [],
  isobject: ['object', 'view'],
  isprint: ['value', 'encoding', 'timezone', 'padding', 'formatter', 'style'],
  isredirect: ['location', 'permanent'],
  isremove: ['name', 'scope'],
  isreplace: [],
  isscript: [],
  isselect: ['name', 'iterator', 'description', 'value', 'condition', 'encoding'],
  isset: ['name', 'value', 'scope'],
  isslot: ['id', 'context', 'description', 'context-object', 'preview-url'],
  isstatus: ['value']
}

/** The tags whose `template` attribute names a template. */
export const TEMPLATE_ATTRIBUTE_TAGS: ReadonlySet<string> = new Set(['isinclude', 'isdecorate', 'ismodule'])

/** Every ISML tag, sorted. */
export function ismlTags(): string[] {
  return [...ISML_TAGS].sort()
}
