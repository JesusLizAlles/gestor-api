// Herramientas que el servidor MCP ofrece a un agente. No saben nada de HTTP ni de JSON-RPC:
// reciben argumentos ya parseados y devuelven texto, para poder probarlas con un backend falso.
import { z } from 'zod'
import type { ApiSummary, Endpoint, McpAccess, RequestEcho, SendResult } from '@shared/types'
import { folderLabel } from '@shared/folders'
import { callInlineFields, defaultValues } from '@shared/request'
import { inlineDefault, inlineValueKey } from '@shared/template'
import { paramKey } from '@shared/url'

/** Lo que el agente pide al lanzar un endpoint, ya convertido al formato del formulario de la app. */
export interface CallInput {
  values: Record<string, string>
  body: string
  /** Variables de la API solo para esta llamada. */
  variables: Record<string, string>
}

/** Lo que las herramientas necesitan del resto de la app. */
export interface ToolBackend {
  /** APIs guardadas con su acceso efectivo (ya recortado en producción). */
  apis(): Promise<{ api: ApiSummary; access: McpAccess }[]>
  /** La petición tal como saldría (secretos tapados) y lo que impide enviarla. */
  preview(api: ApiSummary, endpoint: Endpoint, input: CallInput): { request: RequestEcho; problems: string[] }
  send(api: ApiSummary, endpoint: Endpoint, input: CallInput): Promise<SendResult>
  /** Pide al usuario que apruebe una llamada que modifica; false si la rechaza o no responde a tiempo. */
  approve(api: ApiSummary, endpoint: Endpoint, request: RequestEcho): Promise<boolean>
}

/** Error que se le explica al agente (isError en la respuesta), no un fallo del servidor. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly outcome: 'error' | 'blocked' | 'rejected' = 'error'
  ) {
    super(message)
  }
}

export interface ToolCallInfo {
  api: string | null
  summary: string
}

interface ToolSpec<S extends z.ZodType> {
  name: string
  title: string
  description: string
  input: S
  readOnly: boolean
  destructive?: boolean
  /** Para el registro de actividad: API y resumen de lo pedido. */
  describe(args: z.infer<S>): ToolCallInfo
  run(args: z.infer<S>, backend: ToolBackend): Promise<unknown>
}

const ACCESS_TEXT: Record<McpAccess, string> = {
  off: 'sin acceso',
  read: 'solo endpoints que no modifican datos',
  confirm: 'todos los endpoints; los que modifican datos los aprueba el usuario',
  write: 'todos los endpoints sin confirmación'
}

/** Tope del cuerpo de respuesta que se devuelve al agente (caracteres). */
const MAX_RESPONSE_CHARS = 100_000
const MAX_DESCRIPTION_CHARS = 8000
const MAX_LISTED = 500

const apiArg = z.string().min(1).max(255).describe('Nombre (o id) de la API, tal como lo devuelve list_apis')
const endpointArg = z.string().min(1).max(300).describe('Nombre (o id) del endpoint, tal como lo devuelve list_endpoints')
const scalar = z.union([z.string().max(200_000), z.number(), z.boolean()])

async function findApi(backend: ToolBackend, wanted: string): Promise<{ api: ApiSummary; access: McpAccess }> {
  const visible = (await backend.apis()).filter((a) => a.access !== 'off')
  const byId = visible.find((a) => a.api.id === wanted)
  if (byId) return byId
  const matches = visible.filter((a) => a.api.name.toLowerCase() === wanted.trim().toLowerCase())
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) throw new ToolError(`Hay varias APIs llamadas «${wanted}»: usa su id (${matches.map((m) => m.api.id).join(', ')})`)
  const names = visible.map((a) => `«${a.api.name}»`).join(', ')
  throw new ToolError(`No hay ninguna API «${wanted}» a la que tengas acceso.` + (names ? ` Disponibles: ${names}.` : ' El usuario no ha dado acceso a ninguna.'))
}

function findEndpoint(api: ApiSummary, wanted: string): Endpoint {
  const byId = api.endpoints.find((e) => e.id === wanted)
  if (byId) return byId
  const needle = wanted.trim().toLowerCase()
  const matches = api.endpoints.filter((e) => e.name.toLowerCase() === needle)
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new ToolError(`Hay varios endpoints «${wanted}» en ${api.name}: usa su id (${matches.map((e) => `${e.id} en ${folderLabel(api.folders, e.folderId) || 'la raíz'}`).join(', ')})`)
  }
  const similar = api.endpoints.filter((e) => e.name.toLowerCase().includes(needle)).slice(0, 15)
  throw new ToolError(
    `No hay ningún endpoint «${wanted}» en ${api.name}.` +
      (similar.length ? ` Parecidos: ${similar.map((e) => `«${e.name}»`).join(', ')}.` : ' Usa list_endpoints para ver los que hay.')
  )
}

const firstLine = (text: string | undefined, max = 200) => {
  const line = (text ?? '').split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… [recortado: ${text.length} caracteres]` : text)

/**
 * Convierte lo que manda el agente al formulario de la app: parámetros por nombre (o «in:nombre»),
 * campos {{tipo.nombre}} por nombre, el cuerpo y las variables. Lo que no se indica se queda con
 * su valor por defecto, igual que al abrir la ficha en la app.
 */
export function buildCallInput(
  api: ApiSummary,
  endpoint: Endpoint,
  args: { params?: Record<string, string | number | boolean>; body?: unknown; variables?: Record<string, string | number> }
): CallInput {
  const body = args.body === undefined ? (endpoint.body.example ?? '') : typeof args.body === 'string' ? args.body : JSON.stringify(args.body, null, 2)
  const values = defaultValues(api, endpoint)
  const fields = callInlineFields(api, endpoint, { values, body })
  for (const f of fields) values[inlineValueKey(f.key)] = inlineDefault(f.kind)

  const unknown: string[] = []
  for (const [name, raw] of Object.entries(args.params ?? {})) {
    const value = String(raw)
    const byKey = endpoint.params.find((p) => paramKey(p) === name)
    const byName = endpoint.params.filter((p) => p.name === name)
    const field = fields.find((f) => f.name === name || f.key === name)
    if (byKey) values[paramKey(byKey)] = value
    else if (byName.length === 1) values[paramKey(byName[0]!)] = value
    else if (byName.length > 1) throw new ToolError(`El parámetro «${name}» está en varios sitios: usa ${byName.map((p) => `«${paramKey(p)}»`).join(' o ')}`)
    else if (field) values[inlineValueKey(field.key)] = value
    else unknown.push(name)
  }
  if (unknown.length) {
    const known = [...endpoint.params.map((p) => p.name), ...fields.map((f) => f.name)]
    throw new ToolError(
      `Parámetros que este endpoint no tiene: ${unknown.join(', ')}. ` +
        (known.length ? `Admite: ${known.join(', ')}.` : 'No pide ninguno: los datos van en body.') +
        ' Para cambiar el cuerpo, manda body completo.'
    )
  }
  const variables = Object.fromEntries(Object.entries(args.variables ?? {}).map(([k, v]) => [k, String(v)]))
  return { values, body, variables }
}

function formatResult(result: SendResult) {
  const response = result.response
  let body: unknown
  let truncated: string | undefined
  if (response) {
    if (response.binary) body = `[contenido binario de ${response.size} bytes (${response.contentType ?? 'tipo desconocido'}): no se devuelve]`
    else {
      try {
        body = JSON.parse(response.body)
        if (response.body.length > MAX_RESPONSE_CHARS) {
          body = clip(response.body, MAX_RESPONSE_CHARS)
          truncated = 'La respuesta es muy grande y se ha cortado: pide menos datos (filtros, límites, paginación)'
        }
      } catch {
        body = clip(response.body, MAX_RESPONSE_CHARS)
      }
      if (response.truncated) truncated = 'La respuesta pasaba del máximo de la app y llegó cortada'
    }
  }
  return {
    success: result.success,
    ...(result.message ? { message: result.message } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(response ? { status: response.status, status_text: response.statusText, content_type: response.contentType ?? null } : {}),
    duration_ms: result.durationMs,
    request: { method: result.request.method, url: result.request.url, ...(result.request.body ? { body: result.request.body } : {}) },
    ...(response ? { response: body } : {}),
    ...(truncated ? { truncated } : {})
  }
}

function define<S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec
}

const tools = [
  define({
    name: 'list_apis',
    title: 'APIs disponibles',
    description:
      'Lista las APIs a las que el usuario te ha dado acceso en Gestor API: entorno (dev, test, prod), nivel de acceso, ' +
      'número de endpoints y sus variables (por ejemplo un listado de hoteles con el elegido ahora). Empieza siempre por aquí.',
    input: z.object({}),
    readOnly: true,
    describe: () => ({ api: null, summary: '' }),
    async run(_args, backend) {
      const list = (await backend.apis()).filter((a) => a.access !== 'off')
      return {
        apis: list.map(({ api, access }) => ({
          name: api.name,
          id: api.id,
          ...(api.description ? { description: api.description } : {}),
          environment: api.environment,
          base_url: api.baseUrl,
          access,
          access_description: ACCESS_TEXT[access],
          endpoints: api.endpoints.length,
          variables: api.variables.map((v) => ({
            name: v.name,
            ...(v.description ? { description: v.description } : {}),
            current: v.value,
            ...(v.options ? { options: v.options.map((o) => ({ label: o.label, value: o.value })) } : {})
          }))
        }))
      }
    }
  }),
  define({
    name: 'list_endpoints',
    title: 'Endpoints de una API',
    description:
      'Lista los endpoints de una API con su carpeta, método, si modifican datos y la primera línea de su descripción. ' +
      'Se puede filtrar por carpeta o por un texto que aparezca en el nombre, la ruta, la carpeta o la descripción.',
    input: z.object({
      api: apiArg,
      folder: z.string().max(300).optional().describe('Solo los de esta carpeta (y sus subcarpetas), p. ej. «Informes»'),
      search: z.string().max(200).optional().describe('Texto a buscar (sin distinguir mayúsculas)')
    }),
    readOnly: true,
    describe: (a) => ({ api: a.api, summary: [a.folder, a.search].filter(Boolean).join(' · ') }),
    async run(args, backend) {
      const { api, access } = await findApi(backend, args.api)
      const folder = args.folder?.trim().toLowerCase()
      const search = args.search?.trim().toLowerCase()
      const found = api.endpoints
        .map((e) => ({ e, folder: folderLabel(api.folders, e.folderId) }))
        .filter(({ folder: label }) => !folder || label.toLowerCase().startsWith(folder) || label.toLowerCase().split(' / ').includes(folder))
        .filter(({ e, folder: label }) => !search || `${e.name} ${e.path} ${label} ${e.description ?? ''}`.toLowerCase().includes(search))
      return {
        api: api.name,
        endpoints: found.slice(0, MAX_LISTED).map(({ e, folder: label }) => ({
          name: e.name,
          id: e.id,
          folder: label || null,
          method: e.method,
          modifies: Boolean(e.modifies),
          ...(e.modifies && access === 'read' ? { allowed: false } : {}),
          summary: firstLine(e.description)
        })),
        ...(found.length > MAX_LISTED ? { truncated: `Hay ${found.length}; solo se devuelven ${MAX_LISTED}. Filtra por carpeta o texto` } : {}),
        folders: [...new Set(api.folders.map((f) => folderLabel(api.folders, f.id)))]
      }
    }
  }),
  define({
    name: 'describe_endpoint',
    title: 'Detalle de un endpoint',
    description:
      'Qué hace un endpoint y cómo llamarlo: su descripción, los parámetros (ruta, consulta, cabecera o cuerpo), los campos ' +
      '{{tipo.nombre}} de su cuerpo (fechas, números…) con su valor por defecto, los valores fijos, el cuerpo de ejemplo y ' +
      'la petición que saldría ahora mismo (con las credenciales tapadas). Léelo antes de call_endpoint.',
    input: z.object({ api: apiArg, endpoint: endpointArg }),
    readOnly: true,
    describe: (a) => ({ api: a.api, summary: a.endpoint }),
    async run(args, backend) {
      const { api, access } = await findApi(backend, args.api)
      const endpoint = findEndpoint(api, args.endpoint)
      const input = buildCallInput(api, endpoint, {})
      const fields = callInlineFields(api, endpoint, input)
      const { request, problems } = backend.preview(api, endpoint, input)
      return {
        name: endpoint.name,
        id: endpoint.id,
        folder: folderLabel(api.folders, endpoint.folderId) || null,
        method: endpoint.method,
        path: endpoint.path,
        modifies: Boolean(endpoint.modifies),
        can_call: !(endpoint.modifies && access === 'read'),
        ...(endpoint.modifies && access === 'confirm' ? { needs_approval: true } : {}),
        description: clip(endpoint.description ?? '', MAX_DESCRIPTION_CHARS),
        params: endpoint.params.map((p) => ({
          name: p.name,
          in: p.in,
          key: paramKey(p),
          type: p.type,
          required: p.required,
          ...(p.description ? { description: p.description } : {}),
          ...(p.example ? { example: p.example } : {}),
          ...(p.options ? { options: p.options } : {}),
          ...(p.optionsFrom ? { options_from_variable: p.optionsFrom } : {})
        })),
        fields: fields.map((f) => ({ name: f.name, placeholder: `{{${f.key}}}`, kind: f.kind, default: inlineDefault(f.kind) })),
        fixed_values: endpoint.vars,
        body_kind: endpoint.body.kind,
        body_example: endpoint.body.example ?? null,
        ...(api.bodyTemplate && endpoint.body.useTemplate !== false
          ? { body_template: api.bodyTemplate, body_template_note: 'El cuerpo que mandes va dentro de esta plantilla de la API, en el hueco {{body}}' }
          : {}),
        request_preview: request,
        ...(problems.length ? { problems } : {}),
        how_to_call:
          'call_endpoint con params para los parámetros y campos por su nombre (p. ej. {"start_date": "2026-11-01"}), ' +
          'body para sustituir el cuerpo entero (puede llevar {{variables}}; sin comillas mantienen el tipo) y variables ' +
          'para usar otro valor de una variable de la API solo en esta llamada (en un listado vale el nombre de la opción).'
      }
    }
  }),
  define({
    name: 'call_endpoint',
    title: 'Llamar a un endpoint',
    description:
      'Lanza un endpoint de la API con las credenciales guardadas en la app y devuelve el código HTTP, si fue bien (según la ' +
      'regla de respuesta de la API: algunas responden siempre 200 y el error va en el cuerpo), el mensaje y el cuerpo de la ' +
      'respuesta. Los endpoints que modifican datos solo se pueden lanzar con acceso de escritura y, con «confirm» o en ' +
      'producción, el usuario ve la petición y decide; si la rechaza, no insistas: pregunta qué quiere hacer.',
    input: z.object({
      api: apiArg,
      endpoint: endpointArg,
      params: z
        .record(z.string().max(300), scalar)
        .optional()
        .describe('Parámetros y campos {{tipo.nombre}} por nombre; los que no se indiquen llevan su valor por defecto'),
      body: z
        .union([z.string().max(5_000_000), z.record(z.string(), z.unknown()), z.array(z.unknown())])
        .optional()
        .describe('Cuerpo completo que sustituye al de ejemplo (objeto JSON o texto). Si no se indica, el de ejemplo'),
      variables: z
        .record(z.string().max(200), z.union([z.string().max(20000), z.number()]))
        .optional()
        .describe('Valores de variables de la API solo para esta llamada, p. ej. {"hotel_id": "Hotel Norte"}')
    }),
    readOnly: false,
    destructive: true,
    describe: (a) => ({ api: a.api, summary: [a.endpoint, a.variables && JSON.stringify(a.variables), a.params && JSON.stringify(a.params)].filter(Boolean).join(' ').slice(0, 300) }),
    async run(args, backend) {
      const { api, access } = await findApi(backend, args.api)
      const endpoint = findEndpoint(api, args.endpoint)
      if (endpoint.modifies && access === 'read') {
        throw new ToolError(`«${endpoint.name}» modifica datos y el usuario solo te ha dado acceso de consulta a ${api.name}`, 'blocked')
      }
      const input = buildCallInput(api, endpoint, args)
      let preview: ReturnType<ToolBackend['preview']>
      try {
        preview = backend.preview(api, endpoint, input)
      } catch (err) {
        throw new ToolError((err as Error).message)
      }
      if (preview.problems.length) throw new ToolError(`No se puede enviar: ${preview.problems.join('. ')}`)
      if (endpoint.modifies && access === 'confirm') {
        const approved = await backend.approve(api, endpoint, preview.request)
        if (!approved) throw new ToolError('El usuario no ha aprobado esta llamada: no se ha enviado nada', 'rejected')
      }
      const result = await backend.send(api, endpoint, input)
      const out = formatResult(result)
      if (!result.response) throw new ToolError(JSON.stringify(out))
      return out
    }
  })
] as const

export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}

/** Definiciones para tools/list (JSON Schema sacado de los esquemas zod). */
export function toolDefinitions(): ToolDefinition[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: schema,
      annotations: {
        title: t.title,
        readOnlyHint: t.readOnly,
        destructiveHint: Boolean(t.destructive),
        idempotentHint: t.readOnly,
        // call_endpoint habla con servicios de fuera.
        openWorldHint: !t.readOnly
      }
    }
  })
}

export interface ToolOutcome {
  text: string
  isError: boolean
  outcome: 'ok' | 'error' | 'blocked' | 'rejected'
  info: ToolCallInfo
}

/** Ejecuta una herramienta. Los fallos esperables vuelven como texto con isError, no como excepción. */
export async function callTool(name: string, rawArgs: unknown, backend: ToolBackend): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name) as ToolSpec<z.ZodType> | undefined
  if (!tool) throw new UnknownToolError(name)
  const parsed = tool.input.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'argumentos'}: ${i.message}`).join('; ')
    return { text: `Argumentos no válidos: ${issues}`, isError: true, outcome: 'error', info: { api: null, summary: '' } }
  }
  const info = tool.describe(parsed.data)
  try {
    const result = await tool.run(parsed.data, backend)
    return { text: JSON.stringify(result), isError: false, outcome: 'ok', info }
  } catch (err) {
    const outcome = err instanceof ToolError ? err.outcome : 'error'
    return { text: (err as Error).message, isError: true, outcome, info }
  }
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Herramienta desconocida: ${name}`)
  }
}
