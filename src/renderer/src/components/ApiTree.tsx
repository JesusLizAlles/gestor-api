import { useEffect, useRef, useState } from 'react'
import type { ApiSummary, Endpoint, Folder, MoveInput } from '@shared/types'
import { applyMove, countEndpoints, descendantIds, folderLabel, siblings } from '@shared/folders'
import { AUTH_BADGE, AUTH_LABEL } from '../lib/labels'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { MethodBadge } from './MethodBadge'

interface Props {
  api: ApiSummary
  filter: string
  expanded: boolean
  onToggle: () => void
  activeEndpointId: string | null
  onOpen: (endpointId: string) => void
  onNewEndpoint: (folderId?: string) => void
  onEditEndpoint: (endpoint: Endpoint) => void
  onDeleteEndpoint: (endpoint: Endpoint) => void
  onEditApi: () => void
  onDeleteApi: () => void
  onDeleteFolder: (folder: Folder) => void
  onApiChanged: (api: ApiSummary) => void
}

/** Lo que se está arrastrando. Una sola ventana: basta con una variable del módulo. */
let dragged: { apiId: string; kind: MoveInput['kind']; id: string } | null = null

type Where = 'before' | 'after' | 'into'
interface Drop {
  /** Fila marcada: id de carpeta o endpoint, o 'root' para la fila de la API. */
  row: string
  where: Where
  move: MoveInput
}

/** Espera antes de abrir una carpeta plegada al pasar por encima arrastrando. */
const HOVER_OPEN_MS = 700
const INDENT = 16
const pad = (depth: number) => ({ paddingLeft: 26 + depth * INDENT })

function readCollapsed(apiId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(`collapsedFolders:${apiId}`) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

const matches = (e: Endpoint, folderText: string, filter: string) =>
  `${e.name} ${e.path} ${e.method} ${folderText}`.toLowerCase().includes(filter.toLowerCase())

/** Nombre de carpeta editable en la propia fila: Intro guarda, Escape cancela. */
function InlineName({ initial, depth, onSubmit, onCancel }: { initial: string; depth: number; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    const name = value.trim()
    if (save && name && name !== initial) onSubmit(name)
    else onCancel()
  }
  return (
    <div className="tree-row folder-row naming" style={pad(depth)}>
      <span className="twisty" />
      <Icon name="folder" />
      <input
        autoFocus
        aria-label="Nombre de la carpeta"
        value={value}
        placeholder="Nombre de la carpeta"
        onFocus={(e) => e.target.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true)
          if (e.key === 'Escape') finish(false)
        }}
        onBlur={() => finish(true)}
      />
    </div>
  )
}

/** Una API en el panel lateral: su fila y su árbol de carpetas y endpoints, que se ordenan arrastrando. */
export function ApiTree(props: Props) {
  const { api, filter, expanded, activeEndpointId } = props
  const [collapsed, setCollapsed] = useState(() => readCollapsed(api.id))
  /** Carpeta que se está creando (en qué carpeta padre) o renombrando. */
  const [naming, setNaming] = useState<{ parentId?: string } | { folder: Folder } | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const hoverTimer = useRef<{ folderId: string; timer: number } | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(`collapsedFolders:${api.id}`, JSON.stringify([...collapsed]))
    } catch {
      // Sin almacenamiento, el estado de las carpetas dura solo esta sesión.
    }
  }, [api.id, collapsed])

  const setFolderOpen = (id: string, open: boolean) =>
    setCollapsed((set) => {
      if (set.has(id) !== open) return set
      const next = new Set(set)
      if (open) next.delete(id)
      else next.add(id)
      return next
    })

  // Con filtro: endpoints que encajan (también por el nombre de su carpeta) y las carpetas que los contienen.
  const filtering = filter.trim() !== ''
  const visibleEndpoints = new Set(
    api.endpoints.filter((e) => !filtering || matches(e, folderLabel(api.folders, e.folderId), filter)).map((e) => e.id)
  )
  const visibleFolders = new Set<string>()
  if (filtering) {
    const byId = new Map(api.folders.map((f) => [f.id, f]))
    for (const e of api.endpoints) {
      if (!visibleEndpoints.has(e.id)) continue
      for (let f = e.folderId ? byId.get(e.folderId) : undefined; f && !visibleFolders.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) {
        visibleFolders.add(f.id)
      }
    }
  }
  if (filtering && visibleEndpoints.size === 0) return null
  const isOpen = (id: string) => filtering || !collapsed.has(id)
  const open = expanded || filtering

  const save = async (action: Promise<ApiSummary>) => {
    try {
      props.onApiChanged(await action)
    } catch (err) {
      console.error(err)
    }
  }

  const startNewFolder = (parentId?: string) => {
    if (!expanded) props.onToggle()
    if (parentId) setFolderOpen(parentId, true)
    setNaming({ parentId })
  }

  const move = async (m: MoveInput) => {
    // Se pinta ya y luego se confirma con lo que guarda el proceso principal.
    try {
      props.onApiChanged({ ...api, ...applyMove(api, m) })
    } catch {
      return
    }
    try {
      props.onApiChanged(await window.api.moveItem(api.id, m))
    } catch (err) {
      console.error(err)
      props.onApiChanged(api)
    }
  }

  // ---- Arrastrar y soltar ----

  const dragStart = (e: React.DragEvent, kind: MoveInput['kind'], id: string) => {
    dragged = { apiId: api.id, kind, id }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
  const dragEnd = () => {
    dragged = null
    setDrop(null)
    clearHoverTimer()
  }
  const clearHoverTimer = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current.timer)
    hoverTimer.current = null
  }

  /** Posición «al final» de una carpeta: tantos hermanos del mismo tipo como haya, sin contar el arrastrado. */
  const endOf = (kind: MoveInput['kind'], parentId: string | undefined) =>
    (kind === 'folder' ? siblings(api.folders, parentId) : siblings(api.endpoints, parentId)).filter((x) => x.id !== dragged?.id).length

  const indexOf = <T extends { id: string }>(list: T[], id: string) => list.filter((x) => x.id !== dragged?.id).findIndex((x) => x.id === id)

  /** Dónde caería lo arrastrado según la fila y la altura del ratón en ella. */
  const targetFor = (e: React.DragEvent, row: { folder: Folder } | { endpoint: Endpoint } | 'root'): Drop | null => {
    if (!dragged || dragged.apiId !== api.id) return null
    const { kind, id } = dragged
    if (row === 'root') return { row: 'root', where: 'into', move: { kind, id, parentId: null, index: endOf(kind, undefined) } }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const frac = (e.clientY - rect.top) / rect.height

    if ('endpoint' in row) {
      // Las carpetas van siempre antes que los endpoints: una carpeta no se suelta entre endpoints.
      if (kind === 'folder') return null
      const target = row.endpoint
      if (target.id === id) return null
      const index = indexOf(siblings(api.endpoints, target.folderId), target.id)
      const where: Where = frac < 0.5 ? 'before' : 'after'
      return { row: target.id, where, move: { kind, id, parentId: target.folderId ?? null, index: where === 'before' ? index : index + 1 } }
    }

    const target = row.folder
    const into: Drop = { row: target.id, where: 'into', move: { kind, id, parentId: target.id, index: endOf(kind, target.id) } }
    if (kind === 'endpoint') return into
    if (target.id === id || descendantIds(api.folders, id).has(target.id)) return null
    const index = indexOf(siblings(api.folders, target.parentId), target.id)
    const parentId = target.parentId ?? null
    if (frac < 0.25) return { row: target.id, where: 'before', move: { kind, id, parentId, index } }
    // Debajo de una carpeta abierta vienen sus hijos: soltar ahí es meterla dentro.
    if (frac > 0.75 && !isOpen(target.id)) return { row: target.id, where: 'after', move: { kind, id, parentId, index: index + 1 } }
    return into
  }

  const dragOver = (e: React.DragEvent, row: Parameters<typeof targetFor>[1]) => {
    const target = targetFor(e, row)
    if (!target) {
      if (drop) setDrop(null)
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (drop?.row !== target.row || drop.where !== target.where) setDrop(target)
    // Pasar un rato por encima de una carpeta plegada la abre.
    const folderId = row !== 'root' && 'folder' in row && target.where === 'into' && !isOpen(row.folder.id) ? row.folder.id : null
    if (hoverTimer.current?.folderId === folderId) return
    clearHoverTimer()
    if (folderId) hoverTimer.current = { folderId, timer: window.setTimeout(() => setFolderOpen(folderId, true), HOVER_OPEN_MS) }
  }

  const dropOn = (e: React.DragEvent, row: Parameters<typeof targetFor>[1]) => {
    const target = targetFor(e, row)
    dragEnd()
    if (!target) return
    e.preventDefault()
    e.stopPropagation()
    if (target.move.parentId) setFolderOpen(target.move.parentId, true)
    void move(target.move)
  }

  const dropClass = (row: string) => (drop?.row === row ? `drop-${drop.where}` : '')
  const dndHandlers = (row: Parameters<typeof targetFor>[1]) => ({
    onDragOver: (e: React.DragEvent) => dragOver(e, row),
    onDrop: (e: React.DragEvent) => dropOn(e, row),
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop((d) => (d?.row === (row === 'root' ? 'root' : 'folder' in row ? row.folder.id : row.endpoint.id) ? null : d))
    }
  })

  // ---- Menús ----

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const folderMenu = (folder: Folder): MenuItem[] => [
    { label: 'Nuevo endpoint aquí', onSelect: () => props.onNewEndpoint(folder.id) },
    { label: 'Nueva subcarpeta', onSelect: () => startNewFolder(folder.id) },
    { label: 'Cambiar nombre', onSelect: () => setNaming({ folder }) },
    { label: 'Borrar carpeta', onSelect: () => props.onDeleteFolder(folder) }
  ]

  // ---- Pintado ----

  const renderFolder = (folder: Folder, depth: number) => {
    if (filtering && !visibleFolders.has(folder.id)) return null
    if (naming && 'folder' in naming && naming.folder.id === folder.id) {
      return (
        <InlineName
          key={folder.id}
          initial={folder.name}
          depth={depth}
          onCancel={() => setNaming(null)}
          onSubmit={(name) => {
            setNaming(null)
            void save(window.api.saveFolder(api.id, { id: folder.id, name, parentId: folder.parentId }))
          }}
        />
      )
    }
    const folderOpen = isOpen(folder.id)
    const count = countEndpoints(api, folder.id)
    return (
      <div key={folder.id}>
        <div
          className={`tree-row folder-row ${dropClass(folder.id)}`}
          style={pad(depth)}
          draggable={!filtering}
          title={folderLabel(api.folders, folder.id)}
          onClick={() => setFolderOpen(folder.id, !folderOpen)}
          onDoubleClick={() => setNaming({ folder })}
          onContextMenu={(e) => openMenu(e, folderMenu(folder))}
          onDragStart={(e) => dragStart(e, 'folder', folder.id)}
          onDragEnd={dragEnd}
          {...dndHandlers({ folder })}
        >
          <span className="twisty">{folderOpen ? '▾' : '▸'}</span>
          <Icon name="folder" />
          <span className="label">{folder.name}</span>
          <span className="meta">{count}</span>
          <span className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <button className="icon" title="Nuevo endpoint aquí" onClick={() => props.onNewEndpoint(folder.id)}>
              <Icon name="plus" />
            </button>
            <button className="icon" title="Nueva subcarpeta" onClick={() => startNewFolder(folder.id)}>
              <Icon name="folderPlus" />
            </button>
            <button className="icon" title="Cambiar nombre (doble clic)" onClick={() => setNaming({ folder })}>
              <Icon name="edit" />
            </button>
            <button className="icon" title="Borrar carpeta" onClick={() => props.onDeleteFolder(folder)}>
              <Icon name="trash" />
            </button>
          </span>
        </div>
        {folderOpen && renderLevel(folder.id, depth + 1)}
      </div>
    )
  }

  const renderEndpoint = (e: Endpoint, depth: number) => {
    if (!visibleEndpoints.has(e.id)) return null
    return (
      <div
        key={e.id}
        className={`tree-row endpoint-row ${e.id === activeEndpointId ? 'active' : ''} ${dropClass(e.id)}`}
        style={pad(depth)}
        draggable={!filtering}
        title={`${e.method} ${e.path}${e.description ? `\n${e.description}` : ''}`}
        onClick={() => props.onOpen(e.id)}
        onContextMenu={(ev) =>
          openMenu(ev, [
            { label: 'Abrir', onSelect: () => props.onOpen(e.id) },
            { label: 'Editar endpoint', onSelect: () => props.onEditEndpoint(e) },
            { label: 'Borrar endpoint', onSelect: () => props.onDeleteEndpoint(e) }
          ])
        }
        onDragStart={(ev) => dragStart(ev, 'endpoint', e.id)}
        onDragEnd={dragEnd}
        {...dndHandlers({ endpoint: e })}
      >
        <MethodBadge method={e.method} />
        <span className="label">{e.name}</span>
        <span className="row-actions" onClick={(ev) => ev.stopPropagation()}>
          <button className="icon" title="Editar endpoint" onClick={() => props.onEditEndpoint(e)}>
            <Icon name="edit" />
          </button>
          <button className="icon" title="Borrar endpoint" onClick={() => props.onDeleteEndpoint(e)}>
            <Icon name="trash" />
          </button>
        </span>
      </div>
    )
  }

  /** Contenido de una carpeta (o de la raíz): primero subcarpetas, luego endpoints. */
  function renderLevel(parentId: string | undefined, depth: number): React.ReactNode {
    return (
      <>
        {siblings(api.folders, parentId).map((f) => renderFolder(f, depth))}
        {naming && !('folder' in naming) && naming.parentId === parentId && (
          <InlineName
            initial=""
            depth={depth}
            onCancel={() => setNaming(null)}
            onSubmit={(name) => {
              setNaming(null)
              void save(window.api.saveFolder(api.id, { name, parentId }))
            }}
          />
        )}
        {siblings(api.endpoints, parentId).map((e) => renderEndpoint(e, depth))}
      </>
    )
  }

  const badge = AUTH_BADGE[api.auth.type]
  return (
    <div>
      <div
        className={`api-row ${dropClass('root')}`}
        title={`${api.baseUrl}\n${AUTH_LABEL[api.auth.type]}`}
        onClick={props.onToggle}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: 'Nuevo endpoint', onSelect: () => props.onNewEndpoint() },
            { label: 'Nueva carpeta', onSelect: () => startNewFolder() },
            { label: 'Editar API', onSelect: props.onEditApi },
            { label: 'Borrar API', onSelect: props.onDeleteApi }
          ])
        }
        {...dndHandlers('root')}
      >
        <span className="twisty">{open ? '▾' : '▸'}</span>
        <span className={`env-dot env-${api.environment}`} />
        <span className="name">{api.name}</span>
        {badge && <span className="badge">{badge}</span>}
        <span className="badge">{api.endpoints.length}</span>
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon" title="Nuevo endpoint" onClick={() => props.onNewEndpoint()}>
            <Icon name="plus" />
          </button>
          <button className="icon" title="Nueva carpeta" onClick={() => startNewFolder()}>
            <Icon name="folderPlus" />
          </button>
          <button className="icon" title="Editar API" onClick={props.onEditApi}>
            <Icon name="edit" />
          </button>
          <button className="icon" title="Borrar API" onClick={props.onDeleteApi}>
            <Icon name="trash" />
          </button>
        </span>
      </div>
      {open && (
        <div className="endpoint-tree">
          {api.endpoints.length === 0 && api.folders.length === 0 && !naming && (
            <button className="link tree-empty" onClick={() => props.onNewEndpoint()}>
              + Añadir el primer endpoint
            </button>
          )}
          {renderLevel(undefined, 0)}
        </div>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
