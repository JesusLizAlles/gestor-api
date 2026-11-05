import type { AuthType, BodyKind, Environment, ParamLocation, ParamType, SecretKey } from '@shared/types'

// Textos de la interfaz para cada valor de los tipos compartidos.

export const ENV_LABEL: Record<Environment, string> = { dev: 'Desarrollo', test: 'Pruebas', prod: 'PRODUCCIÓN' }

export const AUTH_LABEL: Record<AuthType, string> = {
  none: 'Sin autenticación',
  bearer: 'Token (Bearer)',
  basic: 'Usuario y contraseña (Basic)',
  apiKey: 'Clave de API',
  oauth2: 'OAuth 2.0 (client credentials)'
}

/** Etiqueta corta para el panel lateral; null = no se pinta. */
export const AUTH_BADGE: Record<AuthType, string | null> = {
  none: null,
  bearer: 'Bearer',
  basic: 'Basic',
  apiKey: 'API key',
  oauth2: 'OAuth2'
}

export const SECRET_LABEL: Record<SecretKey, string> = {
  token: 'Token',
  password: 'Contraseña',
  apiKey: 'Clave',
  clientSecret: 'Client secret'
}

export const PARAM_IN_LABEL: Record<ParamLocation, string> = { path: 'Ruta', query: 'Consulta', header: 'Cabecera' }

/** Explicación de dónde va cada parámetro, para quien no conoce los términos. */
export const PARAM_IN_HELP: Record<ParamLocation, string> = {
  path: 'Forma parte de la dirección: /reservas/{id}',
  query: 'Va al final de la dirección: ?fecha=2026-11-05',
  header: 'Viaja en las cabeceras de la petición'
}

export const PARAM_TYPE_LABEL: Record<ParamType, string> = {
  string: 'Texto',
  number: 'Número',
  boolean: 'Sí / No',
  date: 'Fecha',
  enum: 'Lista de valores'
}

export const BODY_LABEL: Record<BodyKind, string> = { none: 'Sin cuerpo', json: 'JSON', form: 'Formulario (clave=valor)' }
