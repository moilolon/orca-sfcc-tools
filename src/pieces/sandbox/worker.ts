// The sandbox piece's worker half, listed in src/worker/pieces.ts. A stub until phase 2: it
// starts nothing.
import type { WorkerPiece } from '../../core/piece'

export const piece: WorkerPiece = {
  id: 'sandbox',
  activate() {}
}
