import { randomUUID } from 'node:crypto'
import { type ApiConfig, type HttpResponse, type SecretKey, type SendRequestInput, type SendResult } from '@shared/types'
import { evaluateResponse, planRequest, SECRET_MASK, type PlanContext } from '@shared/request'
import { builtinVars } from '@shared/template'
import type { ApiStore } from './store/apis'
import type { SecretVault } from './store/secrets'

/** Lo justo de fetch que usamos: en la app es net.fetch de Electron (proxy y certificados del sistema). */
export type FetchFn = (url: string, init: { method: string; headers: [string, string][]; body?: string; signal: AbortSignal }) => Promise<Response>

/** Más allá de esto el cuerpo de la respuesta se corta: la interfaz no podría con él. */
const MAX_BODY_BYTES = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 60

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|[\w.+-]+\+(json|xml)))|charset=/i

interface CachedToken {
  token: string
  /** ms desde 1970; se renueva un poco antes. */
  expiresAt: number
  /** Configuración con la que se pidió: si cambia, no vale. */
  key: string
}

/**
 * Hace las llamadas a las APIs desde el proceso principal: así no hay CORS, los secretos nunca
 * llegan al renderer (la petición que se le devuelve va con los secretos tapados) y se pueden cancelar.
 */
export class RequestRunner {
  private readonly running = new Map<string, AbortController>()
  private readonly tokens = new Map<string, CachedToken>()

  constructor(private readonly deps: { store: ApiStore; vault: SecretVault; fetch: FetchFn; now?: () => number }) {}

  async send(input: SendRequestInput): Promise<SendResult> {
    const api = await this.deps.store.get(input.apiId)
    const endpoint = api.endpoints.find((e) => e.id === input.endpointId)
    if (!endpoint) throw new Error('El endpoint no existe')

    const controller = new AbortController()
    this.running.set(input.runId, controller)
    const builtins = builtinVars(new Date(this.now()), randomUUID)
    const secrets = await this.deps.vault.get(api.id)
    const masked: PlanContext = { builtins, secrets: maskAll(secrets), oauthToken: SECRET_MASK }
    // La versión tapada es la que ve el usuario: se monta antes de pedir el token por si eso falla.
    const echoPlan = planRequest(api, endpoint, input, masked)
    const request = { method: echoPlan.method, url: echoPlan.url, headers: echoPlan.headers, body: echoPlan.body }
    const started = this.now()
    const failed = (error: string): SendResult => ({ runId: input.runId, request, durationMs: this.now() - started, error, success: false, message: error })

    try {
      const problems = [
        ...echoPlan.errors,
        ...(echoPlan.missing.length ? [`Falta rellenar: ${echoPlan.missing.join(', ')}`] : []),
        ...(echoPlan.unresolved.length ? [`Variables sin definir: ${echoPlan.unresolved.map((v) => `{{${v}}}`).join(', ')}`] : [])
      ]
      if (problems.length) return failed(problems.join('. '))

      const timeoutMs = (api.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
      const oauthToken = api.auth.type === 'oauth2' ? await this.oauthToken(api, secrets, signal) : undefined
      const plan = planRequest(api, endpoint, input, { builtins, secrets, oauthToken })

      const res = await this.deps.fetch(plan.url, {
        method: plan.method,
        headers: plan.headers.map((h) => [h.name, h.value]),
        body: plan.body,
        signal
      })
      const response = await readResponse(res, signal)
      const durationMs = this.now() - started
      const verdict = evaluateResponse(api.responseRule, response.status, response.statusText, response.binary ? '' : response.body)
      // Un 401 con OAuth suele ser un token caducado antes de tiempo: la próxima vez se pide otro.
      if (response.status === 401) this.tokens.delete(api.id)
      return { runId: input.runId, request, durationMs, response, ...verdict }
    } catch (err) {
      return failed(describeFailure(err, controller.signal, api.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS))
    } finally {
      this.running.delete(input.runId)
    }
  }

  cancel(runId: string): void {
    this.running.get(runId)?.abort()
  }

  /** Olvida el token OAuth de una API (al editarla o borrarla). */
  forget(apiId: string): void {
    this.tokens.delete(apiId)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Token OAuth 2.0 «client credentials», reutilizado mientras no caduque. */
  private async oauthToken(api: ApiConfig, secrets: Partial<Record<SecretKey, string>>, signal: AbortSignal): Promise<string> {
    if (api.auth.type !== 'oauth2') throw new Error('La API no usa OAuth 2.0')
    const { tokenUrl, clientId, scope } = api.auth
    const key = JSON.stringify([tokenUrl, clientId, scope ?? '', secrets.clientSecret ?? ''])
    const cached = this.tokens.get(api.id)
    if (cached && cached.key === key && cached.expiresAt > this.now()) return cached.token

    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secrets.clientSecret ?? '' })
    if (scope) form.set('scope', scope)
    const res = await this.deps.fetch(tokenUrl, {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/x-www-form-urlencoded'],
        ['Accept', 'application/json']
      ],
      body: form.toString(),
      signal
    })
    const text = await res.text()
    let json: { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } = {}
    try {
      json = JSON.parse(text) as typeof json
    } catch {
      // Se informa abajo.
    }
    if (!res.ok || typeof json.access_token !== 'string') {
      const detail = [json.error, json.error_description].filter((v) => typeof v === 'string').join(': ')
      throw new Error(`No se pudo obtener el token OAuth (${res.status}${detail ? ` · ${detail}` : ''})`)
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600
    // Se renueva 30 s antes de que caduque.
    this.tokens.set(api.id, { token: json.access_token, expiresAt: this.now() + Math.max(0, expiresIn - 30) * 1000, key })
    return json.access_token
  }
}

function maskAll(secrets: Partial<Record<SecretKey, string>>): Partial<Record<SecretKey, string>> {
  return Object.fromEntries(Object.keys(secrets).map((k) => [k, SECRET_MASK]))
}

/** Lee el cuerpo como mucho hasta MAX_BODY_BYTES; los binarios no se decodifican. */
async function readResponse(res: Response, signal: AbortSignal): Promise<HttpResponse> {
  const contentType = res.headers.get('content-type') ?? undefined
  const binary = !!contentType && !TEXT_TYPES.test(contentType)
  const chunks: Uint8Array[] = []
  let size = 0
  let kept = 0
  let truncated = false
  if (res.body) {
    const reader = res.body.getReader()
    const onAbort = () => void reader.cancel().catch(() => {})
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (binary || truncated) continue
        if (kept + value.byteLength > MAX_BODY_BYTES) {
          chunks.push(value.subarray(0, MAX_BODY_BYTES - kept))
          kept = MAX_BODY_BYTES
          truncated = true
          continue
        }
        chunks.push(value)
        kept += value.byteLength
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    signal.throwIfAborted()
  }
  const bytes = new Uint8Array(kept)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers].map(([name, value]) => ({ name, value })),
    body: binary ? '' : new TextDecoder().decode(bytes),
    size,
    truncated,
    binary,
    contentType
  }
}

/** Código de sistema (ECONNREFUSED…) aunque venga envuelto en `cause` o en un AggregateError. */
function errorCode(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > 4) return undefined
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown }
  if (typeof e.code === 'string' && /^E[A-Z_]+$|^CERT_/.test(e.code)) return e.code
  for (const inner of [e.cause, ...(Array.isArray(e.errors) ? e.errors : [])]) {
    const code = errorCode(inner, depth + 1)
    if (code) return code
  }
  return undefined
}

function describeFailure(err: unknown, cancelSignal: AbortSignal, timeoutSeconds: number): string {
  if (cancelSignal.aborted) return 'Cancelada'
  const e = err as Error
  if (e?.name === 'TimeoutError') return `Sin respuesta en ${timeoutSeconds} s: se ha cancelado la llamada`
  const code = errorCode(err)
  const known: Record<string, string> = {
    ENOTFOUND: 'No se encuentra el servidor (revisa la dirección o la conexión a internet)',
    ECONNREFUSED: 'El servidor ha rechazado la conexión',
    ECONNRESET: 'El servidor ha cortado la conexión',
    CERT_HAS_EXPIRED: 'El certificado del servidor ha caducado'
  }
  if (code && known[code]) return known[code]
  const message = e?.message ?? String(err)
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return known.ENOTFOUND!
  if (/ERR_CONNECTION_REFUSED/.test(message)) return known.ECONNREFUSED!
  if (/ERR_CERT/.test(message)) return `Problema con el certificado del servidor (${message})`
  return `No se pudo hacer la llamada: ${message}`
}
