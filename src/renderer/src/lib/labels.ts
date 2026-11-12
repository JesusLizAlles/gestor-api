import type { AuthFieldLocation, AuthType, BodyKind, Environment, ParamLocation, ParamType, SecretKey } from '@shared/types'

// Textos de la interfaz para cada valor de los tipos compartidos.

export const ENV_LABEL: Record<Environment, string> = { dev: 'Desarrollo', test: 'Pruebas', prod: 'PRODUCCIÓN' }

export const AUTH_LABEL: Record<AuthType, string> = {
  none: 'Sin autenticación',
  bearer: 'Token (Bearer)',
  basic: 'Usuario y contraseña (Basic)',
  apiKey: 'Clave de API',
  oauth2: 'OAuth 2.0 (client credentials)',
  custom: 'Campos personalizados'
}

/** Etiqueta corta para el panel lateral; null = no se pinta. */
export const AUTH_BADGE: Record<AuthType, string | null> = {
  none: null,
  bearer: 'Bearer',
  basic: 'Basic',
  apiKey: 'API key',
  oauth2: 'OAuth2',
  custom: 'Claves'
}

const FIXED_SECRET_LABEL: Record<string, string> = {
  token: 'Token',
  password: 'Contraseña',
  apiKey: 'Clave',
  clientSecret: 'Client secret'
}

export const secretLabel = (key: SecretKey): string => (key.startsWith('field:') ? key.slice('field:'.length) : (FIXED_SECRET_LABEL[key] ?? key))

export const AUTH_FIELD_IN_LABEL: Record<AuthFieldLocation, string> = { header: 'En una cabecera', query: 'En la URL', body: 'En el cuerpo JSON' }

export const PARAM_IN_LABEL: Record<ParamLocation, string> = { path: 'Ruta', query: 'Consulta', header: 'Cabecera', body: 'Cuerpo' }

/** Explicación de dónde va cada parámetro, para quien no conoce los términos. */
export const PARAM_IN_HELP: Record<ParamLocation, string> = {
  path: 'Forma parte de la dirección: /reservas/{id}',
  query: 'Va al final de la dirección: ?fecha=2026-11-05',
  header: 'Viaja en las cabeceras de la petición',
  body: 'Va dentro del cuerpo JSON; usa puntos para anidar: filters.hotel_id'
}

/** Título de cada bloque del formulario en la ficha del endpoint. */
export const PARAM_IN_SECTION: Record<ParamLocation, string> = {
  path: 'Datos de la dirección',
  query: 'Filtros y opciones',
  header: 'Cabeceras',
  body: 'Datos del cuerpo'
}

export const PARAM_TYPE_LABEL: Record<ParamType, string> = {
  string: 'Texto',
  number: 'Número',
  boolean: 'Sí / No',
  date: 'Fecha',
  enum: 'Lista de valores'
}

export const BODY_LABEL: Record<BodyKind, string> = { none: 'Sin cuerpo', json: 'JSON', form: 'Formulario (clave=valor)' }

/** Tamaño legible: 1,2 KB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString('es', { maximumFractionDigits: 1 })} ${units[unit]}`
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toLocaleString('es', { maximumFractionDigits: 2 })} s`
}
