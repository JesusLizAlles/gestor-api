import type { EndpointParam } from './types'

/** Parámetros de ruta escritos como {id} o :id. */
const PATH_PARAM = /\{([A-Za-z_][\w-]*)\}|:([A-Za-z_][\w-]*)/g

/** Nombres de los parámetros de una ruta, en orden y sin repetir: /hoteles/{hotel}/reservas/:id → [hotel, id]. */
export function pathParamNames(path: string): string[] {
  const names = [...path.matchAll(PATH_PARAM)].map((m) => (m[1] ?? m[2])!)
  return [...new Set(names)]
}

/**
 * Añade a la lista los parámetros de ruta que faltan (obligatorios, de texto) y marca como
 * obligatorios los que ya estaban. Así, al escribir la ruta, el formulario ya los pide.
 */
export function syncPathParams(path: string, params: EndpointParam[]): EndpointParam[] {
  const names = pathParamNames(path)
  const next = params.map((p) => (p.in === 'path' && names.includes(p.name) ? { ...p, required: true } : p))
  for (const name of names) {
    if (!next.some((p) => p.in === 'path' && p.name === name)) next.push({ name, in: 'path', type: 'string', required: true })
  }
  return next
}

/** URL base + ruta, con una sola barra entre las dos. */
export function joinUrl(baseUrl: string, path: string): string {
  if (!path) return baseUrl
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export interface BuiltUrl {
  url: string
  /** Parámetros obligatorios sin valor (de ruta o de consulta). */
  missing: string[]
}

/**
 * URL final de una llamada: sustituye los parámetros de ruta (codificados) y añade los de consulta
 * que tengan valor. Los vacíos de ruta se dejan como {nombre} para que se vea qué falta.
 */
export function buildUrl(baseUrl: string, path: string, params: EndpointParam[], values: Record<string, string>): BuiltUrl {
  const missing: string[] = []
  const withPath = path.replace(PATH_PARAM, (whole, a?: string, b?: string) => {
    const name = (a ?? b)!
    const value = values[`path:${name}`] ?? ''
    if (value === '') {
      missing.push(name)
      return `{${name}}`
    }
    return encodeURIComponent(value)
  })
  const query = new URLSearchParams()
  for (const p of params) {
    if (p.in !== 'query') continue
    const value = values[`query:${p.name}`] ?? ''
    if (value !== '') query.append(p.name, value)
    else if (p.required) missing.push(p.name)
  }
  const qs = query.toString()
  const url = joinUrl(baseUrl, withPath)
  return { url: qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url, missing }
}

/** Clave del valor de un parámetro en el formulario: el mismo nombre puede ir en la ruta y en la consulta. */
export const paramKey = (p: Pick<EndpointParam, 'in' | 'name'>): string => `${p.in}:${p.name}`
