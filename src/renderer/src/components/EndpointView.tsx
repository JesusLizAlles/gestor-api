import { useState } from 'react'
import { AUTH_SECRETS, type ApiSummary, type Endpoint, type EndpointParam, type ParamLocation } from '@shared/types'
import { buildUrl, paramKey } from '@shared/url'
import { AUTH_LABEL, BODY_LABEL, PARAM_IN_HELP, PARAM_IN_LABEL, PARAM_TYPE_LABEL } from '../lib/labels'
import { Icon } from './Icon'
import { MethodBadge } from './MethodBadge'

interface Props {
  api: ApiSummary
  endpoint: Endpoint
  active: boolean
  onEdit: () => void
}

const LOCATIONS: ParamLocation[] = ['path', 'query', 'header']

/** Valores iniciales del formulario: los ejemplos de cada parámetro. */
const initialValues = (params: EndpointParam[]): Record<string, string> =>
  Object.fromEntries(params.map((p) => [paramKey(p), p.example ?? (p.type === 'enum' ? (p.options?.[0] ?? '') : '')]))

/**
 * Ficha de un endpoint: para qué sirve, qué datos pide (con un campo para cada uno) y la URL
 * que se va a llamar. Las llamadas en sí llegan en la siguiente fase.
 */
export function EndpointView({ api, endpoint, active, onEdit }: Props) {
  const [values, setValues] = useState(() => initialValues(endpoint.params))
  const [body, setBody] = useState(endpoint.body.example ?? '')

  const { url, missing } = buildUrl(api.baseUrl, endpoint.path, endpoint.params, values)
  const authSecrets = AUTH_SECRETS[api.auth.type]
  const missingSecrets = authSecrets.filter((k) => !api.storedSecrets.includes(k))

  const setValue = (p: EndpointParam, value: string) => setValues((v) => ({ ...v, [paramKey(p)]: value }))

  return (
    <div className="endpoint-view" hidden={!active}>
      <div className="endpoint-head">
        <MethodBadge method={endpoint.method} large />
        <div className="endpoint-title">
          <h1>{endpoint.name}</h1>
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
            {api.auth.type === 'none'
              ? 'Sin autenticación'
              : missingSecrets.length
                ? `${AUTH_LABEL[api.auth.type]}: falta guardar la credencial en la API`
                : `${AUTH_LABEL[api.auth.type]} · credencial guardada`}
          </div>
        </section>

        {LOCATIONS.map((location) => {
          const list = endpoint.params.filter((p) => p.in === location)
          if (list.length === 0) return null
          return (
            <section key={location}>
              <h3 title={PARAM_IN_HELP[location]}>
                {location === 'path' ? 'Datos de la dirección' : location === 'query' ? 'Filtros y opciones' : 'Cabeceras'}
                <span className="dim"> · {PARAM_IN_LABEL[location].toLowerCase()}</span>
              </h3>
              <div className="param-form">
                {list.map((p) => (
                  <ParamField key={paramKey(p)} param={p} value={values[paramKey(p)] ?? ''} onChange={(v) => setValue(p, v)} />
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
            <textarea className="body-editor mono-input" rows={10} spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} />
          </section>
        )}

        <section className="request-bar">
          <div className="request-url mono" title={url}>
            <MethodBadge method={endpoint.method} />
            <span>{url}</span>
          </div>
          {missing.length > 0 && <div className="notice warn">Falta rellenar: {missing.join(', ')}</div>}
          <div className="row">
            <button className="primary" disabled title="Las llamadas llegan en la siguiente fase">
              <Icon name="send" /> Enviar
            </button>
            <button onClick={() => void navigator.clipboard.writeText(url)}>Copiar URL</button>
            <button
              onClick={() => {
                setValues(initialValues(endpoint.params))
                setBody(endpoint.body.example ?? '')
              }}
            >
              Volver a los ejemplos
            </button>
          </div>
        </section>

        <section className="response-placeholder">Aquí aparecerá la respuesta de la API.</section>
      </div>
    </div>
  )
}

/** Campo del formulario según el tipo del parámetro, con su explicación debajo. */
function ParamField({ param, value, onChange }: { param: EndpointParam; value: string; onChange: (value: string) => void }) {
  const id = `param-${param.in}-${param.name}`
  let input
  if (param.type === 'enum') {
    input = (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {!param.required && <option value="">(sin indicar)</option>}
        {(param.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    )
  } else if (param.type === 'boolean') {
    input = (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(sin indicar)</option>
        <option value="true">Sí</option>
        <option value="false">No</option>
      </select>
    )
  } else {
    input = (
      <input
        id={id}
        type={param.type === 'number' ? 'number' : param.type === 'date' ? 'date' : 'text'}
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
        <span className="param-type">{PARAM_TYPE_LABEL[param.type]}</span>
      </label>
      {input}
      {param.description && <div className="note">{param.description}</div>}
    </div>
  )
}
