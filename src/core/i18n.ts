// Texts in English and Spanish. Each piece keeps its own table (src/pieces/<piece>/i18n.ts) and
// core keeps the shared one below. English is the fallback: a locale whose language has no table
// reads English. No imports, so the panel, the worker and tests all load it.

export const LANGUAGES = ['en', 'es'] as const
export type Language = (typeof LANGUAGES)[number]

/** A table of texts: Spanish has exactly the English keys (the types refuse a missing one). */
export type Messages<K extends string> = { readonly [L in Language]: Readonly<Record<K, string>> }

export function defineMessages<T extends Record<string, string>>(en: T, es: Record<keyof T & string, string>): Messages<keyof T & string> {
  return { en, es }
}

/** The language of a BCP-47 locale (`es-ES`, `en`) that has a table; English otherwise. */
export function languageOf(locale: string | null | undefined): Language {
  const language = String(locale || '').toLowerCase().split(/[-_]/)[0]
  return (LANGUAGES as readonly string[]).includes(language) ? (language as Language) : 'en'
}

/** A message with its `{name}` placeholders filled in; unknown ones are left as written. */
export function format(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

export function t<K extends string>(messages: Messages<K>, locale: string, key: K, vars?: Record<string, string | number>): string {
  return format(messages[languageOf(locale)][key] ?? messages.en[key] ?? key, vars)
}

/** `t` bound to a locale that can change, as the worker hands it to pieces. */
export type Translator = <K extends string>(messages: Messages<K>, key: K, vars?: Record<string, string | number>) => string

export function translator(locale: () => string): Translator {
  return (messages, key, vars) => t(messages, locale(), key, vars)
}

/**
 * Core's own texts: the panel's setup section, and the errors the panel words: the runner's
 * codes, plus the two the host itself answers with (`timeout`, `action_failed`).
 */
export const CORE_MESSAGES = defineMessages(
  {
    setup: 'Setup',
    refresh: 'Refresh',
    loading: 'Reading the setup',
    recheck: 'Check again',
    b2c: 'b2c CLI',
    b2cFound: 'Found, version {version}',
    b2cFoundNoVersion: 'Found',
    b2cMissing: 'Not found',
    b2cMissingTitle: 'b2c not found',
    b2cMissingFix: 'Install it, or set b2c path in Settings.',
    instances: 'Environments',
    roleReady: 'Ready',
    roleIncomplete: 'Incomplete',
    roleAbsent: 'Not configured',
    incompleteReason: 'No usable credentials',
    absentReason: 'No host in dw.json',
    configFile: 'dw.json file',
    configReadFrom: 'Source',
    configFromWorkspace: 'Workspace',
    configFromSetting: 'Settings file',
    configState: 'State',
    configOk: 'Read',
    configMissing: 'Not found',
    configInvalid: 'Not valid JSON',
    settingsHint: 'Paths and key suffixes: Settings, SFCC Tools.',
    tryAgain: 'Try again',
    viewLoading: 'Loading {piece}',
    viewFailedTitle: '{piece} could not be drawn',
    viewFailedBody: 'Try again, or open another view.',
    stateTooltip: '{name}: {state}',
    roleShortSandbox: 'SBX',
    roleShortDevelopment: 'DEV',
    roleShortStaging: 'STG',
    roleShortProduction: 'PRD',
    b2cShort: 'b2c',
    openSetup: 'Open setup',
    attentionUnreadable: 'Setup unreadable',
    attentionConfigInvalid: 'dw.json invalid',
    attentionB2c: 'b2c not found',
    attentionPiece: 'Piece failed',
    attentionConfigMissing: 'No dw.json',
    attentionIncomplete: 'Incomplete environment',
    configMissingTitle: 'No dw.json',
    configMissingFix: 'Add one at the workspace root.',
    configInvalidTitle: 'dw.json cannot be read',
    configInvalidFix: 'It is not valid JSON.',
    pieces: 'Pieces',
    pieceDelivered: 'Available',
    pieceFailed: 'Not started',
    sectionFailedTitle: '{piece} could not start',
    sectionFailedBody: 'Close the panel and open it again.',
    roleSandbox: 'Sandbox',
    roleDevelopment: 'Development',
    roleStaging: 'Staging',
    roleProduction: 'Production',
    errorTitle: 'Something went wrong',
    'error.b2c_not_found': 'The b2c CLI was not found.',
    'error.b2c_failed': 'b2c ended with an error.',
    'error.b2c_timeout': 'b2c took too long and was stopped.',
    'error.no_version': 'b2c started but did not print its version.',
    'error.aborted': 'The command was cancelled.',
    'error.role_refused': 'That command is not allowed on this environment.',
    'error.role_required': 'That command needs an environment.',
    'error.role_not_configured': 'That environment is not configured in dw.json.',
    'error.credentials_missing': 'dw.json has no client id and secret for that environment.',
    'error.value_invalid': 'A value of dw.json holds a character that cannot be used.',
    'error.flag_not_allowed': 'A command option was refused.',
    'error.unsafe_argument': 'A command argument was refused.',
    'error.cwd_not_found': 'The folder to run b2c in does not exist.',
    'error.config_invalid': 'The dw.json file could not be read.',
    'error.timeout': 'The plugin took too long to answer.',
    'error.action_failed': 'The action could not be completed.',
    'error.unknown': 'Unexpected error ({code}).'
  },
  {
    setup: 'Configuración',
    refresh: 'Actualizar',
    loading: 'Leyendo la configuración',
    recheck: 'Comprobar',
    b2c: 'CLI b2c',
    b2cFound: 'Encontrado, versión {version}',
    b2cFoundNoVersion: 'Encontrado',
    b2cMissing: 'No encontrado',
    b2cMissingTitle: 'b2c no encontrado',
    b2cMissingFix: 'Instálalo o indica b2c path en Ajustes.',
    instances: 'Entornos',
    roleReady: 'Listo',
    roleIncomplete: 'Incompleto',
    roleAbsent: 'Sin configurar',
    incompleteReason: 'Sin credenciales válidas',
    absentReason: 'Sin host en dw.json',
    configFile: 'Fichero dw.json',
    configReadFrom: 'Origen',
    configFromWorkspace: 'Workspace',
    configFromSetting: 'Fichero de Ajustes',
    configState: 'Estado',
    configOk: 'Leído',
    configMissing: 'No encontrado',
    configInvalid: 'No es JSON válido',
    settingsHint: 'Rutas y sufijos de claves: Ajustes, SFCC Tools.',
    tryAgain: 'Reintentar',
    viewLoading: 'Cargando {piece}',
    viewFailedTitle: 'No se ha podido dibujar {piece}',
    viewFailedBody: 'Reinténtalo o abre otra vista.',
    stateTooltip: '{name}: {state}',
    roleShortSandbox: 'SBX',
    roleShortDevelopment: 'DEV',
    roleShortStaging: 'STG',
    roleShortProduction: 'PRD',
    b2cShort: 'b2c',
    openSetup: 'Abrir configuración',
    attentionUnreadable: 'Configuración ilegible',
    attentionConfigInvalid: 'dw.json no válido',
    attentionB2c: 'b2c no encontrado',
    attentionPiece: 'Pieza fallida',
    attentionConfigMissing: 'No hay dw.json',
    attentionIncomplete: 'Entorno incompleto',
    configMissingTitle: 'No hay dw.json',
    configMissingFix: 'Añade uno en la raíz del workspace.',
    configInvalidTitle: 'No se puede leer dw.json',
    configInvalidFix: 'No es JSON válido.',
    pieces: 'Piezas',
    pieceDelivered: 'Disponible',
    pieceFailed: 'No ha arrancado',
    sectionFailedTitle: '{piece} no ha podido arrancar',
    sectionFailedBody: 'Cierra el panel y vuelve a abrirlo.',
    roleSandbox: 'Sandbox',
    roleDevelopment: 'Desarrollo',
    roleStaging: 'Staging',
    roleProduction: 'Producción',
    errorTitle: 'Algo ha fallado',
    'error.b2c_not_found': 'No se ha encontrado el CLI b2c.',
    'error.b2c_failed': 'b2c ha terminado con un error.',
    'error.b2c_timeout': 'b2c ha tardado demasiado y se ha detenido.',
    'error.no_version': 'b2c ha arrancado pero no ha mostrado su versión.',
    'error.aborted': 'Se ha cancelado la orden.',
    'error.role_refused': 'Esa orden no está permitida en este entorno.',
    'error.role_required': 'Esa orden necesita un entorno.',
    'error.role_not_configured': 'Ese entorno no está configurado en dw.json.',
    'error.credentials_missing': 'dw.json no tiene client id y secret para ese entorno.',
    'error.value_invalid': 'Un valor de dw.json tiene un carácter no válido.',
    'error.flag_not_allowed': 'Se ha rechazado una opción de la orden.',
    'error.unsafe_argument': 'Se ha rechazado un argumento de la orden.',
    'error.cwd_not_found': 'La carpeta donde ejecutar b2c no existe.',
    'error.config_invalid': 'No se ha podido leer el fichero dw.json.',
    'error.timeout': 'El plugin ha tardado demasiado en responder.',
    'error.action_failed': 'No se ha podido completar la acción.',
    'error.unknown': 'Error inesperado ({code}).'
  }
)

export type CoreMessageKey = keyof (typeof CORE_MESSAGES)['en']

/** Worker errors travel as their code; the panel words them with this. */
export function wordError(locale: string, code: string): string {
  const key = `error.${code}`
  return key in CORE_MESSAGES.en ? t(CORE_MESSAGES, locale, key as CoreMessageKey) : t(CORE_MESSAGES, locale, 'error.unknown', { code })
}
