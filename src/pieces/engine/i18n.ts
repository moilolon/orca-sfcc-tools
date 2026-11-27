// The engine piece's texts in English and Spanish. The checkout index (6.3) has no view yet: its
// words are here for whoever shows its state, its path sources and its codes.
import { defineMessages } from '../../core/i18n'

export const messages = defineMessages(
  {
    title: 'Analysis',
    stateNone: 'No workspace',
    stateBuilding: 'Indexing…',
    stateReady: 'Indexed',
    stateFailed: 'Index failed',
    sourceSetting: 'From the setting',
    sourceSiteArchive: 'From the site archive',
    sourceGitRef: 'From the git ref',
    sourceNone: 'No cartridge path',
    index_failed: 'The checkout could not be indexed.',
    git_not_found: 'git was not found on the PATH.',
    git_shim_refused: 'git is a .cmd or .bat shim: only git.exe is started.',
    git_failed: 'git could not read the ref.',
    git_timeout: 'git took too long to read the ref.',
    git_output_too_large: 'The ref holds too much to read.',
    ref_invalid: 'The git ref setting is not a valid ref name.',
    ref_not_found: 'The git ref names no commit.',
    path_invalid: 'A path of the ref is not a plain relative path.'
  },
  {
    title: 'Análisis',
    stateNone: 'Ningún espacio de trabajo',
    stateBuilding: 'Indexando…',
    stateReady: 'Indexado',
    stateFailed: 'Falló el índice',
    sourceSetting: 'Del ajuste',
    sourceSiteArchive: 'Del archivo del sitio',
    sourceGitRef: 'De la referencia de git',
    sourceNone: 'Sin ruta de cartuchos',
    index_failed: 'No se pudo indexar el checkout.',
    git_not_found: 'No se encontró git en el PATH.',
    git_shim_refused: 'git es un .cmd o .bat: solo se inicia git.exe.',
    git_failed: 'git no pudo leer la referencia.',
    git_timeout: 'git tardó demasiado en leer la referencia.',
    git_output_too_large: 'La referencia contiene demasiado para leerla.',
    ref_invalid: 'El ajuste de la referencia de git no es un nombre válido.',
    ref_not_found: 'La referencia de git no apunta a ningún commit.',
    path_invalid: 'Una ruta de la referencia no es una ruta relativa simple.'
  }
)
