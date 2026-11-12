import { useEffect, useState } from 'react'
import type { ApiSummary, McpAccess, McpActivity, McpSettings, McpState } from '@shared/types'

const ACCESS_OPTIONS: { value: McpAccess; label: string }[] = [
  { value: 'off', label: 'Sin acceso' },
  { value: 'read', label: 'Solo consultas' },
  { value: 'confirm', label: 'Cambios con mi aprobación' },
  { value: 'write', label: 'Cambios sin preguntar' }
]

const OUTCOME_LABEL: Record<McpActivity['outcome'], string> = {
  ok: 'OK',
  error: 'Error',
  blocked: 'Bloqueado',
  rejected: 'Rechazado'
}

/** Por qué una API no admite cierto nivel; null si lo admite. */
function accessLimit(api: ApiSummary, level: McpAccess): string | null {
  if (api.environment === 'prod' && level === 'write') return 'en producción siempre con aprobación'
  return null
}

const sameSettings = (a: McpSettings, b: McpSettings) => JSON.stringify(a) === JSON.stringify(b)

const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Ajustes de la app. De momento, el servidor MCP para agentes de IA. */
export function SettingsDialog({ apis, onClose }: { apis: ApiSummary[]; onClose: () => void }) {
  const [state, setState] = useState<McpState | null>(null)
  const [draft, setDraft] = useState<McpSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [extension, setExtension] = useState<string | null>(null)

  useEffect(() => {
    void window.api.mcpState().then((s) => {
      setState(s)
      setDraft(s.settings)
    })
    // La actividad del agente llega en directo mientras el diálogo está abierto.
    return window.api.onMcpState(setState)
  }, [])

  if (!state || !draft) return null
  const dirty = !sameSettings(draft, state.settings)
  const portValid = Number.isInteger(draft.port) && draft.port >= 1024 && draft.port <= 65535
  const url = state.url ?? `http://127.0.0.1:${state.settings.port}/mcp`
  const claudeCode = `claude mcp add --scope user --transport http gestor-api ${url} --header "Authorization: Bearer ${state.token}"`
  const withAccess = apis.filter((a) => (draft.access[a.id] ?? 'off') !== 'off').length

  const run = async (task: () => Promise<McpState | void>) => {
    setBusy(true)
    setError(null)
    try {
      const next = await task()
      if (next) {
        setState(next)
        setDraft(next.settings)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = (what: string, text: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500)
  }

  const setAccess = (id: string, level: McpAccess) => setDraft({ ...draft, access: { ...draft.access, [id]: level } })

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide settings" role="dialog" aria-label="Ajustes" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>Ajustes</h2>
        <div className="body">
          <h3>Servidor MCP para agentes de IA</h3>
          <p className="note">
            Permite que Claude (u otro cliente MCP) busque y lance los endpoints de tus APIs por su cuenta, con las
            credenciales guardadas aquí. Las credenciales no salen de la app: el agente solo ve las peticiones (con los
            secretos tapados) y lo que responden las APIs.
          </p>
          <div className="notice warn">
            Un agente puede equivocarse, y lo que responden las APIs puede contener instrucciones maliciosas. Da el mínimo
            acceso necesario: «Solo consultas» no deja lanzar los endpoints marcados como «modifica datos». Revisa que esa
            marca esté bien puesta antes de permitir cambios. Todo lo que hace queda registrado.
          </div>
          {error && <div className="notice error">{error}</div>}
          {state.error && <div className="notice error">{state.error}</div>}

          <label className="check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Activar el servidor MCP
            {state.running ? (
              <span className="badge mcp-on">En marcha · {state.url}</span>
            ) : (
              <span className="badge">Parado</span>
            )}
          </label>

          <div className="form-grid mcp-grid">
            <label htmlFor="mcp-port">Puerto</label>
            <div className="row">
              <input
                id="mcp-port"
                type="number"
                min={1024}
                max={65535}
                value={draft.port}
                className={portValid ? '' : 'invalid'}
                onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
              />
              <span className="note">Solo escucha en este equipo (127.0.0.1).</span>
            </div>
            <label>Token</label>
            <div className="row">
              <code className="mcp-token">{showToken ? state.token : '•'.repeat(24)}</code>
              <button className="compact" onClick={() => setShowToken(!showToken)}>
                {showToken ? 'Ocultar' : 'Mostrar'}
              </button>
              <button className="compact" onClick={() => copy('token', state.token)}>
                {copied === 'token' ? 'Copiado' : 'Copiar'}
              </button>
              <button
                className="compact"
                title="Los clientes configurados con el token anterior dejarán de funcionar (la extensión de Claude Desktop no: lo lee sola)"
                disabled={busy}
                onClick={() => void run(() => window.api.mcpRegenerateToken())}
              >
                Regenerar
              </button>
            </div>
          </div>

          <h3>Acceso por API</h3>
          <p className="note">
            El agente solo ve las APIs con acceso. En producción, los endpoints que modifican datos siempre necesitan tu
            aprobación: la app te enseña la petición antes de enviarla.
          </p>
          {apis.length === 0 ? (
            <div className="empty-note">Aún no hay APIs.</div>
          ) : (
            <div className="mcp-access" role="table" aria-label="Acceso del agente por API">
              {apis.map((c) => {
                const level = draft.access[c.id] ?? 'off'
                const limit = accessLimit(c, level)
                return (
                  <div key={c.id} className="mcp-access-row" role="row">
                    <span className={`env-dot env-${c.environment}`} />
                    <span className="mcp-conn-name">{c.name}</span>
                    {c.environment === 'prod' && <span className="badge prod">PROD</span>}
                    <span className="badge" title="Endpoints">{c.endpoints.length}</span>
                    <span className="spacer" />
                    {limit && <span className="note">Se queda en menos: {limit}</span>}
                    <select
                      className="compact"
                      aria-label={`Acceso del agente a ${c.name}`}
                      value={level}
                      onChange={(e) => setAccess(c.id, e.target.value as McpAccess)}
                    >
                      {ACCESS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value} disabled={accessLimit(c, o.value) !== null}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              })}
            </div>
          )}

          <h3>Conectar con Claude</h3>
          <div className="mcp-clients">
            <div>
              <strong>Claude Desktop</strong>
              <p className="note">
                Crea la extensión e instálala con doble clic (o arrastrándola a Ajustes → Extensiones de Claude Desktop).
                Solo hay que hacerlo una vez: lee el puerto y el token de esta app, así que no hay que reinstalarla si cambian.
              </p>
              <div className="row">
                <button disabled={busy} onClick={() => void run(async () => setExtension(await window.api.mcpCreateExtension()))}>
                  Crear extensión (.mcpb)…
                </button>
                {extension && (
                  <button className="primary" disabled={busy} onClick={() => void run(() => window.api.mcpOpenExtension())}>
                    Instalar en Claude Desktop
                  </button>
                )}
              </div>
              {extension && (
                <p className="note">
                  Guardada en <code>{extension}</code>
                </p>
              )}
            </div>
            <div>
              <strong>Claude Code</strong>
              <p className="note">Ejecuta esto una vez en un terminal (si regeneras el token, repítelo):</p>
              <div className="row">
                <code className="mcp-command">{showToken ? claudeCode : claudeCode.replace(state.token, '•••')}</code>
                <button className="compact" onClick={() => copy('code', claudeCode)}>
                  {copied === 'code' ? 'Copiado' : 'Copiar'}
                </button>
              </div>
            </div>
          </div>

          <h3>Actividad del agente</h3>
          {state.activity.length === 0 ? (
            <div className="empty-note">Sin actividad desde que se abrió la app.</div>
          ) : (
            <div className="mcp-activity" aria-label="Actividad del agente">
              {state.activity.slice(0, 100).map((a) => (
                <div key={a.id} className={`mcp-activity-row outcome-${a.outcome}`} title={a.detail ?? a.summary}>
                  <span className="mcp-time">{formatTime(a.at)}</span>
                  <span className="mcp-tool">{a.tool}</span>
                  <span className="mcp-conn">{a.api ?? ''}</span>
                  <span className="mcp-summary">{a.detail && a.outcome !== 'ok' ? `${a.summary} — ${a.detail}` : a.summary}</span>
                  <span className={`badge outcome ${a.outcome}`}>{OUTCOME_LABEL[a.outcome]}</span>
                </div>
              ))}
            </div>
          )}
          <p className="note">
            Registro completo: <code>{state.logPath}</code>
          </p>
        </div>
        <div className="footer">
          {draft.enabled && withAccess === 0 && <span className="note">El agente no verá ninguna API hasta que le des acceso.</span>}
          <div className="spacer" />
          <button onClick={onClose}>{dirty ? 'Descartar' : 'Cerrar'}</button>
          <button
            className="primary"
            disabled={!dirty || busy || !portValid}
            onClick={() => void run(() => window.api.mcpSaveSettings(draft))}
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  )
}
