// The texts of the editor's breakpoints, stopped line and values (phase 7.3), in English and
// Spanish: the gutter's tooltips, the stopped line's label, the value pop-up and the one-line
// notices. Each at most NOTICE_MAX_CHARS characters, like a panel notice.
import { defineMessages } from '../../../core/i18n'

export const debugMessages = defineMessages(
  {
    markVerified: 'Breakpoint, verified by the session',
    markUnverified: 'Breakpoint, not verified by the session',
    markIdle: 'Breakpoint, no debugging session',
    markPending: 'Breakpoint, sent to the debugger once you save',
    stoppedHere: 'Stopped here: {name}',
    stoppedHereNoName: 'Stopped here',
    calledHere: 'Called from here: {name}',
    calledHereNoName: 'Called from here',
    valueLabel: 'Value while stopped',
    valueMembers: 'has members: see Variables in the debugger',
    failed: 'Could not change the breakpoint. Try again.',
    notScript: 'Breakpoints go only in scripts of a cartridge.',
    lineChanged: 'This line is not saved yet: save the file, then set it.'
  },
  {
    markVerified: 'Punto de interrupción, verificado por la sesión',
    markUnverified: 'Punto de interrupción, sin verificar por la sesión',
    markIdle: 'Punto de interrupción, sin sesión de depuración',
    markPending: 'Punto de interrupción, pasa al depurador al guardar',
    stoppedHere: 'Parado aquí: {name}',
    stoppedHereNoName: 'Parado aquí',
    calledHere: 'Llamado desde aquí: {name}',
    calledHereNoName: 'Llamado desde aquí',
    valueLabel: 'Valor mientras está parado',
    valueMembers: 'tiene miembros: míralos en Variables del depurador',
    failed: 'No se ha podido cambiar el punto de interrupción. Inténtalo de nuevo.',
    notScript: 'Los puntos de interrupción solo van en scripts de un cartucho.',
    lineChanged: 'Esta línea aún no está guardada: guarda el fichero y vuelve a ponerlo.'
  }
)
