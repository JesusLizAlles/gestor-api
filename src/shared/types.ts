// Tipos compartidos entre el proceso principal y el renderer.

export type Environment = 'dev' | 'test' | 'prod'

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

/** Secretos de una API: van cifrados al llavero del sistema, nunca a apis.json. */
export type SecretKey = 'token' | 'password' | 'apiKey' | 'clientSecret'

/** string = nuevo valor; null = borrar; ausente = no tocar. */
export type SecretsPatch = Partial<Record<SecretKey, string | null>>

export interface SecretStorageStatus {
  /** true si los secretos se cifran con el llavero del sistema y se guardan en disco. */
  persistent: boolean
  backend: string
}

/**
 * Cómo se autentica la API. Los valores secretos (token, contraseña, clave) no están aquí:
 * se guardan aparte con `SecretKey`.
 */
export type AuthConfig =
  | { type: 'none' }
  /** Authorization: Bearer <token>. Secreto: `token`. */
  | { type: 'bearer' }
  /** Authorization: Basic base64(usuario:contraseña). Secreto: `password`. */
  | { type: 'basic'; username: string }
  /** Clave en una cabecera (X-API-Key…) o en la URL (?api_key=…). Secreto: `apiKey`. */
  | { type: 'apiKey'; name: string; in: 'header' | 'query' }
  /** OAuth 2.0 «client credentials»: se pide un token a `tokenUrl`. Secreto: `clientSecret`. */
  | { type: 'oauth2'; tokenUrl: string; clientId: string; scope?: string }

export type AuthType = AuthConfig['type']

/** Secretos que usa cada tipo de autenticación. */
export const AUTH_SECRETS: Record<AuthType, SecretKey[]> = {
  none: [],
  bearer: ['token'],
  basic: ['password'],
  apiKey: ['apiKey'],
  oauth2: ['clientSecret']
}

export interface HeaderEntry {
  name: string
  value: string
}

export type ParamLocation = 'path' | 'query' | 'header'
export type ParamType = 'string' | 'number' | 'boolean' | 'date' | 'enum'

/** Un dato que pide el endpoint, explicado para quien no sabe de APIs. */
export interface EndpointParam {
  name: string
  in: ParamLocation
  type: ParamType
  required: boolean
  /** Qué significa, en lenguaje llano. */
  description?: string
  /** Valor de ejemplo; también es el valor inicial del formulario. */
  example?: string
  /** Valores posibles cuando `type` es `enum`. */
  options?: string[]
}

export type BodyKind = 'none' | 'json' | 'form'

export interface EndpointBody {
  kind: BodyKind
  description?: string
  /** Cuerpo de ejemplo (JSON o clave=valor por línea). */
  example?: string
}

export interface Endpoint {
  id: string
  /** Nombre corto para la lista: «Buscar reservas». */
  name: string
  method: HttpMethod
  /** Ruta relativa a la URL base; los parámetros de ruta van entre llaves: /reservas/{id}. */
  path: string
  /** Carpeta en la que se agrupa en el panel lateral. */
  group?: string
  /** Para qué sirve y cómo funciona. */
  description?: string
  params: EndpointParam[]
  body: EndpointBody
}

export interface ApiConfig {
  id: string
  name: string
  description?: string
  /** https://api.ejemplo.com/v1 */
  baseUrl: string
  environment: Environment
  auth: AuthConfig
  /** Cabeceras que se envían en todas las llamadas. */
  headers: HeaderEntry[]
  endpoints: Endpoint[]
}

/** Lo que recibe el renderer: la configuración y qué secretos hay guardados (nunca su valor). */
export interface ApiSummary extends ApiConfig {
  storedSecrets: SecretKey[]
}

/** Al crear, sin id; los endpoints se gestionan aparte y se conservan al editar. */
export type ApiInput = Omit<ApiConfig, 'id' | 'endpoints'> & { id?: string }

export interface SaveApiInput {
  config: ApiInput
  secrets?: SecretsPatch
}

export type EndpointInput = Omit<Endpoint, 'id'> & { id?: string }

export type UpdateStatus = 'unsupported' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  /** Versión nueva disponible o descargada. */
  version?: string
  /** Notas de la versión en texto plano. */
  releaseNotes?: string
  releaseDate?: string
  /** 0–100 durante la descarga. */
  percent?: number
  error?: string
  /** Por qué esta instalación no se puede actualizar sola (desarrollo, Linux sin AppImage…). */
  reason?: string
  /** La comprobación la pidió el usuario: la interfaz enseña el resultado aunque no haya nada nuevo. */
  manual?: boolean
  /** La versión nueva se descarga desde el navegador y se instala a mano (macOS sin firmar). */
  manualInstall?: boolean
}

/** Lo que el preload expone como `window.api`. Cada método es un canal IPC (ver ipc.ts). */
export interface AppApi {
  secretStorageStatus(): Promise<SecretStorageStatus>
  listApis(): Promise<ApiSummary[]>
  saveApi(input: SaveApiInput): Promise<ApiSummary>
  deleteApi(id: string): Promise<void>
  /** Crea (sin id) o sustituye un endpoint de la API. */
  saveEndpoint(apiId: string, endpoint: EndpointInput): Promise<ApiSummary>
  deleteEndpoint(apiId: string, endpointId: string): Promise<ApiSummary>
  updaterState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  /** Cierra la app, instala la versión descargada y la vuelve a abrir. */
  installUpdate(): Promise<void>
  /** Suscripción a los cambios de estado del actualizador; devuelve la función para darse de baja. */
  onUpdateState(listener: (state: UpdateState) => void): () => void
}
