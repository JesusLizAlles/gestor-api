// Montaje de una petición a partir de la API, el endpoint y lo que hay en el formulario.
// Es puro: el renderer lo usa para la vista previa (con los secretos tapados) y el proceso principal para enviar.

import {
  authSecrets,
  fieldSecret,
  METHODS_WITHOUT_BODY,
  type ApiConfig,
  type Endpoint,
  type EndpointParam,
  type HeaderEntry,
  type HttpMethod,
  type ResponseRule,
  type SecretKey
} from './types'
import { getPath, inlineFields, inlineValueKey, parseJsonTemplate, setPath, substitute, type InlineField, type Vars } from './template'
import { buildUrl, paramKey } from './url'

export interface PlanContext {
  /** Variables automáticas ($hoy…), calculadas una vez por llamada. */
  builtins: Vars
  /** Valores de los secretos, o una máscara para enseñarlos sin revelarlos. */
  secrets: Partial<Record<SecretKey, string>>
  /** Token OAuth 2.0 ya obtenido (o una máscara). */
  oauthToken?: string
}

export interface PlanInput {
  /** Valores del formulario por `paramKey`. */
  values: Record<string, string>
  /** Cuerpo tal como está en el editor. */
  body: string
}

export interface RequestPlan {
  method: HttpMethod
  url: string
  headers: HeaderEntry[]
  body?: string
  /** Datos obligatorios sin valor. */
  missing: string[]
  /** {{variables}} usadas que no existen. */
  unresolved: string[]
  /** Problemas que impiden enviar: JSON no válido, credencial sin guardar… */
  errors: string[]
}

export const SECRET_MASK = '••••••'

/** Valores con los que empieza el formulario de un endpoint: el ejemplo de cada parámetro (o el valor actual de su listado). */
export function defaultValues(api: ApiConfig, endpoint: Endpoint): Record<string, string> {
  return Object.fromEntries(
    endpoint.params.map((p) => {
      const list = p.optionsFrom ? api.variables.find((v) => v.name === p.optionsFrom) : undefined
      const fallback = list ? list.value : p.type === 'enum' ? (p.options?.[0] ?? '') : ''
      return [paramKey(p), p.example ?? fallback]
    })
  )
}

/**
 * La API con otros valores en sus variables, solo para una llamada (sin cambiar lo elegido en la app).
 * En un listado vale tanto el valor como el nombre de la opción («Hotel Norte»).
 */
export function withVariables<T extends ApiConfig>(api: T, overrides: Record<string, string> | undefined): T {
  if (!overrides || Object.keys(overrides).length === 0) return api
  const unknown = Object.keys(overrides).filter((name) => !api.variables.some((v) => v.name === name))
  if (unknown.length) {
    throw new Error(`Variables que no existen en ${api.name}: ${unknown.join(', ')}. Hay: ${api.variables.map((v) => v.name).join(', ') || 'ninguna'}`)
  }
  return {
    ...api,
    variables: api.variables.map((v) => {
      if (!Object.hasOwn(overrides, v.name)) return v
      const wanted = overrides[v.name]!
      const option = v.options?.find((o) => o.value === wanted) ?? v.options?.find((o) => o.label.trim().toLowerCase() === wanted.trim().toLowerCase())
      return { ...v, value: option ? option.value : wanted }
    })
  }
}

/** Campos {{tipo.nombre}} que pide una llamada: en el cuerpo, la ruta, las cabeceras, los valores fijos o la plantilla. */
export function callInlineFields(api: ApiConfig, endpoint: Endpoint, input: PlanInput): InlineField[] {
  return inlineFields(
    input.body,
    api.baseUrl,
    endpoint.path,
    api.bodyTemplate,
    ...api.headers.map((h) => h.value),
    ...endpoint.vars.map((v) => v.value),
    ...endpoint.params.map((p) => input.values[paramKey(p)])
  )
}

/** Variables de una llamada: las automáticas, las de la conexión, los campos {{tipo.nombre}} y los valores fijos del endpoint. */
export function requestVars(api: ApiConfig, endpoint: Endpoint, builtins: Vars, fields: Vars = {}): Vars {
  const vars: Vars = { ...builtins }
  for (const v of api.variables) vars[v.name] = v.value
  Object.assign(vars, fields)
  for (const v of endpoint.vars) vars[v.name] = substitute(v.value, vars)
  return vars
}

/** Valor con el tipo del parámetro: los números y sí/no viajan sin comillas en JSON. */
function typed(param: EndpointParam, value: string): unknown {
  if (param.type === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (param.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true'
  return value
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function base64Utf8(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const secretName = (key: SecretKey) => (key.startsWith('field:') ? key.slice('field:'.length) : key)

export function planRequest(api: ApiConfig, endpoint: Endpoint, input: PlanInput, ctx: PlanContext): RequestPlan {
  const missing: string[] = []
  // Campos {{tipo.nombre}}: con valor pasan a ser variables; vacíos, faltan (salvo el texto, que puede ir vacío).
  const fields: Vars = {}
  const inline = callInlineFields(api, endpoint, input)
  for (const f of inline) {
    const value = input.values[inlineValueKey(f.key)] ?? ''
    if (value !== '' || f.kind === 'text') fields[f.key] = value
    else missing.push(f.name)
  }
  const vars = requestVars(api, endpoint, ctx.builtins, fields)
  const unresolved = new Set<string>()
  const errors: string[] = []
  const method = endpoint.method

  // Valores del formulario con sus {{variables}} ya sustituidas.
  const resolved: Record<string, string> = {}
  for (const p of endpoint.params) resolved[paramKey(p)] = substitute(input.values[paramKey(p)] ?? '', vars, unresolved)
  const valueOf = (p: EndpointParam) => resolved[paramKey(p)] ?? ''

  for (const key of authSecrets(api.auth)) {
    if (ctx.secrets[key] === undefined) errors.push(`Falta guardar la credencial «${secretName(key)}» en la configuración de la API`)
  }
  const secret = (key: SecretKey) => ctx.secrets[key] ?? ''

  // Dirección: ruta y consulta del endpoint, {{variables}} y, si toca, la credencial en la URL.
  const built = buildUrl(api.baseUrl, endpoint.path, endpoint.params, resolved)
  missing.push(...built.missing)
  let url = substitute(built.url, vars, unresolved)
  const authQuery = new URLSearchParams()
  if (api.auth.type === 'apiKey' && api.auth.in === 'query') authQuery.append(api.auth.name, secret('apiKey'))
  if (api.auth.type === 'custom') {
    for (const f of api.auth.fields) if (f.in === 'query') authQuery.append(f.name, secret(fieldSecret(f.name)))
  }
  if (authQuery.size > 0) url += `${url.includes('?') ? '&' : '?'}${authQuery}`

  // Cabeceras: las comunes, las del endpoint y la autenticación (que manda sobre las anteriores).
  const headers: HeaderEntry[] = []
  const setHeader = (name: string, value: string) => {
    const index = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase())
    if (index >= 0) headers.splice(index, 1)
    headers.push({ name, value })
  }
  for (const h of api.headers) setHeader(h.name, substitute(h.value, vars, unresolved))
  for (const p of endpoint.params) {
    if (p.in !== 'header') continue
    if (valueOf(p) !== '') setHeader(p.name, valueOf(p))
    else if (p.required) missing.push(p.name)
  }
  switch (api.auth.type) {
    case 'bearer':
      setHeader('Authorization', `Bearer ${secret('token')}`)
      break
    case 'basic':
      setHeader('Authorization', `Basic ${base64Utf8(`${api.auth.username}:${secret('password')}`)}`)
      break
    case 'apiKey':
      if (api.auth.in === 'header') setHeader(api.auth.name, secret('apiKey'))
      break
    case 'oauth2':
      setHeader('Authorization', `Bearer ${ctx.oauthToken ?? ''}`)
      break
    case 'custom':
      for (const f of api.auth.fields) if (f.in === 'header') setHeader(f.name, secret(fieldSecret(f.name)))
      break
  }

  // Cuerpo.
  const bodyParams = endpoint.params.filter((p) => p.in === 'body')
  const authBody = api.auth.type === 'custom' ? api.auth.fields.filter((f) => f.in === 'body') : []
  const canHaveBody = !METHODS_WITHOUT_BODY.includes(method)
  const useTemplate = !!api.bodyTemplate?.trim() && endpoint.body.useTemplate !== false
  let kind = endpoint.body.kind
  if (kind === 'none' && canHaveBody && (bodyParams.length > 0 || authBody.length > 0 || useTemplate)) kind = 'json'
  for (const p of bodyParams) if (p.required && valueOf(p) === '') missing.push(p.name)

  let body: string | undefined
  let contentType: string | undefined
  if (kind !== 'none' && !canHaveBody) {
    errors.push(`Una petición ${method} no puede llevar cuerpo: cambia el método o quita el cuerpo`)
  } else if (kind === 'none' && (bodyParams.length > 0 || authBody.length > 0)) {
    errors.push(`Una petición ${method} no puede llevar datos en el cuerpo`)
  } else if (kind === 'json') {
    let content: unknown
    try {
      content = input.body.trim() ? parseJsonTemplate(input.body, vars, {}, unresolved) : {}
    } catch (err) {
      errors.push(`El cuerpo no es JSON válido: ${(err as Error).message}`)
    }
    if (content !== undefined) {
      const filled = bodyParams.filter((p) => valueOf(p) !== '')
      if (filled.length > 0 && !isObject(content)) errors.push('Los datos del cuerpo necesitan que el cuerpo sea un objeto JSON { … }')
      else for (const p of filled) setPath(content as Record<string, unknown>, p.name, typed(p, valueOf(p)))
      if (useTemplate) {
        try {
          content = parseJsonTemplate(api.bodyTemplate!, vars, { body: content }, unresolved)
        } catch (err) {
          errors.push(`La plantilla de cuerpo de la API no es JSON válido: ${(err as Error).message}`)
        }
      }
      if (authBody.length > 0 && !isObject(content)) errors.push('La credencial va en el cuerpo, pero el cuerpo no es un objeto JSON { … }')
      else for (const f of authBody) setPath(content as Record<string, unknown>, f.name, secret(fieldSecret(f.name)))
      body = JSON.stringify(content)
      contentType = 'application/json'
    }
  } else if (kind === 'form') {
    const form = new URLSearchParams()
    for (const line of input.body.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      const key = eq < 0 ? trimmed : trimmed.slice(0, eq).trim()
      form.append(key, substitute(eq < 0 ? '' : trimmed.slice(eq + 1).trim(), vars, unresolved))
    }
    for (const p of bodyParams) if (valueOf(p) !== '') form.set(p.name, valueOf(p))
    for (const f of authBody) form.set(f.name, secret(fieldSecret(f.name)))
    body = form.toString()
    contentType = 'application/x-www-form-urlencoded'
  }
  if (contentType && !headers.some((h) => h.name.toLowerCase() === 'content-type')) setHeader('Content-Type', contentType)

  for (const h of headers) {
    if (/[\r\n]/.test(h.value)) errors.push(`La cabecera ${h.name} no puede tener saltos de línea`)
  }
  if (!/^https?:\/\//i.test(url)) errors.push('La dirección tiene que empezar por http:// o https://')

  // Un campo vacío ya sale en «falta rellenar»: no se repite como variable sin definir.
  for (const f of inline) unresolved.delete(f.key)
  return { method, url, headers, body, missing: [...new Set(missing)], unresolved: [...unresolved], errors }
}

/** Texto de un valor del JSON de respuesta (para mensajes). */
function asText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * ¿Fue bien la llamada? Primero el código HTTP; después, si la API tiene regla de respuesta,
 * el valor que indique el cuerpo (para las APIs que responden siempre 200).
 */
export function evaluateResponse(
  rule: ResponseRule | undefined,
  status: number,
  statusText: string,
  body: string
): { success: boolean; message?: string } {
  let json: unknown
  let isJson = false
  if (rule) {
    try {
      json = JSON.parse(body)
      isJson = true
    } catch {
      // Se trata abajo.
    }
  }
  const message = rule?.messagePath && isJson ? asText(getPath(json, rule.messagePath)) : undefined
  if (status < 200 || status >= 300) return { success: false, message: message ?? `${status} ${statusText}`.trim() }
  if (!rule) return { success: true }
  if (!isJson) return { success: false, message: 'La respuesta no es JSON: no se puede comprobar si fue bien' }
  const actual = getPath(json, rule.successPath)
  const success = actual !== undefined && actual !== null && String(actual) === rule.successValue
  return { success, message: message ?? (success ? undefined : `${rule.successPath} = ${asText(actual) ?? '(sin valor)'}`) }
}
