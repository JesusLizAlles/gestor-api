import { useEffect, useRef, useState } from 'react'
import type { ApiSummary, Endpoint, SecretStorageStatus } from '@shared/types'
import { ApiDialog } from './components/ApiDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { EndpointDialog } from './components/EndpointDialog'
import { EndpointView } from './components/EndpointView'
import { Icon } from './components/Icon'
import { MethodBadge } from './components/MethodBadge'
import { UpdateControls } from './components/UpdateControls'
import { AUTH_BADGE, AUTH_LABEL, ENV_LABEL } from './lib/labels'
import { keys } from './lib/platform'

/** Una pestaña por endpoint abierto. */
interface Tab {
  apiId: string
  endpointId: string
}

const tabId = (t: Tab) => `${t.apiId}/${t.endpointId}`

type Deleting = { kind: 'api'; api: ApiSummary } | { kind: 'endpoint'; api: ApiSummary; endpoint: Endpoint }

const SIDEBAR_WIDTH = { default: 300, min: 180, max: 700 }

function readSidebarWidth(): number {
  try {
    const stored = Number(localStorage.getItem('sidebarWidth'))
    return stored >= SIDEBAR_WIDTH.min && stored <= SIDEBAR_WIDTH.max ? stored : SIDEBAR_WIDTH.default
  } catch {
    return SIDEBAR_WIDTH.default
  }
}

/** Endpoints agrupados por su carpeta, en el orden en que se crearon; los sueltos van primero. */
function groupEndpoints(endpoints: Endpoint[]): [string | null, Endpoint[]][] {
  const groups = new Map<string | null, Endpoint[]>([[null, []]])
  for (const e of endpoints) {
    const key = e.group?.trim() || null
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  return [...groups].filter(([, list]) => list.length > 0)
}

const matches = (e: Endpoint, filter: string) =>
  !filter || `${e.name} ${e.path} ${e.method} ${e.group ?? ''}`.toLowerCase().includes(filter.toLowerCase())

export function App() {
  const [apis, setApis] = useState<ApiSummary[]>([])
  const [secretStatus, setSecretStatus] = useState<SecretStorageStatus | null>(null)
  /** APIs plegadas en el panel lateral (por defecto, todas desplegadas). */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [editingApi, setEditingApi] = useState<ApiSummary | 'new' | null>(null)
  const [editingEndpoint, setEditingEndpoint] = useState<{ api: ApiSummary; endpoint: Endpoint | null } | null>(null)
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)

  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void window.api.secretStorageStatus().then(setSecretStatus)
    void window.api.listApis().then(setApis)
  })

  const replaceApi = (saved: ApiSummary) =>
    setApis((list) => (list.some((a) => a.id === saved.id) ? list.map((a) => (a.id === saved.id ? saved : a)) : [...list, saved]))

  const activeTab = tabs.find((t) => tabId(t) === activeTabId) ?? null
  const activeApi = activeTab ? apis.find((a) => a.id === activeTab.apiId) : undefined

  const openEndpoint = (apiId: string, endpointId: string) => {
    const tab = { apiId, endpointId }
    if (!tabs.some((t) => tabId(t) === tabId(tab))) setTabs((list) => [...list, tab])
    setActiveTabId(tabId(tab))
  }

  const closeTabs = (predicate: (t: Tab) => boolean) => {
    const index = tabs.findIndex((t) => tabId(t) === activeTabId)
    const next = tabs.filter((t) => !predicate(t))
    setTabs(next)
    if (next.some((t) => tabId(t) === activeTabId)) return
    const neighbour = next[Math.min(index, next.length - 1)]
    setActiveTabId(neighbour ? tabId(neighbour) : null)
  }
  const closeTab = (id: string) => closeTabs((t) => tabId(t) === id)

  const toggleApi = (id: string) =>
    setCollapsed((set) => {
      const next = new Set(set)
      if (!next.delete(id)) next.add(id)
      return next
    })

  /** Arrastrar el borde del panel lateral cambia su ancho; se recuerda al soltar. */
  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth
    let width = startWidth
    const max = Math.min(SIDEBAR_WIDTH.max, window.innerWidth - 300)
    const move = (ev: MouseEvent) => {
      width = Math.max(SIDEBAR_WIDTH.min, Math.min(max, startWidth + ev.clientX - startX))
      setSidebarWidth(width)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('col-resizing')
      try {
        localStorage.setItem('sidebarWidth', String(width))
      } catch {
        // Sin almacenamiento, el ancho solo dura esta sesión.
      }
    }
    document.body.classList.add('col-resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const resetSidebarWidth = () => {
    setSidebarWidth(SIDEBAR_WIDTH.default)
    try {
      localStorage.removeItem('sidebarWidth')
    } catch {
      // Nada que olvidar.
    }
  }

  // Atajos globales de pestañas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'w' && activeTabId) {
        e.preventDefault()
        closeTab(activeTabId)
      }
      if ((e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') && tabs.length > 1) {
        e.preventDefault()
        const step = e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1
        const index = tabs.findIndex((t) => tabId(t) === activeTabId)
        setActiveTabId(tabId(tabs[(index + step + tabs.length) % tabs.length]!))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <aside className="sidebar">
        <div
          className="sidebar-resizer"
          title="Arrastra para cambiar el ancho · doble clic para restablecerlo"
          onMouseDown={startSidebarResize}
          onDoubleClick={resetSidebarWidth}
        />
        <div className="section-title">
          APIs
          <span className="section-actions">
            <button className="icon" title="Nueva API" onClick={() => setEditingApi('new')}>
              ＋
            </button>
          </span>
        </div>
        {apis.some((a) => a.endpoints.length > 0) && (
          <div className="sidebar-filter">
            <input value={filter} placeholder="Buscar endpoint…" onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
        <div className="api-list">
          {apis.length === 0 && <div className="empty-note">Aún no hay APIs. Pulsa ＋ para añadir la primera.</div>}
          {apis.map((api) => {
            const visible = api.endpoints.filter((e) => matches(e, filter))
            if (filter && visible.length === 0) return null
            const expanded = !collapsed.has(api.id) || filter !== ''
            const badge = AUTH_BADGE[api.auth.type]
            return (
              <div key={api.id}>
                <div className="api-row" title={`${api.baseUrl}\n${AUTH_LABEL[api.auth.type]}`} onClick={() => toggleApi(api.id)}>
                  <span className="twisty">{expanded ? '▾' : '▸'}</span>
                  <span className={`env-dot env-${api.environment}`} />
                  <span className="name">{api.name}</span>
                  {badge && <span className="badge">{badge}</span>}
                  <span className="badge">{api.endpoints.length}</span>
                  <span className="actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon" title="Nuevo endpoint" onClick={() => setEditingEndpoint({ api, endpoint: null })}>
                      <Icon name="plus" />
                    </button>
                    <button className="icon" title="Editar API" onClick={() => setEditingApi(api)}>
                      <Icon name="edit" />
                    </button>
                    <button className="icon" title="Borrar API" onClick={() => setDeleting({ kind: 'api', api })}>
                      <Icon name="trash" />
                    </button>
                  </span>
                </div>
                {expanded && (
                  <div className="endpoint-tree">
                    {api.endpoints.length === 0 && (
                      <button className="link tree-empty" onClick={() => setEditingEndpoint({ api, endpoint: null })}>
                        + Añadir el primer endpoint
                      </button>
                    )}
                    {groupEndpoints(visible).map(([group, list]) => (
                      <div key={group ?? ''}>
                        {group && (
                          <div className="tree-row group-row">
                            <Icon name="folder" />
                            <span className="label">{group}</span>
                          </div>
                        )}
                        {list.map((e) => (
                          <div
                            key={e.id}
                            className={`tree-row endpoint-row ${group ? 'nested' : ''} ${
                              activeTab?.apiId === api.id && activeTab.endpointId === e.id ? 'active' : ''
                            }`}
                            title={`${e.method} ${e.path}${e.description ? `\n${e.description}` : ''}`}
                            onClick={() => openEndpoint(api.id, e.id)}
                          >
                            <MethodBadge method={e.method} />
                            <span className="label">{e.name}</span>
                            <span className="row-actions" onClick={(ev) => ev.stopPropagation()}>
                              <button className="icon" title="Editar endpoint" onClick={() => setEditingEndpoint({ api, endpoint: e })}>
                                <Icon name="edit" />
                              </button>
                              <button className="icon" title="Borrar endpoint" onClick={() => setDeleting({ kind: 'endpoint', api, endpoint: e })}>
                                <Icon name="trash" />
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      <main className="app-main">
        {tabs.length > 0 && (
          <div className="tabs" role="tablist">
            {tabs.map((t) => {
              const api = apis.find((a) => a.id === t.apiId)
              const endpoint = api?.endpoints.find((e) => e.id === t.endpointId)
              if (!api || !endpoint) return null
              const id = tabId(t)
              return (
                <div
                  key={id}
                  role="tab"
                  aria-selected={id === activeTabId}
                  className={`tab ${id === activeTabId ? 'active' : ''} env-tab-${api.environment}`}
                  title={`${api.name} · ${endpoint.method} ${endpoint.path}`}
                  onClick={() => setActiveTabId(id)}
                  onAuxClick={(e) => e.button === 1 && closeTab(id)}
                >
                  <span className={`env-dot env-${api.environment}`} />
                  <MethodBadge method={endpoint.method} />
                  {endpoint.name}
                  <span className="tab-api">{api.name}</span>
                  <button
                    className="icon"
                    title={keys('Cerrar (Ctrl+W)')}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(id)
                    }}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {tabs.map((t) => {
          const api = apis.find((a) => a.id === t.apiId)
          const endpoint = api?.endpoints.find((e) => e.id === t.endpointId)
          if (!api || !endpoint) return null
          return (
            <EndpointView
              key={tabId(t)}
              api={api}
              endpoint={endpoint}
              active={tabId(t) === activeTabId}
              onEdit={() => setEditingEndpoint({ api, endpoint })}
            />
          )
        })}

        {!activeTab && (
          <div className="welcome">
            <h1>Gestor API</h1>
            {apis.length === 0 ? (
              <>
                <div>Guarda tus APIs con su autenticación y explica cada endpoint para que cualquiera pueda usarlo.</div>
                <div className="note">Empieza añadiendo una API: su dirección base y cómo se identifica.</div>
                <button className="primary" onClick={() => setEditingApi('new')}>
                  Nueva API
                </button>
              </>
            ) : (
              <>
                <div>Elige un endpoint en el panel lateral para ver qué hace y probarlo.</div>
                <div className="note">Para añadir endpoints, pasa el ratón por una API y pulsa ＋.</div>
              </>
            )}
          </div>
        )}
      </main>

      <footer className="statusbar">
        {activeApi ? (
          <>
            <span>{activeApi.name}</span>
            <span className="mono">{activeApi.baseUrl}</span>
            <span>{ENV_LABEL[activeApi.environment]}</span>
            <span>{AUTH_LABEL[activeApi.auth.type]}</span>
          </>
        ) : (
          <span>
            {secretStatus
              ? secretStatus.persistent
                ? `Credenciales en el llavero del sistema (${secretStatus.backend})`
                : 'Sin llavero: credenciales solo en memoria'
              : ''}
          </span>
        )}
        <span className="spacer" />
        <span className="note">{keys('Clic: abrir endpoint · Ctrl+W: cerrar pestaña · Ctrl+Tab: cambiar de pestaña')}</span>
        <UpdateControls />
      </footer>

      {editingApi && (
        <ApiDialog
          initial={editingApi === 'new' ? null : editingApi}
          secretStatus={secretStatus}
          onClose={() => setEditingApi(null)}
          onSaved={(saved) => {
            setEditingApi(null)
            replaceApi(saved)
          }}
        />
      )}

      {editingEndpoint && (
        <EndpointDialog
          api={editingEndpoint.api}
          initial={editingEndpoint.endpoint}
          onClose={() => setEditingEndpoint(null)}
          onSaved={(saved, endpointId) => {
            setEditingEndpoint(null)
            replaceApi(saved)
            setCollapsed((set) => {
              const next = new Set(set)
              next.delete(saved.id)
              return next
            })
            openEndpoint(saved.id, endpointId)
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={deleting.kind === 'api' ? 'Borrar API' : 'Borrar endpoint'}
          confirmLabel="Borrar"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const target = deleting
            setDeleting(null)
            if (target.kind === 'api') {
              await window.api.deleteApi(target.api.id)
              closeTabs((t) => t.apiId === target.api.id)
              setApis((list) => list.filter((a) => a.id !== target.api.id))
            } else {
              replaceApi(await window.api.deleteEndpoint(target.api.id, target.endpoint.id))
              closeTabs((t) => t.apiId === target.api.id && t.endpointId === target.endpoint.id)
            }
          }}
        >
          {deleting.kind === 'api' ? (
            <p>
              Se borrará «{deleting.api.name}», sus {deleting.api.endpoints.length} endpoints y sus credenciales guardadas. Esta
              acción no se puede deshacer.
            </p>
          ) : (
            <p>
              Se borrará el endpoint «{deleting.endpoint.name}» de {deleting.api.name}. Esta acción no se puede deshacer.
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  )
}
