// The panel section of every piece that has one, in the order the panel shows them. `isml` has
// none: it only contributes to the manifest.
import { section as debuggerSection } from '../pieces/debugger/section'
import { section as editor } from '../pieces/editor/section'
import { section as engine } from '../pieces/engine/section'
import { section as errors } from '../pieces/errors/section'
import { section as sandbox } from '../pieces/sandbox/section'
import type { PanelSection } from '../core/piece'

export const SECTIONS: readonly PanelSection[] = [sandbox, errors, debuggerSection, engine, editor]
