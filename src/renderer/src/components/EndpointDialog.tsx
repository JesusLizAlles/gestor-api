import { useState } from 'react'
import {
  HTTP_METHODS,
  type ApiSummary,
  type BodyKind,
  type Endpoint,
  type EndpointParam,
  type HttpMethod,
  type ParamLocation,
  type ParamType
} from '@shared/types'
import { joinUrl, pathParamNames, syncPathParams } from '@shared/url'
import { BODY_LABEL, PARAM_IN_HELP, PARAM_IN_LABEL, PARAM_TYPE_LABEL } from '../lib/labels'
import { Icon } from './Icon'

interface Props {
  api: ApiSummary
  /** null = endpoint nuevo. */
  initial: Endpoint | null
  onClose: () => void
  onSaved: (api: ApiSummary, endpointId: string) => void
}

const WITH_BODY: HttpMethod[] = ['POST', 'PUT', 'PATCH']

/** Alta y edición de un endpoint: qué hace, a qué ruta llama y qué datos pide. */
export function EndpointDialog({ api, initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [method, setMethod] = useState<HttpMethod>(initial?.method ?? 'GET')
  const [path, setPath] = useState(initial?.path ?? '/')
  const [group, setGroup] = useState(initial?.group ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [params, setParams] = useState<EndpointParam[]>(initial?.params ?? [])
  const [bodyKind, setBodyKind] = useState<BodyKind>(initial?.body.kind ?? 'none')
  const [bodyExample, setBodyExample] = useState(initial?.body.example ?? '')
  const [bodyDescription, setBodyDescription] = useState(initial?.body.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const groups = [...new Set(api.endpoints.map((e) => e.group).filter((g): g is string => !!g))]
  const pathNames = pathParamNames(path)

  const changePath = (value: string) => {
    setPath(value)
    setParams((list) => syncPathParams(value, list))
  }

  const changeMethod = (value: HttpMethod) => {
    setMethod(value)
    // Al pasar a un método que suele llevar cuerpo, se propone JSON; nunca se borra lo escrito.
    if (bodyKind === 'none' && WITH_BODY.includes(value) && !initial) setBodyKind('json')
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
        group: clean(group),
        description: clean(description),
        params: params
          .filter((p) => p.name.trim() !== '')
          .map((p) => ({
            ...p,
            description: clean(p.description ?? ''),
            example: clean(p.example ?? ''),
            options: p.type === 'enum' ? (p.options ?? []).map((o) => o.trim()).filter((o) => o !== '') : undefined
          })),
        body: { kind: bodyKind, example: clean(bodyExample), description: clean(bodyDescription) }
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

            <label htmlFor="ep-group">Grupo</label>
            <input
              id="ep-group"
              list="ep-groups"
              value={group}
              placeholder="Opcional: carpeta en la que aparece (Reservas, Clientes…)"
              onChange={(e) => setGroup(e.target.value)}
            />
            <datalist id="ep-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>

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
            <p className="note">Sin parámetros. Los de la ruta (entre llaves, como {'{id}'}) se añaden solos.</p>
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
                        {p.type === 'enum' && (
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
                        <input aria-label="Ejemplo" value={p.example ?? ''} onChange={(e) => setParam(i, { example: e.target.value })} />
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
              </>
            )}
          </div>

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
