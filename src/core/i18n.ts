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

/** Core's own texts: the panel's setup section and the worker errors the panel words. */
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
    configured: 'Configured',
    notConfigured: 'Not configured',
    instancesHint: 'Read from the workspace’s dw.json. Hosts and credentials are never shown.',
    pieces: 'Pieces',
    pieceComing: 'Coming',
    roleSandbox: 'Sandbox',
    roleDevelopment: 'Development',
    roleStaging: 'Staging',
    roleProduction: 'Production',
    pieceIsml: 'ISML',
    pieceSandbox: 'Sandbox and upload',
    pieceErrors: 'Errors',
    pieceDebugger: 'Debugger',
    pieceEngine: 'Analysis',
    pieceEditor: 'Editor',
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
    'error.unsafe_argument': 'A command argument was refused.',
    'error.config_invalid': 'The dw.json file could not be read.',
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
    configured: 'Configurado',
    notConfigured: 'Sin configurar',
    instancesHint: 'Se lee del dw.json del workspace. Nunca se muestran hosts ni credenciales.',
    pieces: 'Piezas',
    pieceComing: 'Próximamente',
    roleSandbox: 'Sandbox',
    roleDevelopment: 'Desarrollo',
    roleStaging: 'Staging',
    roleProduction: 'Producción',
    pieceIsml: 'ISML',
    pieceSandbox: 'Sandbox y subida',
    pieceErrors: 'Errores',
    pieceDebugger: 'Depurador',
    pieceEngine: 'Análisis',
    pieceEditor: 'Editor',
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
    'error.unsafe_argument': 'Se ha rechazado un argumento de la orden.',
    'error.config_invalid': 'No se ha podido leer el fichero dw.json.',
    'error.unknown': 'Error inesperado ({code}).'
  }
)

export type CoreMessageKey = keyof (typeof CORE_MESSAGES)['en']

/** Worker errors travel as their code; the panel words them with this. */
export function wordError(locale: string, code: string): string {
  const key = `error.${code}`
  return key in CORE_MESSAGES.en ? t(CORE_MESSAGES, locale, key as CoreMessageKey) : t(CORE_MESSAGES, locale, 'error.unknown', { code })
}
