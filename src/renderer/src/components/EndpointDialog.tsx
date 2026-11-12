import { useState } from 'react'
import {
  HTTP_METHODS,
  type ApiSummary,
  type BodyKind,
  type Endpoint,
  type EndpointParam,
  type HttpMethod,
  type NameValue,
  type ParamLocation,
  type ParamType
} from '@shared/types'
import { INLINE_HELP, variableNames } from '@shared/template'
import { joinUrl, pathParamNames, syncPathParams } from '@shared/url'
import { flattenFolders } from '@shared/folders'
import { BODY_LABEL, PARAM_IN_HELP, PARAM_IN_LABEL, PARAM_TYPE_LABEL } from '../lib/labels'
import { Icon } from './Icon'

interface Props {
  api: ApiSummary
  /** null = endpoint nuevo. */
  initial: Endpoint | null
  /** Carpeta en la que se crea un endpoint nuevo. */
  folderId?: string
  onClose: () => void
  onSaved: (api: ApiSummary, endpointId: string) => void
}

const WITH_BODY: HttpMethod[] = ['POST', 'PUT', 'PATCH']
/** Métodos que normalmente solo leen: no piden confirmación por defecto. */
const READ_ONLY: HttpMethod[] = ['GET', 'HEAD', 'OPTIONS']

/** Alta y edición de un endpoint: qué hace, a qué ruta llama y qué datos pide. */
export function EndpointDialog({ api, initial, folderId: startFolder, onClose, onSaved }: Props) {
  const defaults = api.endpointDefaults
  // Con plantilla de cuerpo, la API espera cuerpo en todas las llamadas: GET no serviría.
  const startMethod = initial?.method ?? defaults?.method ?? (api.bodyTemplate ? 'POST' : 'GET')
  const [name, setName] = useState(initial?.name ?? '')
  const [method, setMethod] = useState<HttpMethod>(startMethod)
  const [path, setPath] = useState(initial?.path ?? defaults?.path ?? '/')
  const [folderId, setFolderId] = useState(initial ? (initial.folderId ?? '') : (startFolder ?? ''))
  const [description, setDescription] = useState(initial?.description ?? '')
  const [params, setParams] = useState<EndpointParam[]>(initial?.params ?? [])
  const [bodyKind, setBodyKind] = useState<BodyKind>(
    initial?.body.kind ?? (api.bodyTemplate || WITH_BODY.includes(startMethod) ? 'json' : 'none')
  )
  const [bodyExample, setBodyExample] = useState(initial?.body.example ?? '')
  const [bodyDescription, setBodyDescription] = useState(initial?.body.description ?? '')
  const [useTemplate, setUseTemplate] = useState(initial?.body.useTemplate !== false)
  const [vars, setVars] = useState<NameValue[]>(initial?.vars ?? [])
  const [modifies, setModifies] = useState(initial?.modifies ?? !READ_ONLY.includes(startMethod))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const listVars = api.variables.filter((v) => v.options)
  // Huecos de la plantilla que no son variables de la conexión: los tiene que rellenar cada endpoint.
  const templateSlots = api.bodyTemplate
    ? variableNames(api.bodyTemplate).filter((n) => n !== 'body' && !n.startsWith('$') && !api.variables.some((v) => v.name === n))
    : []
  const setVar = (index: number, patch: Partial<NameValue>) => setVars((list) => list.map((v, i) => (i === index ? { ...v, ...patch } : v)))
  const pathNames = pathParamNames(path)

  const changePath = (value: string) => {
    setPath(value)
    setParams((list) => syncPathParams(value, list))
  }

  const changeMethod = (value: HttpMethod) => {
    setMethod(value)
    // Al pasar a un método que suele llevar cuerpo, se propone JSON; nunca se borra lo escrito.
    if (bodyKind === 'none' && WITH_BODY.includes(value) && !initial) setBodyKind('json')
    if (!initial) setModifies(!READ_ONLY.includes(value))
  }

  const setParam = (index: number, patch: Partial<EndpointParam>) =>
    setParams((list) => list.map((p, i) => (i === index ? { ...p, ...patch } : p)))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const clean = (s: string) => (s.trim() === '' ? undefined : s)
      const saved = await window.api.saveEndpoint(api.id, {
        id: initial?.id,
        name,
        method,
        path,
        folderId: folderId || undefined,
        description: clean(description),
        params: params
          .filter((p) => p.name.trim() !== '')
          .map((p) => ({
            ...p,
            description: clean(p.description ?? ''),
            example: clean(p.example ?? ''),
            options: p.type === 'enum' && !p.optionsFrom ? (p.options ?? []).map((o) => o.trim()).filter((o) => o !== '') : undefined,
            optionsFrom: p.type === 'enum' ? p.optionsFrom : undefined
          })),
        body: {
          kind: bodyKind,
          example: clean(bodyExample),
          description: clean(bodyDescription),
          useTemplate: api.bodyTemplate && !useTemplate ? false : undefined
        },
        vars: vars.filter((v) => v.name.trim() !== ''),
        modifies
      })
      // Sin id previo, el nuevo es el último de la lista.
      onSaved(saved, initial?.id ?? saved.endpoints.at(-1)!.id)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog wide"
        role="dialog"
        aria-label={initial ? 'Editar endpoint' : 'Nuevo endpoint'}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>
          {initial ? `Editar «${initial.name}»` : 'Nuevo endpoint'} <span className="dim">· {api.name}</span>
        </h2>
        <div className="body">
          <div className="form-grid">
            <label htmlFor="ep-name">Nombre</label>
            <input id="ep-name" autoFocus value={name} placeholder="Buscar reservas" onChange={(e) => setName(e.target.value)} />

            <label htmlFor="ep-path">Llamada</label>
            <div className="row">
              <select aria-label="Método" className="method-select" value={method} onChange={(e) => changeMethod(e.target.value as HttpMethod)}>
                {HTTP_METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input id="ep-path" className="mono-input" value={path} placeholder="/reservas/{id}" onChange={(e) => changePath(e.target.value)} />
            </div>
            <span />
            <span className="note mono">{joinUrl(api.baseUrl, path)}</span>

            <label htmlFor="ep-folder">Carpeta</label>
            <select id="ep-folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">— Sin carpeta —</option>
              {flattenFolders(api.folders).map(({ folder, depth }) => (
                <option key={folder.id} value={folder.id}>
                  {'\u00a0\u00a0\u00a0'.repeat(depth)}
                  {folder.name}
                </option>
              ))}
            </select>

            <label htmlFor="ep-desc" className="top">
              Qué hace
            </label>
            <textarea
              id="ep-desc"
              rows={4}
              value={description}
              placeholder="Explícalo para alguien que no conoce la API: qué devuelve, cuándo usarlo, qué tener en cuenta…"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <h3 className="dialog-section">Datos que pide</h3>
          {params.length === 0 ? (
            <p className="note">
              Sin parámetros. Los de la ruta (entre llaves, como {'{id}'}) se añaden solos. Los del cuerpo usan puntos para anidar
              (filters.hotel_id).
            </p>
          ) : (
            <table className="param-edit">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Dónde</th>
                  <th>Tipo</th>
                  <th title="Obligatorio">Oblig.</th>
                  <th>Ejemplo</th>
                  <th>Qué significa</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {params.map((p, i) => {
                  const fromPath = p.in === 'path' && pathNames.includes(p.name)
                  return (
                    <tr key={i}>
                      <td>
                        <input
                          aria-label="Nombre del parámetro"
                          className="mono-input"
                          placeholder={p.in === 'body' ? 'filters.hotel_id' : ''}
                          value={p.name}
                          readOnly={fromPath}
                          title={fromPath ? 'Viene de la ruta: cámbialo allí' : undefined}
                          onChange={(e) => setParam(i, { name: e.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          aria-label="Dónde va"
                          value={p.in}
                          disabled={fromPath}
                          title={PARAM_IN_HELP[p.in]}
                          onChange={(e) => setParam(i, { in: e.target.value as ParamLocation })}
                        >
                          {(Object.keys(PARAM_IN_LABEL) as ParamLocation[]).map((l) => (
                            <option key={l} value={l}>
                              {PARAM_IN_LABEL[l]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select aria-label="Tipo" value={p.type} onChange={(e) => setParam(i, { type: e.target.value as ParamType })}>
                          {(Object.keys(PARAM_TYPE_LABEL) as ParamType[]).map((t) => (
                            <option key={t} value={t}>
                              {PARAM_TYPE_LABEL[t]}
                            </option>
                          ))}
                        </select>
                        {p.type === 'enum' && listVars.length > 0 && (
                          <select
                            aria-label="De dónde salen los valores"
                            className="enum-options"
                            value={p.optionsFrom ?? ''}
                            onChange={(e) => setParam(i, { optionsFrom: e.target.value || undefined })}
                          >
                            <option value="">Valores escritos aquí</option>
                            {listVars.map((v) => (
                              <option key={v.name} value={v.name}>
                                Listado {`{{${v.name}}}`}
                              </option>
                            ))}
                          </select>
                        )}
                        {p.type === 'enum' && !p.optionsFrom && (
                          <input
                            aria-label="Valores posibles"
                            className="enum-options"
                            placeholder="Valores, separados por comas"
                            value={(p.options ?? []).join(',')}
                            // Se recorta al guardar: aquí se respeta lo escrito (valores con espacios).
                            onChange={(e) => setParam(i, { options: e.target.value.split(',') })}
                          />
                        )}
                      </td>
                      <td className="center">
                        <input
                          type="checkbox"
                          aria-label="Obligatorio"
                          checked={p.required}
                          disabled={fromPath}
                          onChange={(e) => setParam(i, { required: e.target.checked })}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Ejemplo"
                          placeholder="Admite {{variables}}"
                          value={p.example ?? ''}
                          onChange={(e) => setParam(i, { example: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Qué significa"
                          value={p.description ?? ''}
                          onChange={(e) => setParam(i, { description: e.target.value })}
                        />
                      </td>
                      <td>
                        <button
                          className="icon"
                          title={fromPath ? 'Quítalo de la ruta para borrarlo' : 'Quitar parámetro'}
                          disabled={fromPath}
                          onClick={() => setParams((list) => list.filter((_, j) => j !== i))}
                        >
                          <Icon name="minus" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <button
            className="link"
            onClick={() => setParams((list) => [...list, { name: '', in: 'query', type: 'string', required: false }])}
          >
            + Añadir parámetro
          </button>

          <h3 className="dialog-section">Cuerpo de la petición</h3>
          {api.bodyTemplate && (
            <label className="check spaced">
              <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} />
              Envolver en la plantilla de cuerpo de la API (el cuerpo de aquí va donde pone {'{{body}}'})
            </label>
          )}
          <div className="form-grid">
            <label htmlFor="ep-body-kind">Formato</label>
            <select id="ep-body-kind" value={bodyKind} onChange={(e) => setBodyKind(e.target.value as BodyKind)}>
              {(Object.keys(BODY_LABEL) as BodyKind[]).map((k) => (
                <option key={k} value={k}>
                  {BODY_LABEL[k]}
                </option>
              ))}
            </select>
            {bodyKind !== 'none' && (
              <>
                <label htmlFor="ep-body-desc">Qué contiene</label>
                <input id="ep-body-desc" value={bodyDescription} onChange={(e) => setBodyDescription(e.target.value)} />
                <label htmlFor="ep-body" className="top">
                  Ejemplo
                </label>
                <textarea
                  id="ep-body"
                  className="mono-input"
                  rows={6}
                  spellCheck={false}
                  value={bodyExample}
                  placeholder={bodyKind === 'json' ? '{\n  "hotel": "MEN",\n  "noches": 3\n}' : 'hotel=MEN\nnoches=3'}
                  onChange={(e) => setBodyExample(e.target.value)}
                />
                <span />
                <div className="note">
                  Para pedir un dato al llamar, escribe un hueco con tipo y la ficha mostrará su campo:{' '}
                  {INLINE_HELP.map(([code, help], i) => (
                    <span key={code}>
                      {i > 0 && ' · '}
                      <code>{code}</code> {help}
                    </span>
                  ))}
                  . Entre comillas va como texto; sin comillas, como número o sí/no.
                </div>
              </>
            )}
          </div>

          <h3 className="dialog-section">Valores fijos</h3>
          <p className="note">
            Variables que solo valen para este endpoint: se usan como {'{{nombre}}'} igual que las de la API y mandan sobre ellas.
            {templateSlots.length > 0 && (
              <>
                {' '}
                La plantilla de cuerpo de la API espera:{' '}
                {templateSlots.map((slot, i) => (
                  <span key={slot}>
                    {i > 0 && ', '}
                    <code>{slot}</code>
                  </span>
                ))}
                .
              </>
            )}
          </p>
          {vars.map((v, i) => (
            <div className="header-row" key={i}>
              <input aria-label="Nombre del valor fijo" className="mono-input" placeholder="resource" value={v.name} onChange={(e) => setVar(i, { name: e.target.value })} />
              <input aria-label="Valor fijo" className="mono-input" placeholder="booking" value={v.value} onChange={(e) => setVar(i, { value: e.target.value })} />
              <button className="icon" title="Quitar valor fijo" onClick={() => setVars((list) => list.filter((_, j) => j !== i))}>
                <Icon name="minus" />
              </button>
            </div>
          ))}
          <div className="row">
            <button className="link" onClick={() => setVars((list) => [...list, { name: '', value: '' }])}>
              + Añadir valor fijo
            </button>
            {templateSlots
              .filter((slot) => !vars.some((v) => v.name === slot))
              .map((slot) => (
                <button key={slot} className="link" onClick={() => setVars((list) => [...list, { name: slot, value: '' }])}>
                  + {slot}
                </button>
              ))}
          </div>

          <h3 className="dialog-section">Seguridad</h3>
          <label className="check">
            <input type="checkbox" checked={modifies} onChange={(e) => setModifies(e.target.checked)} />
            Modifica datos: pedir confirmación antes de enviar
          </label>

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
