// The panel half of every piece, in the order the panel shows them (the order of PIECE_IDS).
import { section as debuggerSection } from '../pieces/debugger/section'
import { section as editor } from '../pieces/editor/section'
import { section as engine } from '../pieces/engine/section'
import { section as errors } from '../pieces/errors/section'
import { section as isml } from '../pieces/isml/section'
import { section as sandbox } from '../pieces/sandbox/section'
import type { PanelSection } from '../core/piece'

export const SECTIONS: readonly PanelSection[] = [isml, sandbox, errors, debuggerSection, engine, editor]
