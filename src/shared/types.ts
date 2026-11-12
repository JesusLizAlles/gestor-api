// Tipos compartidos entre el proceso principal y el renderer.

export type Environment = 'dev' | 'test' | 'prod'

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

/** Métodos que no admiten cuerpo. */
export const METHODS_WITHOUT_BODY: readonly HttpMethod[] = ['GET', 'HEAD']

/**
 * Secretos de una API: van cifrados al llavero del sistema, nunca a apis.json.
 * `field:<nombre>` son los de la autenticación con campos personalizados.
 */
export type SecretKey = 'token' | 'password' | 'apiKey' | 'clientSecret' | `field:${string}`

/** string = nuevo valor; null = borrar; ausente = no tocar. */
export type SecretsPatch = Partial<Record<SecretKey, string | null>>

export interface SecretStorageStatus {
  /** true si los secretos se cifran con el llavero del sistema y se guardan en disco. */
  persistent: boolean
  backend: string
}

export type AuthFieldLocation = 'header' | 'query' | 'body'

/** Un dato secreto que la API pide en cada llamada: access_token en el cuerpo, X-Tenant en una cabecera… */
export interface AuthField {
  /** Nombre de la cabecera o del parámetro; en el cuerpo admite puntos para anidar (auth.token). */
  name: string
  in: AuthFieldLocation
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
  /** Uno o varios secretos con nombre, cada uno en la cabecera, la URL o el cuerpo. Secretos: `field:<nombre>`. */
  | { type: 'custom'; fields: AuthField[] }

export type AuthType = AuthConfig['type']

export const fieldSecret = (name: string): SecretKey => `field:${name}`

/** Secretos que usa una configuración de autenticación. */
export function authSecrets(auth: AuthConfig): SecretKey[] {
  switch (auth.type) {
    case 'none':
      return []
    case 'bearer':
      return ['token']
    case 'basic':
      return ['password']
    case 'apiKey':
      return ['apiKey']
    case 'oauth2':
      return ['clientSecret']
    case 'custom':
      return [...new Set(auth.fields.map((f) => fieldSecret(f.name)))]
  }
}

export interface HeaderEntry {
  name: string
  value: string
}

/** Par nombre = valor genérico (valores fijos de un endpoint). */
export type NameValue = HeaderEntry

export interface VariableOption {
  /** Lo que se ve: «Hotel Punta Negra». */
  label: string
  /** Lo que se envía: 100001. */
  value: string
}

/**
 * Variable de la conexión: se usa como {{nombre}} en la URL, las cabeceras, el cuerpo y los parámetros.
 * Con `options` es un listado: se elige un valor por su nombre (los hoteles dados de alta, por ejemplo).
 */
export interface ApiVariable {
  name: string
  description?: string
  /** Valor actual; en un listado, el de la opción elegida. */
  value: string
  options?: VariableOption[]
}

/** Cómo saber si una llamada fue bien cuando la API responde siempre 200 y lo dice en el cuerpo. */
export interface ResponseRule {
  /** Ruta en el JSON de la respuesta: status, result.ok… */
  successPath: string
  /** Valor que indica éxito: success, true, 0… */
  successValue: string
  /** Ruta del mensaje que explica el resultado: message, error.description… */
  messagePath?: string
}

export type ParamLocation = 'path' | 'query' | 'header' | 'body'
export type ParamType = 'string' | 'number' | 'boolean' | 'date' | 'enum'

/** Un dato que pide el endpoint, explicado para quien no sabe de APIs. */
export interface EndpointParam {
  /** Nombre; en el cuerpo admite puntos para anidar (filters.hotel_id). */
  name: string
  in: ParamLocation
  type: ParamType
  required: boolean
  /** Qué significa, en lenguaje llano. */
  description?: string
  /** Valor de ejemplo; también es el valor inicial del formulario. Admite {{variables}}. */
  example?: string
  /** Valores posibles cuando `type` es `enum`. */
  options?: string[]
  /** En una lista: toma las opciones del listado de esta variable de la conexión. */
  optionsFrom?: string
}

export type BodyKind = 'none' | 'json' | 'form'

export interface EndpointBody {
  kind: BodyKind
  description?: string
  /** Cuerpo de ejemplo (JSON o clave=valor por línea). Admite {{variables}}. */
  example?: string
  /** false = no se envuelve en la plantilla de cuerpo de la conexión. Por defecto, sí. */
  useTemplate?: boolean
}

export interface Endpoint {
  id: string
  /** Nombre corto para la lista: «Buscar reservas». */
  name: string
  method: HttpMethod
  /** Ruta relativa a la URL base; los parámetros de ruta van entre llaves: /reservas/{id}. */
  path: string
  /** Carpeta en la que está (sin carpeta = en la raíz de la API). */
  folderId?: string
  /** Para qué sirve y cómo funciona. */
  description?: string
  params: EndpointParam[]
  body: EndpointBody
  /** Valores fijos del endpoint: variables que solo valen aquí (resource = booking, task = get…). */
  vars: NameValue[]
  /** Cambia datos en el servidor: se pide confirmación antes de enviar. */
  modifies?: boolean
}

/** Carpeta de endpoints; se pueden anidar. El orden del listado es el orden en pantalla. */
export interface Folder {
  id: string
  name: string
  /** Carpeta que la contiene (sin ella = en la raíz de la API). */
  parentId?: string
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
  variables: ApiVariable[]
  /**
   * Plantilla JSON que envuelve el cuerpo de cada endpoint. {{body}} sin comillas marca dónde va el cuerpo;
   * el resto de {{variables}} se sustituyen como en cualquier otro sitio.
   */
  bodyTemplate?: string
  responseRule?: ResponseRule
  /** Método y ruta con los que empiezan los endpoints nuevos. */
  endpointDefaults?: { method: HttpMethod; path: string }
  /** Tiempo máximo de espera de cada llamada (60 s si no se indica). */
  timeoutSeconds?: number
  folders: Folder[]
  endpoints: Endpoint[]
}

/** Lo que recibe el renderer: la configuración y qué secretos hay guardados (nunca su valor). */
export interface ApiSummary extends ApiConfig {
  storedSecrets: SecretKey[]
}

/** Al crear, sin id; los endpoints se gestionan aparte y se conservan al editar. */
export type ApiInput = Omit<ApiConfig, 'id' | 'endpoints' | 'folders'> & { id?: string }

/** Crear (sin id), renombrar o cambiar de sitio una carpeta. */
export interface FolderInput {
  id?: string
  name: string
  parentId?: string
}

/** Mover un endpoint o una carpeta (arrastrar y soltar). */
export interface MoveInput {
  kind: 'endpoint' | 'folder'
  id: string
  /** Carpeta de destino; null = raíz de la API. */
  parentId: string | null
  /** Posición entre sus hermanos del mismo tipo en el destino (sin contar el que se mueve); más allá del final = al final. */
  index: number
}

export interface SaveApiInput {
  config: ApiInput
  secrets?: SecretsPatch
}

export type EndpointInput = Omit<Endpoint, 'id' | 'vars'> & { id?: string; vars?: NameValue[] }

/** Lo que se pide al proceso principal para hacer una llamada. */
export interface SendRequestInput {
  /** Identificador de esta ejecución, para poder cancelarla. */
  runId: string
  apiId: string
  endpointId: string
  /** Valores del formulario por `paramKey` (in:nombre). */
  values: Record<string, string>
  /** Cuerpo tal como está en el editor. */
  body: string
  /** Valores de variables de la API solo para esta llamada (los usa el agente MCP). */
  variables?: Record<string, string>
}

/** La petición tal como salió, con los secretos tapados. */
export interface RequestEcho {
  method: HttpMethod
  url: string
  headers: HeaderEntry[]
  body?: string
}

export interface HttpResponse {
  status: number
  statusText: string
  headers: HeaderEntry[]
  /** Cuerpo como texto (vacío si es binario). */
  body: string
  /** Tamaño real en bytes. */
  size: number
  /** El cuerpo se cortó por ser demasiado grande. */
  truncated: boolean
  binary: boolean
  contentType?: string
}

export interface SendResult {
  runId: string
  request: RequestEcho
  durationMs: number
  /** Sin respuesta: error de red, tiempo agotado o cancelada. */
  error?: string
  response?: HttpResponse
  /** Según el código HTTP y, si la API la tiene, su regla de respuesta. */
  success: boolean
  /** Mensaje de la API (regla de respuesta) o explicación del fallo. */
  message?: string
}

export interface ExportConfigInput {
  apiIds: string[]
  /** Clave para cifrar las credenciales; null = exportar sin credenciales. */
  passphrase: string | null
}

/** Lo que trae un fichero de configuración, antes de importarlo. */
export interface ImportPreview {
  /** Identifica el fichero leído para importConfig (el renderer no pasa rutas). */
  token: string
  fileName: string
  exportedAt: string
  /** Trae credenciales, cifradas con la clave de quien exportó. */
  encrypted: boolean
  apis: { id: string; name: string; baseUrl: string; environment: Environment; endpoints: number; exists: boolean }[]
}

export interface ImportConfigInput {
  token: string
  apiIds: string[]
  /** null = importar sin credenciales. */
  passphrase: string | null
}

export interface ImportResult {
  added: number
  updated: number
  withSecrets: boolean
}

/**
 * Qué puede hacer un agente MCP con una API:
 * - off: no la ve;
 * - read: solo los endpoints que no modifican datos;
 * - confirm: también los que modifican, pero cada llamada la aprueba el usuario en la app;
 * - write: todo sin preguntar (en producción se queda en confirm).
 */
export type McpAccess = 'off' | 'read' | 'confirm' | 'write'

export interface McpSettings {
  enabled: boolean
  /** Puerto local (solo 127.0.0.1). */
  port: number
  /** Acceso por id de API; las que no aparecen, 'off'. */
  access: Record<string, McpAccess>
}

export interface McpActivity {
  id: string
  /** ISO 8601. */
  at: string
  tool: string
  api: string | null
  /** Endpoint o parámetros resumidos. */
  summary: string
  outcome: 'ok' | 'error' | 'blocked' | 'rejected'
  detail?: string
  durationMs: number
}

export interface McpState {
  settings: McpSettings
  /** Token que deben enviar los clientes (Authorization: Bearer …). */
  token: string
  running: boolean
  /** http://127.0.0.1:<puerto>/mcp cuando está en marcha. */
  url: string | null
  /** Por qué no arrancó (p. ej. puerto ocupado). */
  error: string | null
  /** Últimas llamadas del agente, de la más reciente a la más antigua. */
  activity: McpActivity[]
  logPath: string
  /** Llamadas que esperan aprobación. */
  pendingApprovals: string[]
}

/** Llamada de un agente que modifica datos y espera la aprobación del usuario. */
export interface McpApprovalRequest {
  id: string
  apiName: string
  environment: Environment
  endpointName: string
  /** La petición tal como saldría, con los secretos tapados. */
  request: RequestEcho
}

export const DEFAULT_MCP_PORT = 47331

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
  saveFolder(apiId: string, folder: FolderInput): Promise<ApiSummary>
  /** Borra la carpeta; lo que tenía dentro pasa a la carpeta de arriba. */
  deleteFolder(apiId: string, folderId: string): Promise<ApiSummary>
  moveItem(apiId: string, move: MoveInput): Promise<ApiSummary>
  /** Cambia el valor actual de una variable (la opción elegida de un listado). */
  setVariable(apiId: string, name: string, value: string): Promise<ApiSummary>
  sendRequest(input: SendRequestInput): Promise<SendResult>
  cancelRequest(runId: string): Promise<void>
  /** Guarda las APIs elegidas en un fichero; devuelve su ruta (null si se cancela). */
  exportConfig(input: ExportConfigInput): Promise<string | null>
  /** Pide un fichero y enseña lo que trae; null si se cancela. */
  previewImport(): Promise<ImportPreview | null>
  importConfig(input: ImportConfigInput): Promise<ImportResult>
  mcpState(): Promise<McpState>
  /** Cambia la configuración del servidor MCP (lo arranca, lo para o lo reinicia si hace falta). */
  mcpSaveSettings(settings: McpSettings): Promise<McpState>
  mcpRegenerateToken(): Promise<McpState>
  /** Guarda la extensión para Claude Desktop (.mcpb); devuelve su ruta (null si se cancela). */
  mcpCreateExtension(): Promise<string | null>
  /** Abre la última extensión guardada con Claude Desktop. */
  mcpOpenExtension(): Promise<void>
  mcpRespondApproval(id: string, approved: boolean): Promise<void>
  onMcpState(listener: (state: McpState) => void): () => void
  onMcpApproval(listener: (request: McpApprovalRequest) => void): () => void
  updaterState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  /** Cierra la app, instala la versión descargada y la vuelve a abrir. */
  installUpdate(): Promise<void>
  /** Suscripción a los cambios de estado del actualizador; devuelve la función para darse de baja. */
  onUpdateState(listener: (state: UpdateState) => void): () => void
}
