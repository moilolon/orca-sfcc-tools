// The worker half of every piece that has one, in the order they start. `isml` has none: it only
// contributes to the manifest.
import { piece as debuggerPiece } from '../pieces/debugger/worker'
import { piece as editor } from '../pieces/editor/worker'
import { piece as engine } from '../pieces/engine/worker'
import { piece as errors } from '../pieces/errors/worker'
import { piece as sandbox } from '../pieces/sandbox/worker'
import type { WorkerPiece } from '../core/piece'

export const WORKER_PIECES: readonly WorkerPiece[] = [sandbox, errors, debuggerPiece, engine, editor]
