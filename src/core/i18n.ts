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
    b2c: 'b2c CLI',
    b2cFound: 'Found, version {version}',
    b2cFoundNoVersion: 'Found',
    b2cMissing: 'Not found',
    b2cMissingTitle: 'The b2c CLI is not available',
    b2cMissingBody: 'Install it, or set its path in Settings → SFCC Tools → b2c path.',
    instances: 'Environments',
    roleReady: 'Ready',
    roleIncomplete: 'Incomplete',
    roleAbsent: 'Not configured',
    incompleteHint: 'Incomplete: dw.json has the host, but no credentials b2c can use (a client id and secret; the sandbox may use a user and password).',
    absentHint: 'Not configured: dw.json has no host for it. The sandbox uses the plain keys; the others the same keys with their suffix (Settings → SFCC Tools).',
    configFile: 'Configuration file',
    configReadFrom: 'Read from',
    configFromWorkspace: 'Workspace dw.json',
    configFromSetting: 'File in Settings',
    configFromWorkspaceHint: 'dw.json at the root of the workspace that uploads, or of the focused one while none does; a worktree without one uses its main checkout’s.',
    configFromSettingHint: 'The file named in Settings → SFCC Tools → Configuration file.',
    configFromUnknownHint: 'dw.json at the root of the workspace, or the file named in Settings → SFCC Tools → Configuration file.',
    configState: 'State',
    configOk: 'Read',
    configMissing: 'Not found',
    configInvalid: 'Not valid JSON',
    neverShown: 'Hosts and credentials are never shown.',
    views: 'Views',
    tryAgain: 'Try again',
    emptyTitle: 'Nothing to show yet',
    emptyGuidance: 'This piece has nothing to show at the moment.',
    roleShortSandbox: 'SBX',
    roleShortDevelopment: 'DEV',
    roleShortStaging: 'STG',
    roleShortProduction: 'PRD',
    b2cShort: 'b2c {version}',
    attentionUnreadable: 'Setup unreadable',
    attentionConfigInvalid: 'dw.json invalid',
    attentionB2c: 'b2c not found',
    attentionPiece: 'A piece did not start',
    attentionConfigMissing: 'No dw.json',
    attentionIncomplete: 'Incomplete environment',
    configMissingTitle: 'No dw.json',
    configMissingBody: 'No dw.json was found for the workspace. Add one at its root, or set another file in Settings → SFCC Tools → Configuration file.',
    configInvalidTitle: 'dw.json cannot be read',
    configInvalidBody: 'The file is not valid JSON, so no environment can be read from it.',
    pieces: 'Pieces',
    pieceDelivered: 'Available',
    pieceFailed: 'Not started',
    sectionFailedTitle: '{piece} could not start',
    sectionFailedBody: 'Its part of this panel failed to start, so it is not shown. Close the panel and open it again.',
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
    'error.value_invalid': 'A value of dw.json for that environment holds a character that cannot be used.',
    'error.flag_not_allowed': 'A command option was refused: it is not one the plugin may pass to b2c.',
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
    b2c: 'CLI b2c',
    b2cFound: 'Encontrado, versión {version}',
    b2cFoundNoVersion: 'Encontrado',
    b2cMissing: 'No encontrado',
    b2cMissingTitle: 'El CLI b2c no está disponible',
    b2cMissingBody: 'Instálalo o indica su ruta en Ajustes → SFCC Tools → b2c path.',
    instances: 'Entornos',
    roleReady: 'Listo',
    roleIncomplete: 'Incompleto',
    roleAbsent: 'Sin configurar',
    incompleteHint: 'Incompleto: dw.json tiene el host, pero no credenciales que b2c pueda usar (client id y secret; el sandbox admite usuario y contraseña).',
    absentHint: 'Sin configurar: dw.json no tiene host para él. El sandbox usa las claves sin sufijo; los demás, las mismas claves con su sufijo (Ajustes → SFCC Tools).',
    configFile: 'Fichero de configuración',
    configReadFrom: 'Se lee de',
    configFromWorkspace: 'dw.json del workspace',
    configFromSetting: 'Fichero de Ajustes',
    configFromWorkspaceHint: 'dw.json en la raíz del workspace que sube, o del enfocado mientras ninguno sube; un worktree sin él usa el del checkout principal.',
    configFromSettingHint: 'El fichero indicado en Ajustes → SFCC Tools → Configuration file.',
    configFromUnknownHint: 'dw.json en la raíz del workspace, o el fichero indicado en Ajustes → SFCC Tools → Configuration file.',
    configState: 'Estado',
    configOk: 'Leído',
    configMissing: 'No encontrado',
    configInvalid: 'No es JSON válido',
    neverShown: 'Nunca se muestran hosts ni credenciales.',
    views: 'Vistas',
    tryAgain: 'Reintentar',
    emptyTitle: 'Nada que mostrar todavía',
    emptyGuidance: 'Esta pieza no tiene nada que mostrar ahora mismo.',
    roleShortSandbox: 'SBX',
    roleShortDevelopment: 'DEV',
    roleShortStaging: 'STG',
    roleShortProduction: 'PRD',
    b2cShort: 'b2c {version}',
    attentionUnreadable: 'Configuración ilegible',
    attentionConfigInvalid: 'dw.json no válido',
    attentionB2c: 'b2c no encontrado',
    attentionPiece: 'Una pieza no ha arrancado',
    attentionConfigMissing: 'No hay dw.json',
    attentionIncomplete: 'Entorno incompleto',
    configMissingTitle: 'No hay dw.json',
    configMissingBody: 'No se ha encontrado un dw.json para el workspace. Añade uno en su raíz o indica otro fichero en Ajustes → SFCC Tools → Configuration file.',
    configInvalidTitle: 'No se puede leer dw.json',
    configInvalidBody: 'El fichero no es JSON válido, así que no se puede leer ningún entorno de él.',
    pieces: 'Piezas',
    pieceDelivered: 'Disponible',
    pieceFailed: 'No ha arrancado',
    sectionFailedTitle: '{piece} no ha podido arrancar',
    sectionFailedBody: 'Su parte de este panel ha fallado al arrancar, así que no se muestra. Cierra el panel y vuelve a abrirlo.',
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
    'error.value_invalid': 'Un valor de dw.json para ese entorno contiene un carácter que no se puede usar.',
    'error.flag_not_allowed': 'Se ha rechazado una opción de la orden: no es una de las que el plugin puede pasar a b2c.',
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
