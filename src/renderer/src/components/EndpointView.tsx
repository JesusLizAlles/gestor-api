import { useEffect, useMemo, useRef, useState } from 'react'
import {
  authSecrets,
  type ApiSummary,
  type ApiVariable,
  type Endpoint,
  type EndpointParam,
  type ParamLocation,
  type RequestEcho,
  type SecretKey,
  type SendResult
} from '@shared/types'
import { planRequest, SECRET_MASK } from '@shared/request'
import { builtinVars } from '@shared/template'
import { paramKey } from '@shared/url'
import { AUTH_LABEL, BODY_LABEL, ENV_LABEL, formatBytes, formatDuration, PARAM_IN_HELP, PARAM_IN_LABEL, PARAM_IN_SECTION, PARAM_TYPE_LABEL } from '../lib/labels'
import { keys } from '../lib/platform'
import { ConfirmDialog } from './ConfirmDialog'
import { Icon } from './Icon'
import { JsonTree } from './JsonTree'
import { MethodBadge } from './MethodBadge'

interface Props {
  api: ApiSummary
  endpoint: Endpoint
  active: boolean
  onEdit: () => void
  /** Abre la configuración de la API (en la pestaña de variables, por ejemplo). */
  onEditApi: (tab: 'auth' | 'variables') => void
  onApiChanged: (api: ApiSummary) => void
}

const LOCATIONS: ParamLocation[] = ['path', 'query', 'header', 'body']

/** Valores iniciales del formulario: los ejemplos de cada parámetro (o el valor actual de su listado). */
function initialValues(api: ApiSummary, params: EndpointParam[]): Record<string, string> {
  return Object.fromEntries(
    params.map((p) => {
      const list = p.optionsFrom ? api.variables.find((v) => v.name === p.optionsFrom) : undefined
      const fallback = list ? list.value : p.type === 'enum' ? (p.options?.[0] ?? '') : ''
      return [paramKey(p), p.example ?? fallback]
    })
  )
}

/** El cuerpo con sangría si es JSON; tal cual si no. */
function pretty(text: string | undefined): string {
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

type ResponseTab = 'body' | 'headers' | 'request'

/**
 * Ficha de un endpoint: para qué sirve, qué datos pide (con un campo para cada uno), la petición que
 * se va a enviar y la respuesta.
 */
export function EndpointView({ api, endpoint, active, onEdit, onEditApi, onApiChanged }: Props) {
  const [values, setValues] = useState(() => initialValues(api, endpoint.params))
  const [body, setBody] = useState(endpoint.body.example ?? '')
  const [showRequest, setShowRequest] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [result, setResult] = useState<SendResult | null>(null)
  const [responseTab, setResponseTab] = useState<ResponseTab>('body')
  const [bodyView, setBodyView] = useState<'tree' | 'text'>('tree')
  const [variableError, setVariableError] = useState<string | null>(null)
  const responseRef = useRef<HTMLDivElement>(null)

  // Al llegar una respuesta, se lleva a la vista (suele quedar por debajo del formulario).
  useEffect(() => {
    if (result) responseRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [result])

  // Las variables automáticas de la vista previa se fijan al abrir: así el $uuid no cambia con cada tecla.
  const builtins = useMemo(() => builtinVars(), [])
  const masked = useMemo(
    () => Object.fromEntries(api.storedSecrets.map((k) => [k, SECRET_MASK])) as Partial<Record<SecretKey, string>>,
    [api.storedSecrets]
  )
  const plan = planRequest(api, endpoint, { values, body }, { builtins, secrets: masked, oauthToken: SECRET_MASK })
  const missingSecrets = authSecrets(api.auth).filter((k) => !api.storedSecrets.includes(k))
  const problems = [
    ...plan.errors,
    ...(plan.missing.length ? [`Falta rellenar: ${plan.missing.join(', ')}`] : []),
    ...(plan.unresolved.length ? [`Variables sin definir: ${plan.unresolved.map((v) => `{{${v}}}`).join(', ')}`] : [])
  ]
  const listVariables = api.variables.filter((v) => v.options)
  const running = runId !== null

  const setValue = (p: EndpointParam, value: string) => setValues((v) => ({ ...v, [paramKey(p)]: value }))

  const send = async (confirmed = false) => {
    if (running || problems.length > 0) return
    if (endpoint.modifies && !confirmed) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    const id = crypto.randomUUID()
    setRunId(id)
    try {
      setResult(await window.api.sendRequest({ runId: id, apiId: api.id, endpointId: endpoint.id, values, body }))
    } catch (err) {
      const message = (err as Error).message
      const request: RequestEcho = { method: plan.method, url: plan.url, headers: plan.headers, body: plan.body }
      setResult({ runId: id, request, durationMs: 0, error: message, success: false, message })
    } finally {
      setRunId(null)
    }
  }

  const chooseVariable = async (variable: ApiVariable, value: string) => {
    setVariableError(null)
    try {
      onApiChanged(await window.api.setVariable(api.id, variable.name, value))
    } catch (err) {
      setVariableError((err as Error).message)
    }
  }

  // Ctrl+Enter envía desde cualquier campo de la ficha activa.
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !document.querySelector('.modal-overlay')) {
        e.preventDefault()
        void sendRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <div className="endpoint-view" hidden={!active}>
      <div className="endpoint-head">
        <MethodBadge method={endpoint.method} large />
        <div className="endpoint-title">
          <h1>
            {endpoint.name}
            {endpoint.modifies && (
              <span className="badge warn" title="Pide confirmación antes de enviar">
                modifica datos
              </span>
            )}
          </h1>
          <div className="endpoint-path mono">
            <span className="dim">{api.baseUrl.replace(/\/+$/, '')}</span>
            {endpoint.path}
          </div>
        </div>
        <span className="spacer" />
        <button onClick={onEdit}>
          <Icon name="edit" /> Editar
        </button>
      </div>

      <div className="endpoint-body">
        <section className="endpoint-doc">
          {endpoint.description ? (
            <p className="description">{endpoint.description}</p>
          ) : (
            <p className="note">
              Sin descripción.{' '}
              <button className="link" onClick={onEdit}>
                Añade qué hace
              </button>{' '}
              para que cualquiera sepa cuándo usarlo.
            </p>
          )}
          <div className={`auth-line ${missingSecrets.length ? 'warn' : ''}`}>
            <Icon name="lock" />
            {api.auth.type === 'none' ? (
              'Sin autenticación'
            ) : missingSecrets.length ? (
              <>
                {AUTH_LABEL[api.auth.type]}: falta guardar la credencial ·{' '}
                <button className="link" onClick={() => onEditApi('auth')}>
                  configurar
                </button>
              </>
            ) : (
              `${AUTH_LABEL[api.auth.type]} · credencial guardada`
            )}
          </div>
        </section>

        {listVariables.length > 0 && (
          <section>
            <h3>
              Variables <span className="dim">· se aplican a todos los endpoints de {api.name}</span>
            </h3>
            <div className="param-form">
              {listVariables.map((v) => (
                <div className="param-field" key={v.name}>
                  <label htmlFor={`var-${endpoint.id}-${v.name}`}>
                    <span className="mono">{`{{${v.name}}}`}</span>
                    <span className="param-type">{v.value}</span>
                  </label>
                  <select id={`var-${endpoint.id}-${v.name}`} value={v.value} onChange={(e) => void chooseVariable(v, e.target.value)}>
                    {!v.options!.some((o) => o.value === v.value) && <option value={v.value}>{v.value || '(sin elegir)'}</option>}
                    {v.options!.map((o, i) => (
                      <option key={i} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {v.description && <div className="note">{v.description}</div>}
                </div>
              ))}
            </div>
            {variableError && <div className="notice error spaced">{variableError}</div>}
          </section>
        )}

        {LOCATIONS.map((location) => {
          const list = endpoint.params.filter((p) => p.in === location)
          if (list.length === 0) return null
          return (
            <section key={location}>
              <h3 title={PARAM_IN_HELP[location]}>
                {PARAM_IN_SECTION[location]}
                {location !== 'body' && location !== 'header' && <span className="dim"> · {PARAM_IN_LABEL[location].toLowerCase()}</span>}
              </h3>
              <div className="param-form">
                {list.map((p) => (
                  <ParamField
                    key={paramKey(p)}
                    param={p}
                    variables={api.variables}
                    value={values[paramKey(p)] ?? ''}
                    onChange={(v) => setValue(p, v)}
                  />
                ))}
              </div>
            </section>
          )
        })}

        {endpoint.body.kind !== 'none' && (
          <section>
            <h3>
              Cuerpo <span className="dim">· {BODY_LABEL[endpoint.body.kind]}</span>
            </h3>
            {endpoint.body.description && <p className="note">{endpoint.body.description}</p>}
            <textarea
              className="body-editor mono-input"
              rows={10}
              spellCheck={false}
              value={body}
              aria-label="Cuerpo"
              onChange={(e) => setBody(e.target.value)}
            />
          </section>
        )}

        <section className="request-bar">
          <div className="request-url mono" title={plan.url}>
            <MethodBadge method={endpoint.method} />
            <span>{plan.url}</span>
          </div>
          {problems.length > 0 && (
            <div className="notice warn">
              {problems.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          )}
          <div className="row">
            {running ? (
              <button className="danger" onClick={() => runId && void window.api.cancelRequest(runId)}>
                <span className="spinner" /> Cancelar
              </button>
            ) : (
              <button
                className={api.environment === 'prod' && endpoint.modifies ? 'danger' : 'primary'}
                disabled={problems.length > 0}
                title={keys('Enviar (Ctrl+Enter)')}
                onClick={() => void send()}
              >
                <Icon name="send" /> Enviar
              </button>
            )}
            <button onClick={() => setShowRequest(!showRequest)}>{showRequest ? 'Ocultar la petición' : 'Ver la petición'}</button>
            <button onClick={() => void navigator.clipboard.writeText(plan.url)}>Copiar URL</button>
            <button
              onClick={() => {
                setValues(initialValues(api, endpoint.params))
                setBody(endpoint.body.example ?? '')
              }}
            >
              Volver a los ejemplos
            </button>
            <span className="spacer" />
            <span className={`env-pill env-pill-${api.environment}`}>{ENV_LABEL[api.environment]}</span>
          </div>
          {showRequest && <RequestDetails request={plan} note="Vista previa · los secretos se ven tapados" />}
        </section>

        <div ref={responseRef}>
          {result ? (
            <ResponsePanel result={result} tab={responseTab} onTab={setResponseTab} bodyView={bodyView} onBodyView={setBodyView} />
          ) : (
            <section className="response-placeholder">{running ? 'Esperando respuesta…' : 'Aquí aparecerá la respuesta de la API.'}</section>
          )}
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title={api.environment === 'prod' ? 'Enviar a PRODUCCIÓN' : 'Esta llamada modifica datos'}
          confirmLabel={api.environment === 'prod' ? 'Enviar a producción' : 'Enviar'}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => void send(true)}
        >
          <p>
            «{endpoint.name}» cambia datos en <b>{api.name}</b> ({ENV_LABEL[api.environment]}).
            {api.environment === 'prod' && ' No es un entorno de pruebas: el cambio será real.'}
          </p>
          <RequestDetails request={plan} />
        </ConfirmDialog>
      )}
    </div>
  )
}

/** Método, dirección, cabeceras y cuerpo de una petición. */
function RequestDetails({ request, note }: { request: RequestEcho; note?: string }) {
  return (
    <div className="request-details">
      {note && <div className="note">{note}</div>}
      <div className="mono request-line">
        <b>{request.method}</b> {request.url}
      </div>
      {request.headers.length > 0 && (
        <div className="mono kv-list">
          {request.headers.map((h, i) => (
            <div key={i}>
              <span className="json-key">{h.name}:</span> {h.value}
            </div>
          ))}
        </div>
      )}
      {request.body !== undefined && <pre className="code-block">{pretty(request.body)}</pre>}
    </div>
  )
}

interface ResponsePanelProps {
  result: SendResult
  tab: ResponseTab
  onTab: (tab: ResponseTab) => void
  bodyView: 'tree' | 'text'
  onBodyView: (view: 'tree' | 'text') => void
}

function ResponsePanel({ result, tab, onTab, bodyView, onBodyView }: ResponsePanelProps) {
  const response = result.response
  const json = useMemo(() => {
    if (!response || response.binary || !response.body) return undefined
    try {
      return { value: JSON.parse(response.body) as unknown }
    } catch {
      return undefined
    }
  }, [response])
  const text = useMemo(() => (json ? JSON.stringify(json.value, null, 2) : (response?.body ?? '')), [json, response])

  return (
    <section className={`response ${result.success ? 'ok' : 'fail'}`}>
      <div className="response-head">
        {response ? (
          <span className={`status-pill ${response.status < 300 ? 'ok' : response.status < 400 ? 'warn' : 'fail'}`}>
            {response.status} {response.statusText}
          </span>
        ) : (
          <span className="status-pill fail">Sin respuesta</span>
        )}
        <span className={`verdict ${result.success ? 'ok' : 'fail'}`}>{result.success ? '✓ Correcta' : '✕ Error'}</span>
        <span className="dim">{formatDuration(result.durationMs)}</span>
        {response && <span className="dim">{formatBytes(response.size)}</span>}
        <span className="spacer" />
        {response && !response.binary && (
          <button className="compact" onClick={() => void navigator.clipboard.writeText(text)}>
            Copiar respuesta
          </button>
        )}
      </div>
      {result.message && <div className={`notice ${result.success ? 'ok' : 'error'}`}>{result.message}</div>}
      {response?.truncated && <div className="notice warn">La respuesta es muy grande: solo se muestran los primeros 20 MB.</div>}

      <div className="dialog-tabs response-tabs" role="tablist">
        <div role="tab" aria-selected={tab === 'body'} className={`dialog-tab ${tab === 'body' ? 'active' : ''}`} onClick={() => onTab('body')}>
          Respuesta
        </div>
        {response && (
          <div role="tab" aria-selected={tab === 'headers'} className={`dialog-tab ${tab === 'headers' ? 'active' : ''}`} onClick={() => onTab('headers')}>
            Cabeceras <span className="badge">{response.headers.length}</span>
          </div>
        )}
        <div role="tab" aria-selected={tab === 'request'} className={`dialog-tab ${tab === 'request' ? 'active' : ''}`} onClick={() => onTab('request')}>
          Petición enviada
        </div>
        {tab === 'body' && json && (
          <>
            <span className="spacer" />
            <div className="segmented">
              <button className={bodyView === 'tree' ? 'active' : ''} onClick={() => onBodyView('tree')}>
                Árbol
              </button>
              <button className={bodyView === 'text' ? 'active' : ''} onClick={() => onBodyView('text')}>
                Texto
              </button>
            </div>
          </>
        )}
      </div>

      {tab === 'body' &&
        (!response ? (
          <div className="note">{result.error}</div>
        ) : response.binary ? (
          <div className="note">
            Contenido binario ({response.contentType}, {formatBytes(response.size)}): no se puede mostrar.
          </div>
        ) : !response.body ? (
          <div className="note">La respuesta no tiene cuerpo.</div>
        ) : json && bodyView === 'tree' ? (
          <JsonTree value={json.value} />
        ) : (
          <pre className="code-block">{text}</pre>
        ))}
      {tab === 'headers' && response && (
        <div className="mono kv-list">
          {response.headers.map((h, i) => (
            <div key={i}>
              <span className="json-key">{h.name}:</span> {h.value}
            </div>
          ))}
        </div>
      )}
      {(tab === 'request' || (tab === 'headers' && !response)) && (
        <RequestDetails request={result.request} note="Tal como salió, con los secretos tapados" />
      )}
    </section>
  )
}

/** Campo del formulario según el tipo del parámetro, con su explicación debajo. */
function ParamField({
  param,
  variables,
  value,
  onChange
}: {
  param: EndpointParam
  variables: ApiVariable[]
  value: string
  onChange: (value: string) => void
}) {
  const id = `param-${param.in}-${param.name}`
  let input
  if (param.type === 'enum') {
    const list = param.optionsFrom ? variables.find((v) => v.name === param.optionsFrom) : undefined
    const options = list?.options ?? (param.options ?? []).map((o) => ({ label: o, value: o }))
    input = (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {!param.required && <option value="">(sin indicar)</option>}
        {/* Un valor que no está en la lista (un ejemplo con {{variable}}, por ejemplo) se conserva. */}
        {value !== '' && !options.some((o) => o.value === value) && (
          <option value={value}>
            {list && value === `{{${list.name}}}`
              ? `El elegido arriba (${list.options?.find((o) => o.value === list.value)?.label ?? list.value})`
              : value}
          </option>
        )}
        {options.map((o, i) => (
          <option key={i} value={o.value}>
            {o.label}
            {list && o.label !== o.value ? ` · ${o.value}` : ''}
          </option>
        ))}
      </select>
    )
  } else if (param.type === 'boolean') {
    input = (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(sin indicar)</option>
        {value !== '' && value !== 'true' && value !== 'false' && <option value={value}>{value}</option>}
        <option value="true">Sí</option>
        <option value="false">No</option>
      </select>
    )
  } else {
    // Con una {{variable}} el campo pasa a texto: un input de fecha o número no la admitiría.
    const usesVariable = value.includes('{{')
    input = (
      <input
        id={id}
        type={usesVariable ? 'text' : param.type === 'number' ? 'number' : param.type === 'date' ? 'date' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <div className="param-field">
      <label htmlFor={id}>
        <span className="mono">{param.name}</span>
        {param.required && (
          <span className="required" title="Obligatorio">
            *
          </span>
        )}
        <span className="param-type">{param.optionsFrom ? `Listado {{${param.optionsFrom}}}` : PARAM_TYPE_LABEL[param.type]}</span>
      </label>
      {input}
      {param.description && <div className="note">{param.description}</div>}
    </div>
  )
}
