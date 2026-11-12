import { useState } from 'react'
import {
  authSecrets,
  fieldSecret,
  HTTP_METHODS,
  type ApiSummary,
  type ApiVariable,
  type AuthConfig,
  type AuthField,
  type AuthFieldLocation,
  type AuthType,
  type Environment,
  type HeaderEntry,
  type HttpMethod,
  type ResponseRule,
  type SecretKey,
  type SecretStorageStatus,
  type SecretsPatch
} from '@shared/types'
import { BUILTIN_HELP, INLINE_HELP, jsonTemplateError } from '@shared/template'
import { AUTH_FIELD_IN_LABEL, AUTH_LABEL, ENV_LABEL, secretLabel } from '../lib/labels'
import { Icon } from './Icon'

interface Props {
  /** null = API nueva. */
  initial: ApiSummary | null
  secretStatus: SecretStorageStatus | null
  /** Pestaña con la que se abre. */
  initialTab?: DialogTab
  onClose: () => void
  onSaved: (api: ApiSummary) => void
}

export type DialogTab = 'general' | 'auth' | 'variables' | 'advanced'

const TABS: [DialogTab, string][] = [
  ['general', 'General'],
  ['auth', 'Autenticación'],
  ['variables', 'Variables'],
  ['advanced', 'Avanzado']
]

/** Valores por defecto de cada tipo, conservando lo que ya se hubiera escrito en el mismo tipo. */
function authOf(type: AuthType, current: AuthConfig): AuthConfig {
  if (current.type === type) return current
  switch (type) {
    case 'none':
      return { type }
    case 'bearer':
      return { type }
    case 'basic':
      return { type, username: '' }
    case 'apiKey':
      return { type, name: 'X-API-Key', in: 'header' }
    case 'oauth2':
      return { type, tokenUrl: '', clientId: '', scope: '' }
    case 'custom':
      return { type, fields: [{ name: 'access_token', in: 'body' }] }
  }
}

const TEMPLATE_EXAMPLE = `{
  "resource": "{{resource}}",
  "task": "{{task}}",
  "data": {{body}}
}`

/**
 * Convierte texto pegado (una opción por línea: «nombre;valor», «nombre=valor» o con tabulador, como al
 * copiar dos columnas de una hoja de cálculo) en opciones de un listado.
 */
function parseOptions(text: string): { label: string; value: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const sep = ['\t', ';', '='].find((s) => line.includes(s))
      if (!sep) return { label: line, value: line }
      const i = line.indexOf(sep)
      return { label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }
    })
}

/** Alta y edición de una API: datos generales, autenticación, variables y opciones avanzadas. */
export function ApiDialog({ initial, secretStatus, initialTab = 'general', onClose, onSaved }: Props) {
  const [tab, setTab] = useState<DialogTab>(initialTab)
  const [name, setName] = useState(initial?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'https://')
  const [environment, setEnvironment] = useState<Environment>(initial?.environment ?? 'dev')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [auth, setAuth] = useState<AuthConfig>(initial?.auth ?? { type: 'none' })
  const [headers, setHeaders] = useState<HeaderEntry[]>(initial?.headers ?? [])
  const [variables, setVariables] = useState<ApiVariable[]>(initial?.variables ?? [])
  const [bodyTemplate, setBodyTemplate] = useState(initial?.bodyTemplate ?? '')
  const [rule, setRule] = useState<ResponseRule | null>(initial?.responseRule ?? null)
  const [defaults, setDefaults] = useState(initial?.endpointDefaults ?? null)
  const [timeout, setTimeoutSeconds] = useState(initial?.timeoutSeconds ? String(initial.timeoutSeconds) : '')
  /** Solo los secretos que el usuario ha escrito o quiere borrar; el resto no se toca. */
  const [secrets, setSecrets] = useState<SecretsPatch>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const stored = new Set(initial?.storedSecrets ?? [])
  const templateError = bodyTemplate.trim() ? jsonTemplateError(bodyTemplate) : null

  const setHeader = (index: number, patch: Partial<HeaderEntry>) =>
    setHeaders((list) => list.map((h, i) => (i === index ? { ...h, ...patch } : h)))
  const setVariable = (index: number, patch: Partial<ApiVariable>) =>
    setVariables((list) => list.map((v, i) => (i === index ? { ...v, ...patch } : v)))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const used = new Set(authSecrets(auth))
      const saved = await window.api.saveApi({
        config: {
          id: initial?.id,
          name,
          baseUrl,
          environment,
          description: description || undefined,
          auth,
          headers: headers.filter((h) => h.name.trim() !== ''),
          variables: variables
            .filter((v) => v.name.trim() !== '')
            .map((v) => ({ ...v, description: v.description?.trim() || undefined })),
          bodyTemplate: bodyTemplate.trim() ? bodyTemplate : undefined,
          responseRule: rule ? { ...rule, messagePath: rule.messagePath?.trim() || undefined } : undefined,
          endpointDefaults: defaults ?? undefined,
          timeoutSeconds: timeout.trim() ? Number(timeout) : undefined
        },
        secrets: Object.fromEntries(Object.entries(secrets).filter(([k]) => used.has(k as SecretKey)))
      })
      onSaved(saved)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  /** Campo para escribir (o quitar) un secreto sin enseñar nunca el valor guardado. */
  const secretInput = (key: SecretKey, label?: string) => {
    const value = secrets[key]
    const removing = value === null
    const id = `secret-${key.replace(/[^\w-]/g, '_')}`
    return (
      <div className="row">
        <input
          id={id}
          type="password"
          autoComplete="off"
          aria-label={label ?? secretLabel(key)}
          disabled={removing}
          value={typeof value === 'string' ? value : ''}
          placeholder={stored.has(key) && !removing ? 'Guardado · déjalo vacío para no cambiarlo' : 'Valor secreto'}
          onChange={(e) => setSecrets((s) => ({ ...s, [key]: e.target.value || undefined }))}
        />
        {stored.has(key) && (
          <button className="compact" onClick={() => setSecrets((s) => ({ ...s, [key]: removing ? undefined : null }))}>
            {removing ? 'No quitar' : 'Quitar'}
          </button>
        )}
      </div>
    )
  }

  const fixedSecret = (key: SecretKey) => (
    <>
      <label htmlFor={`secret-${key}`}>{secretLabel(key)}</label>
      {secretInput(key)}
    </>
  )

  const setAuthField = (index: number, patch: Partial<AuthField>) => {
    if (auth.type !== 'custom') return
    const before = auth.fields[index]!
    // Lo que ya se hubiera escrito como valor sigue al campo aunque cambie su nombre.
    if (patch.name !== undefined && patch.name !== before.name) {
      const pending = secrets[fieldSecret(before.name)]
      if (typeof pending === 'string') {
        setSecrets((s) => ({ ...s, [fieldSecret(before.name)]: undefined, [fieldSecret(patch.name!)]: pending }))
      }
    }
    setAuth({ ...auth, fields: auth.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) })
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label={initial ? 'Editar API' : 'Nueva API'} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{initial ? `Editar «${initial.name}»` : 'Nueva API'}</h2>
        <div className="dialog-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <div key={id} role="tab" aria-selected={tab === id} className={`dialog-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {label}
              {id === 'variables' && variables.length > 0 && <span className="badge">{variables.length}</span>}
            </div>
          ))}
        </div>
        <div className="body">
          {tab === 'general' && (
            <div className="form-grid">
              <label htmlFor="api-name">Nombre</label>
              <input id="api-name" autoFocus value={name} placeholder="Motor de reservas" onChange={(e) => setName(e.target.value)} />

              <label htmlFor="api-url">URL base</label>
              <input
                id="api-url"
                className="mono-input"
                value={baseUrl}
                placeholder="https://api.ejemplo.com/v1"
                onChange={(e) => setBaseUrl(e.target.value)}
              />

              <label htmlFor="api-env">Entorno</label>
              <select id="api-env" value={environment} onChange={(e) => setEnvironment(e.target.value as Environment)}>
                {(Object.keys(ENV_LABEL) as Environment[]).map((env) => (
                  <option key={env} value={env}>
                    {ENV_LABEL[env]}
                  </option>
                ))}
              </select>
              {environment === 'prod' && (
                <>
                  <span />
                  <span className="note">En producción, las llamadas que modifican datos piden confirmación reforzada.</span>
                </>
              )}

              <label htmlFor="api-desc" className="top">
                Descripción
              </label>
              <textarea
                id="api-desc"
                rows={4}
                value={description}
                placeholder="Para qué sirve esta API y quién la mantiene"
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          )}

          {tab === 'auth' && (
            <>
              <div className="form-grid">
                <label htmlFor="auth-type">Tipo</label>
                <select id="auth-type" value={auth.type} onChange={(e) => setAuth(authOf(e.target.value as AuthType, auth))}>
                  {(Object.keys(AUTH_LABEL) as AuthType[]).map((t) => (
                    <option key={t} value={t}>
                      {AUTH_LABEL[t]}
                    </option>
                  ))}
                </select>

                {auth.type === 'bearer' && fixedSecret('token')}
                {auth.type === 'basic' && (
                  <>
                    <label htmlFor="auth-user">Usuario</label>
                    <input id="auth-user" value={auth.username} onChange={(e) => setAuth({ ...auth, username: e.target.value })} />
                    {fixedSecret('password')}
                  </>
                )}
                {auth.type === 'apiKey' && (
                  <>
                    <label htmlFor="auth-key-name">Nombre</label>
                    <div className="row">
                      <input id="auth-key-name" value={auth.name} onChange={(e) => setAuth({ ...auth, name: e.target.value })} />
                      <select
                        aria-label="Dónde va la clave"
                        value={auth.in}
                        onChange={(e) => setAuth({ ...auth, in: e.target.value as 'header' | 'query' })}
                      >
                        <option value="header">En una cabecera</option>
                        <option value="query">En la URL</option>
                      </select>
                    </div>
                    {fixedSecret('apiKey')}
                  </>
                )}
                {auth.type === 'oauth2' && (
                  <>
                    <label htmlFor="auth-token-url">URL del token</label>
                    <input
                      id="auth-token-url"
                      className="mono-input"
                      value={auth.tokenUrl}
                      placeholder="https://login.ejemplo.com/oauth/token"
                      onChange={(e) => setAuth({ ...auth, tokenUrl: e.target.value })}
                    />
                    <label htmlFor="auth-client">Client ID</label>
                    <input id="auth-client" value={auth.clientId} onChange={(e) => setAuth({ ...auth, clientId: e.target.value })} />
                    <label htmlFor="auth-scope">Scope</label>
                    <input id="auth-scope" value={auth.scope ?? ''} placeholder="Opcional" onChange={(e) => setAuth({ ...auth, scope: e.target.value })} />
                    {fixedSecret('clientSecret')}
                  </>
                )}
              </div>

              {auth.type === 'oauth2' && (
                <p className="note spaced">El token se pide solo antes de la primera llamada y se renueva cuando caduca.</p>
              )}

              {auth.type === 'custom' && (
                <>
                  <p className="note spaced">
                    Para APIs que piden sus claves con otros nombres o en otros sitios: por ejemplo <code>access_token</code> y{' '}
                    <code>access_token_secret</code> dentro del cuerpo JSON, o una cabecera <code>X-Tenant</code>. Cada valor se guarda
                    cifrado. En el cuerpo, los puntos anidan: <code>auth.token</code>.
                  </p>
                  <table className="param-edit">
                    <thead>
                      <tr>
                        <th>Nombre</th>
                        <th>Dónde va</th>
                        <th>Valor</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {auth.fields.map((f, i) => (
                        <tr key={i}>
                          <td>
                            <input
                              aria-label="Nombre del campo"
                              className="mono-input"
                              value={f.name}
                              onChange={(e) => setAuthField(i, { name: e.target.value })}
                            />
                          </td>
                          <td>
                            <select aria-label="Dónde va" value={f.in} onChange={(e) => setAuthField(i, { in: e.target.value as AuthFieldLocation })}>
                              {(Object.keys(AUTH_FIELD_IN_LABEL) as AuthFieldLocation[]).map((l) => (
                                <option key={l} value={l}>
                                  {AUTH_FIELD_IN_LABEL[l]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>{secretInput(fieldSecret(f.name), `Valor de ${f.name}`)}</td>
                          <td>
                            <button
                              className="icon"
                              title="Quitar campo"
                              disabled={auth.fields.length === 1}
                              onClick={() => setAuth({ ...auth, fields: auth.fields.filter((_, j) => j !== i) })}
                            >
                              <Icon name="minus" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button className="link" onClick={() => setAuth({ ...auth, fields: [...auth.fields, { name: '', in: 'body' }] })}>
                    + Añadir campo
                  </button>
                  <p className="note">Si cambias el nombre de un campo ya guardado, tendrás que volver a escribir su valor.</p>
                </>
              )}

              {authSecrets(auth).length > 0 && secretStatus && !secretStatus.persistent && (
                <div className="notice warn spaced">
                  No hay llavero del sistema disponible: los secretos solo se guardan mientras la app esté abierta.
                </div>
              )}
            </>
          )}

          {tab === 'variables' && (
            <>
              <p className="note">
                Valores que se repiten en muchas llamadas. Úsalos como <code>{'{{nombre}}'}</code> en la URL, las cabeceras, el cuerpo, los
                ejemplos de los parámetros y la plantilla de cuerpo. Un <b>listado</b> guarda varios valores con nombre (los hoteles dados de
                alta, por ejemplo): en la ficha de cada endpoint eliges cuál usar por su nombre, sin memorizar códigos.
              </p>
              {variables.map((v, i) => (
                <VariableCard
                  key={i}
                  variable={v}
                  onChange={(patch) => setVariable(i, patch)}
                  onRemove={() => setVariables((list) => list.filter((_, j) => j !== i))}
                />
              ))}
              <div className="row spaced">
                <button className="compact" onClick={() => setVariables((list) => [...list, { name: '', value: '' }])}>
                  <Icon name="plus" /> Variable
                </button>
                <button className="compact" onClick={() => setVariables((list) => [...list, { name: '', value: '', options: [] }])}>
                  <Icon name="plus" /> Listado
                </button>
              </div>
              <h3 className="dialog-section">Variables automáticas</h3>
              <div className="builtin-list">
                {BUILTIN_HELP.map(([name, help]) => (
                  <div key={name}>
                    <code>{`{{${name}}}`}</code> <span className="note">{help}</span>
                  </div>
                ))}
              </div>
              <h3 className="dialog-section">Datos que se piden al llamar</h3>
              <p className="note">En el cuerpo, la ruta o una cabecera, un hueco con tipo hace que la ficha del endpoint muestre su campo:</p>
              <div className="builtin-list">
                {INLINE_HELP.map(([code, help]) => (
                  <div key={code}>
                    <code>{code}</code> <span className="note">{help}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'advanced' && (
            <>
              <h3 className="dialog-section first">Cabeceras comunes</h3>
              <p className="note">Se envían en todas las llamadas de esta API (por ejemplo, Accept-Language).</p>
              {headers.map((h, i) => (
                <div className="header-row" key={i}>
                  <input aria-label="Nombre de la cabecera" placeholder="Nombre" value={h.name} onChange={(e) => setHeader(i, { name: e.target.value })} />
                  <input aria-label="Valor de la cabecera" placeholder="Valor" value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} />
                  <button className="icon" title="Quitar cabecera" onClick={() => setHeaders((list) => list.filter((_, j) => j !== i))}>
                    <Icon name="minus" />
                  </button>
                </div>
              ))}
              <button className="link" onClick={() => setHeaders((list) => [...list, { name: '', value: '' }])}>
                + Añadir cabecera
              </button>

              <h3 className="dialog-section">Plantilla de cuerpo</h3>
              <p className="note">
                Para APIs en las que todas las llamadas envían la misma estructura y solo cambia una parte. Escribe <code>{'{{body}}'}</code>{' '}
                <b>sin comillas</b> donde vaya el cuerpo de cada endpoint; los demás huecos se rellenan con las variables y con los valores
                fijos de cada endpoint (<code>resource</code>, <code>task</code>…). Entre comillas, una variable se envía como texto; sin
                comillas, con su tipo (número, sí/no…).
              </p>
              <textarea
                id="api-body-template"
                className={`mono-input ${templateError ? 'invalid' : ''}`}
                rows={7}
                spellCheck={false}
                value={bodyTemplate}
                placeholder={TEMPLATE_EXAMPLE}
                onChange={(e) => setBodyTemplate(e.target.value)}
              />
              {templateError && <div className="notice error">No es JSON válido: {templateError}</div>}
              {!bodyTemplate && (
                <button className="link" onClick={() => setBodyTemplate(TEMPLATE_EXAMPLE)}>
                  Usar el ejemplo
                </button>
              )}

              <h3 className="dialog-section">Cómo saber si fue bien</h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={rule !== null}
                  onChange={(e) => setRule(e.target.checked ? { successPath: 'status', successValue: 'success', messagePath: 'message' } : null)}
                />
                La API responde siempre 200 y dice en el cuerpo si la llamada fue bien
              </label>
              {rule && (
                <div className="form-grid spaced">
                  <label htmlFor="rule-path">Campo</label>
                  <input
                    id="rule-path"
                    className="mono-input"
                    value={rule.successPath}
                    placeholder="status"
                    onChange={(e) => setRule({ ...rule, successPath: e.target.value })}
                  />
                  <label htmlFor="rule-value">Valor si fue bien</label>
                  <input
                    id="rule-value"
                    className="mono-input"
                    value={rule.successValue}
                    placeholder="success"
                    onChange={(e) => setRule({ ...rule, successValue: e.target.value })}
                  />
                  <label htmlFor="rule-message">Campo del mensaje</label>
                  <input
                    id="rule-message"
                    className="mono-input"
                    value={rule.messagePath ?? ''}
                    placeholder="message (opcional)"
                    onChange={(e) => setRule({ ...rule, messagePath: e.target.value })}
                  />
                  <span />
                  <span className="note">Usa puntos para campos anidados: result.code, error.description…</span>
                </div>
              )}

              <h3 className="dialog-section">Endpoints nuevos</h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={defaults !== null}
                  onChange={(e) => setDefaults(e.target.checked ? { method: 'POST', path: '' } : null)}
                />
                Empezar con un método y una ruta fijos
              </label>
              {defaults && (
                <div className="form-grid spaced">
                  <label htmlFor="defaults-path">Llamada</label>
                  <div className="row">
                    <select
                      aria-label="Método por defecto"
                      className="method-select"
                      value={defaults.method}
                      onChange={(e) => setDefaults({ ...defaults, method: e.target.value as HttpMethod })}
                    >
                      {HTTP_METHODS.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                    <input
                      id="defaults-path"
                      className="mono-input"
                      value={defaults.path}
                      placeholder="(vacía: la URL base)"
                      onChange={(e) => setDefaults({ ...defaults, path: e.target.value })}
                    />
                  </div>
                </div>
              )}

              <h3 className="dialog-section">Tiempo de espera</h3>
              <div className="row">
                <input
                  id="api-timeout"
                  type="number"
                  min={1}
                  max={3600}
                  className="narrow"
                  value={timeout}
                  placeholder="60"
                  onChange={(e) => setTimeoutSeconds(e.target.value)}
                />
                <span className="note">segundos sin respuesta antes de cancelar la llamada</span>
              </div>
            </>
          )}

          {error && <div className="notice error spaced">{error}</div>}
        </div>
        <div className="footer">
          <div className="spacer" />
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={saving || !!templateError} onClick={() => void save()}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  )
}

/** Una variable: valor único o listado de opciones con nombre. */
function VariableCard({ variable: v, onChange, onRemove }: { variable: ApiVariable; onChange: (patch: Partial<ApiVariable>) => void; onRemove: () => void }) {
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const options = v.options

  const setOption = (index: number, patch: Partial<{ label: string; value: string }>) => {
    if (!options) return
    const before = options[index]!
    const next = options.map((o, i) => (i === index ? { ...o, ...patch } : o))
    // Si cambia el valor de la opción en uso, la variable sigue apuntando a ella.
    onChange({ options: next, value: v.value === before.value && patch.value !== undefined ? patch.value : v.value })
  }

  return (
    <div className="var-card">
      <div className="var-head">
        <span className="dim mono">{'{{'}</span>
        <input
          aria-label="Nombre de la variable"
          className="mono-input var-name"
          placeholder="hotel_id"
          value={v.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <span className="dim mono">{'}}'}</span>
        <input
          aria-label="Descripción de la variable"
          placeholder="Qué es (opcional)"
          value={v.description ?? ''}
          onChange={(e) => onChange({ description: e.target.value })}
        />
        <select
          aria-label="Tipo de variable"
          value={options ? 'list' : 'single'}
          onChange={(e) =>
            onChange(
              e.target.value === 'list'
                ? { options: v.value ? [{ label: v.value, value: v.value }] : [] }
                : { options: undefined }
            )
          }
        >
          <option value="single">Valor único</option>
          <option value="list">Listado</option>
        </select>
        <button className="icon" title="Quitar variable" onClick={onRemove}>
          <Icon name="trash" />
        </button>
      </div>

      {!options ? (
        <input aria-label="Valor" className="mono-input" placeholder="Valor" value={v.value} onChange={(e) => onChange({ value: e.target.value })} />
      ) : (
        <>
          {options.length > 0 && (
            <table className="param-edit option-table">
              <thead>
                <tr>
                  <th title="La que se usa ahora">En uso</th>
                  <th>Nombre</th>
                  <th>Valor que se envía</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {options.map((o, i) => (
                  <tr key={i}>
                    <td className="center">
                      <input
                        type="radio"
                        name={`var-${v.name}-current`}
                        aria-label="Usar esta opción"
                        checked={v.value === o.value}
                        onChange={() => onChange({ value: o.value })}
                      />
                    </td>
                    <td>
                      <input aria-label="Nombre de la opción" placeholder="Hotel Punta Negra" value={o.label} onChange={(e) => setOption(i, { label: e.target.value })} />
                    </td>
                    <td>
                      <input
                        aria-label="Valor de la opción"
                        className="mono-input"
                        placeholder="100001"
                        value={o.value}
                        onChange={(e) => setOption(i, { value: e.target.value })}
                      />
                    </td>
                    <td>
                      <button className="icon" title="Quitar opción" onClick={() => onChange({ options: options.filter((_, j) => j !== i) })}>
                        <Icon name="minus" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="row">
            <button className="link" onClick={() => onChange({ options: [...options, { label: '', value: '' }] })}>
              + Añadir opción
            </button>
            <button className="link" onClick={() => setPasting(!pasting)}>
              Pegar varias
            </button>
          </div>
          {pasting && (
            <div className="paste-box">
              <textarea
                aria-label="Opciones pegadas"
                className="mono-input"
                rows={4}
                value={pasted}
                placeholder={'Una por línea: nombre;valor\nHotel Punta Negra;100001\nHotel Cozy;100002'}
                onChange={(e) => setPasted(e.target.value)}
              />
              <div className="row">
                <span className="note">También vale «nombre=valor» o dos columnas copiadas de una hoja de cálculo.</span>
                <span className="spacer" />
                <button
                  className="compact"
                  disabled={!pasted.trim()}
                  onClick={() => {
                    const added = parseOptions(pasted)
                    onChange({ options: [...options, ...added], value: v.value || added[0]?.value || '' })
                    setPasted('')
                    setPasting(false)
                  }}
                >
                  Añadir {parseOptions(pasted).length || ''}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
