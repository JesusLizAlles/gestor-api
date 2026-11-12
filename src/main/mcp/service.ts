// Servidor MCP de la app: arranca y para el HTTP según los ajustes, lanza las llamadas del agente
// con el RequestRunner (las mismas credenciales y reglas que la interfaz), pide aprobación de las
// que modifican datos y registra cada llamada.
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Server } from 'node:http'
import type { ApiSummary, McpActivity, McpApprovalRequest, McpSettings, McpState, SecretKey, SendRequestInput, SendResult } from '@shared/types'
import { planRequest, SECRET_MASK, withVariables } from '@shared/request'
import { builtinVars } from '@shared/template'
import { MCP_PATH, serverPort, startHttpServer, stopHttpServer } from './http'
import { RPC, RpcError, type ProtocolHandlers } from './protocol'
import { effectiveAccess, type McpSettingsStore } from './settings'
import { callTool, toolDefinitions, UnknownToolError, type ToolBackend } from './tools'

const MAX_ACTIVITY = 200
const MAX_LOG_BYTES = 5_000_000
/** Una llamada sin respuesta del usuario se da por rechazada. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export interface McpServiceDeps {
  settings: McpSettingsStore
  apis: { list(): Promise<ApiSummary[]> }
  runner: { send(input: SendRequestInput): Promise<SendResult> }
  version: string
  logPath: string
  /** Avisa a la interfaz de cualquier cambio (estado, actividad). */
  onState(state: McpState): void
  /** Pide a la interfaz que muestre la aprobación; false si no hay ventana que pueda hacerlo. */
  onApproval(request: McpApprovalRequest): boolean
}

export class McpService {
  private server: Server | null = null
  private error: string | null = null
  private activity: McpActivity[] = []
  private approvals = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()
  private token = ''
  /** Escrituras al registro, una detrás de otra. */
  private logQueue = Promise.resolve()

  constructor(private readonly deps: McpServiceDeps) {}

  /** Arranca el servidor si quedó activado la última vez. */
  async init(): Promise<void> {
    await this.apply()
  }

  async state(): Promise<McpState> {
    const { version: _v, token, ...settings } = await this.deps.settings.get()
    return {
      settings,
      token,
      running: this.server !== null,
      url: this.server ? `http://127.0.0.1:${serverPort(this.server)}${MCP_PATH}` : null,
      error: this.error,
      activity: this.activity,
      logPath: this.deps.logPath,
      pendingApprovals: [...this.approvals.keys()]
    }
  }

  async saveSettings(settings: McpSettings): Promise<McpState> {
    const before = await this.deps.settings.get()
    const after = await this.deps.settings.save(settings)
    await this.apply(before.port !== after.port)
    return this.publish()
  }

  async regenerateToken(): Promise<McpState> {
    await this.deps.settings.regenerateToken()
    await this.apply()
    return this.publish()
  }

  respondApproval(id: string, approved: boolean): void {
    const pending = this.approvals.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.approvals.delete(id)
    pending.resolve(approved)
  }

  async stop(): Promise<void> {
    for (const id of [...this.approvals.keys()]) this.respondApproval(id, false)
    if (this.server) await stopHttpServer(this.server)
    this.server = null
  }

  /** Deja el servidor como dicen los ajustes. */
  private async apply(restart = false): Promise<void> {
    const file = await this.deps.settings.get()
    this.token = file.token
    if (!file.enabled) {
      await this.stop()
      this.error = null
      return
    }
    if (this.server && !restart) return
    if (this.server) {
      await stopHttpServer(this.server)
      this.server = null
    }
    try {
      this.server = await startHttpServer({
        port: file.port,
        token: () => this.token,
        handlers: this.handlers(),
        onRejected: (reason) => this.record({ tool: 'http', api: null, summary: '', outcome: 'blocked', detail: reason, durationMs: 0 })
      })
      this.error = null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      this.error =
        code === 'EADDRINUSE' ? `El puerto ${file.port} ya está en uso por otro programa. Elige otro.` : `No se pudo arrancar el servidor: ${(err as Error).message}`
    }
  }

  private handlers(): ProtocolHandlers {
    const backend = this.backend()
    return {
      serverVersion: this.deps.version,
      listTools: () => toolDefinitions(),
      callTool: async (name, args) => {
        const started = performance.now()
        try {
          const result = await callTool(name, args, backend)
          this.record({
            tool: name,
            api: result.info.api,
            summary: result.info.summary,
            outcome: result.outcome,
            ...(result.isError ? { detail: result.text.slice(0, 500) } : {}),
            durationMs: Math.round(performance.now() - started)
          })
          return { content: [{ type: 'text', text: result.text }], isError: result.isError }
        } catch (err) {
          if (err instanceof UnknownToolError) throw new RpcError(RPC.invalidParams, err.message)
          throw err
        }
      }
    }
  }

  /** Lo que ve el agente de la app. */
  backend(): ToolBackend {
    return {
      apis: async () => {
        const { access } = await this.deps.settings.get()
        return (await this.deps.apis.list()).map((api) => ({ api, access: effectiveAccess(api, access[api.id]) }))
      },
      preview: (api, endpoint, input) => {
        const masked = Object.fromEntries(api.storedSecrets.map((k) => [k, SECRET_MASK])) as Partial<Record<SecretKey, string>>
        const plan = planRequest(withVariables(api, input.variables), endpoint, input, { builtins: builtinVars(), secrets: masked, oauthToken: SECRET_MASK })
        const problems = [
          ...plan.errors,
          ...(plan.missing.length ? [`Falta rellenar: ${plan.missing.join(', ')}`] : []),
          ...(plan.unresolved.length ? [`Variables sin definir: ${plan.unresolved.map((v) => `{{${v}}}`).join(', ')}`] : [])
        ]
        return { request: { method: plan.method, url: plan.url, headers: plan.headers, body: plan.body }, problems }
      },
      send: (api, endpoint, input) => this.deps.runner.send({ runId: randomUUID(), apiId: api.id, endpointId: endpoint.id, ...input }),
      approve: (api, endpoint, request) => this.approve(api, endpoint.name, request)
    }
  }

  private approve(api: ApiSummary, endpointName: string, request: McpApprovalRequest['request']): Promise<boolean> {
    const approval: McpApprovalRequest = { id: randomUUID(), apiName: api.name, environment: api.environment, endpointName, request }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.respondApproval(approval.id, false), APPROVAL_TIMEOUT_MS)
      this.approvals.set(approval.id, { resolve, timer })
      if (!this.deps.onApproval(approval)) this.respondApproval(approval.id, false)
    })
  }

  private record(entry: Omit<McpActivity, 'id' | 'at'>): void {
    const item: McpActivity = { id: randomUUID(), at: new Date().toISOString(), ...entry }
    this.activity = [item, ...this.activity].slice(0, MAX_ACTIVITY)
    this.logQueue = this.logQueue.then(() => this.appendLog(item))
    void this.publish()
  }

  private async appendLog(item: McpActivity): Promise<void> {
    const { logPath } = this.deps
    try {
      await mkdir(dirname(logPath), { recursive: true })
      const size = await stat(logPath).then((s) => s.size, () => 0)
      if (size > MAX_LOG_BYTES) await truncate(logPath, 0)
      await appendFile(logPath, JSON.stringify(item) + '\n', { mode: 0o600 })
    } catch {
      // El registro nunca debe hacer fallar al agente.
    }
  }

  private async publish(): Promise<McpState> {
    const state = await this.state()
    this.deps.onState(state)
    return state
  }
}
