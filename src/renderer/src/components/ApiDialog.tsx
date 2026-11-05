import { Fragment, useState } from 'react'
import {
  AUTH_SECRETS,
  type ApiSummary,
  type AuthConfig,
  type AuthType,
  type Environment,
  type HeaderEntry,
  type SecretKey,
  type SecretStorageStatus,
  type SecretsPatch
} from '@shared/types'
import { AUTH_LABEL, ENV_LABEL, SECRET_LABEL } from '../lib/labels'
import { Icon } from './Icon'

interface Props {
  /** null = API nueva. */
  initial: ApiSummary | null
  secretStatus: SecretStorageStatus | null
  onClose: () => void
  onSaved: (api: ApiSummary) => void
}

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
  }
}

/** Alta y edición de una API: datos generales, autenticación y cabeceras comunes. */
export function ApiDialog({ initial, secretStatus, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'https://')
  const [environment, setEnvironment] = useState<Environment>(initial?.environment ?? 'dev')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [auth, setAuth] = useState<AuthConfig>(initial?.auth ?? { type: 'none' })
  const [headers, setHeaders] = useState<HeaderEntry[]>(initial?.headers ?? [])
  /** Solo los secretos que el usuario ha escrito o quiere borrar; el resto no se toca. */
  const [secrets, setSecrets] = useState<SecretsPatch>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const stored = new Set(initial?.storedSecrets ?? [])
  const secretKeys = AUTH_SECRETS[auth.type]

  const setHeader = (index: number, patch: Partial<HeaderEntry>) =>
    setHeaders((list) => list.map((h, i) => (i === index ? { ...h, ...patch } : h)))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = await window.api.saveApi({
        config: {
          id: initial?.id,
          name,
          baseUrl,
          environment,
          description: description || undefined,
          auth,
          headers: headers.filter((h) => h.name.trim() !== '')
        },
        secrets
      })
      onSaved(saved)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  const secretField = (key: SecretKey) => {
    const value = secrets[key]
    const removing = value === null
    return (
      <>
        <label htmlFor={`secret-${key}`}>{SECRET_LABEL[key]}</label>
        <div className="row">
          <input
            id={`secret-${key}`}
            type="password"
            autoComplete="off"
            disabled={removing}
            value={typeof value === 'string' ? value : ''}
            placeholder={stored.has(key) && !removing ? 'Guardado · déjalo vacío para no cambiarlo' : ''}
            onChange={(e) => setSecrets((s) => ({ ...s, [key]: e.target.value || undefined }))}
          />
          {stored.has(key) && (
            <button className="compact" onClick={() => setSecrets((s) => ({ ...s, [key]: removing ? undefined : null }))}>
              {removing ? 'No quitar' : 'Quitar'}
            </button>
          )}
        </div>
      </>
    )
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={initial ? 'Editar API' : 'Nueva API'} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{initial ? `Editar «${initial.name}»` : 'Nueva API'}</h2>
        <div className="body">
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

            <label htmlFor="api-desc" className="top">
              Descripción
            </label>
            <textarea
              id="api-desc"
              rows={3}
              value={description}
              placeholder="Para qué sirve esta API y quién la mantiene"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <h3 className="dialog-section">
            <Icon name="lock" /> Autenticación
          </h3>
          <div className="form-grid">
            <label htmlFor="auth-type">Tipo</label>
            <select id="auth-type" value={auth.type} onChange={(e) => setAuth(authOf(e.target.value as AuthType, auth))}>
              {(Object.keys(AUTH_LABEL) as AuthType[]).map((t) => (
                <option key={t} value={t}>
                  {AUTH_LABEL[t]}
                </option>
              ))}
            </select>

            {auth.type === 'basic' && (
              <>
                <label htmlFor="auth-user">Usuario</label>
                <input id="auth-user" value={auth.username} onChange={(e) => setAuth({ ...auth, username: e.target.value })} />
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
                <input
                  id="auth-scope"
                  value={auth.scope ?? ''}
                  placeholder="Opcional"
                  onChange={(e) => setAuth({ ...auth, scope: e.target.value })}
                />
              </>
            )}
            {secretKeys.map((key) => (
              <Fragment key={key}>{secretField(key)}</Fragment>
            ))}
          </div>
          {secretKeys.length > 0 && secretStatus && !secretStatus.persistent && (
            <div className="notice warn spaced">
              No hay llavero del sistema disponible: los secretos solo se guardan mientras la app esté abierta.
            </div>
          )}

          <h3 className="dialog-section">Cabeceras comunes</h3>
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

          {error && <div className="notice error spaced">{error}</div>}
        </div>
        <div className="footer">
          <div className="spacer" />
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={saving} onClick={() => void save()}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  )
}
