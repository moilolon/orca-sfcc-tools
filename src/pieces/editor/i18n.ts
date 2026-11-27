// The editor piece's texts in English and Spanish: the command's answers, and the editor frame's
// notices (each one line, at most NOTICE_MAX_CHARS characters, like a panel notice).
import { defineMessages } from '../../core/i18n'

export const messages = defineMessages(
  {
    title: 'Editor',
    cmdNoWorkspace: 'No workspace on this machine is focused.',
    cmdNothingSaved: 'Save the file once (Ctrl+S), then run this again.',
    cmdOpened: 'Opened {name} in the SFCC editor.',
    cmdNotOpened: 'Could not open {name} in the SFCC editor.',
    notIdentified: 'File not identified: links to other files are off.',
    sameText: 'Same text in {count} files. Which one is this?',
    sameTextMore: 'Same text in {count} files (first {shown} listed).',
    pick: 'Choose the file',
    use: 'Use',
    dismiss: 'Dismiss',
    merged: 'Changed outside while you typed: your edits kept where both changed.',
    readOnly: 'Read only',
    editorLabel: 'SFCC editor'
  },
  {
    title: 'Editor',
    cmdNoWorkspace: 'No hay ningún workspace de esta máquina enfocado.',
    cmdNothingSaved: 'Guarda el fichero una vez (Ctrl+S) y vuelve a ejecutarlo.',
    cmdOpened: '{name} abierto en el editor SFCC.',
    cmdNotOpened: 'No se ha podido abrir {name} en el editor SFCC.',
    notIdentified: 'Fichero sin identificar: los enlaces a otros ficheros están desactivados.',
    sameText: 'El mismo texto está en {count} ficheros. ¿Cuál es este?',
    sameTextMore: 'El mismo texto está en {count} ficheros (se listan {shown}).',
    pick: 'Elige el fichero',
    use: 'Usar',
    dismiss: 'Descartar',
    merged: 'Cambió fuera mientras escribías: tus cambios quedan donde ambos cambiaron.',
    readOnly: 'Solo lectura',
    editorLabel: 'Editor SFCC'
  }
)
