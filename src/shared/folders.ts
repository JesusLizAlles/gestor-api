import type { Endpoint, Folder, MoveInput } from './types'

// Árbol de carpetas de una API. Funciones puras: las usa el almacén (proceso principal) y la interfaz,
// que aplica los movimientos al momento sin esperar la respuesta.

export interface FolderTree {
  folders: Folder[]
  endpoints: Endpoint[]
}

const parentOf = (item: Folder | Endpoint): string | undefined => ('method' in item ? item.folderId : item.parentId)

/** Ids de todas las carpetas que hay dentro de `id`, a cualquier profundidad (sin incluirla). */
export function descendantIds(folders: Folder[], id: string): Set<string> {
  const out = new Set<string>()
  const pending = [id]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const f of folders) {
      if (f.parentId === current && !out.has(f.id)) {
        out.add(f.id)
        pending.push(f.id)
      }
    }
  }
  return out
}

/** Carpetas desde la raíz hasta `id` (incluida). Vacío si no existe. */
export function folderPath(folders: Folder[], id: string | undefined): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const path: Folder[] = []
  const seen = new Set<string>()
  let current = id ? byId.get(id) : undefined
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path
}

/** «Reservas / Llegadas» */
export const folderLabel = (folders: Folder[], id: string | undefined): string =>
  folderPath(folders, id)
    .map((f) => f.name)
    .join(' / ')

/** Todas las carpetas en orden de árbol (padre antes que hijos), con su profundidad. Para listas desplegables. */
export function flattenFolders(folders: Folder[]): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = []
  const walk = (parentId: string | undefined, depth: number) => {
    for (const f of folders) {
      if (f.parentId !== parentId) continue
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

/** Los que tienen el mismo padre, en orden. */
export function siblings<T extends Folder | Endpoint>(list: T[], parentId: string | undefined): T[] {
  return list.filter((item) => parentOf(item) === parentId)
}

function withParent<T extends Folder | Endpoint>(item: T, kind: MoveInput['kind'], parentId: string | undefined): T {
  const key = kind === 'folder' ? 'parentId' : 'folderId'
  const copy = { ...item } as Record<string, unknown>
  if (parentId) copy[key] = parentId
  else delete copy[key]
  return copy as T
}

/**
 * Mueve un endpoint o una carpeta a otra carpeta (o a la raíz) y a una posición entre sus hermanos.
 * Devuelve copias nuevas de las listas; lanza un error si el movimiento no tiene sentido.
 */
export function applyMove<T extends FolderTree>(tree: T, move: MoveInput): T {
  const parentId = move.parentId ?? undefined
  if (parentId && !tree.folders.some((f) => f.id === parentId)) throw new Error('La carpeta de destino no existe')
  if (move.kind === 'folder' && parentId && (parentId === move.id || descendantIds(tree.folders, move.id).has(parentId))) {
    throw new Error('Una carpeta no puede ir dentro de sí misma')
  }
  const list: (Folder | Endpoint)[] = move.kind === 'folder' ? tree.folders : tree.endpoints
  const item = list.find((x) => x.id === move.id)
  if (!item) throw new Error(move.kind === 'folder' ? 'La carpeta no existe' : 'El endpoint no existe')

  const rest = list.filter((x) => x !== item)
  const group = siblings(rest, parentId)
  const anchor = group[Math.max(0, move.index)]
  const last = group[group.length - 1]
  const at = anchor ? rest.indexOf(anchor) : last ? rest.indexOf(last) + 1 : rest.length
  rest.splice(at, 0, withParent(item, move.kind, parentId))
  return move.kind === 'folder' ? { ...tree, folders: rest as Folder[] } : { ...tree, endpoints: rest as Endpoint[] }
}

/** Quita una carpeta; sus subcarpetas y endpoints pasan a la carpeta que la contenía. */
export function removeFolder<T extends FolderTree>(tree: T, id: string): T {
  const folder = tree.folders.find((f) => f.id === id)
  if (!folder) throw new Error('La carpeta no existe')
  const up = folder.parentId
  return {
    ...tree,
    folders: tree.folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? withParent(f, 'folder', up) : f)),
    endpoints: tree.endpoints.map((e) => (e.folderId === id ? withParent(e, 'endpoint', up) : e))
  }
}

/** Número de endpoints dentro de la carpeta, contando subcarpetas. */
export function countEndpoints(tree: FolderTree, id: string): number {
  const inside = descendantIds(tree.folders, id).add(id)
  return tree.endpoints.filter((e) => e.folderId && inside.has(e.folderId)).length
}
