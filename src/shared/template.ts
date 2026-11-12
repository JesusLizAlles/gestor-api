// Variables {{nombre}}: sustitución en texto y en JSON, variables automáticas y rutas con puntos.

/** {{nombre}}, {{ nombre }} o {{$hoy}}. */
const VARIABLE = /\{\{\s*([$\w.-]+)\s*\}\}/g

export type Vars = Record<string, string>

/** Nombres de las variables que aparecen en un texto, sin repetir. */
export function variableNames(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE)].map((m) => m[1]!))]
}

/** Sustituye las {{variables}} conocidas; las desconocidas se quedan tal cual y se apuntan en `unresolved`. */
export function substitute(text: string, vars: Vars, unresolved?: Set<string>): string {
  return text.replace(VARIABLE, (whole, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name]!
    unresolved?.add(name)
    return whole
  })
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)

/** Variables automáticas, disponibles en todas las APIs. Se calculan una vez por llamada. */
export function builtinVars(now = new Date(), uuid: () => string = () => globalThis.crypto.randomUUID()): Vars {
  return {
    $hoy: isoDate(now),
    $ayer: isoDate(addDays(now, -1)),
    $manana: isoDate(addDays(now, 1)),
    $ahora: now.toISOString(),
    $timestamp: String(Math.floor(now.getTime() / 1000)),
    $uuid: uuid()
  }
}

export const BUILTIN_HELP: [string, string][] = [
  ['$hoy', 'fecha de hoy (2026-11-12)'],
  ['$ayer', 'fecha de ayer'],
  ['$manana', 'fecha de mañana'],
  ['$ahora', 'fecha y hora ISO'],
  ['$timestamp', 'segundos desde 1970'],
  ['$uuid', 'identificador único nuevo']
]

/** Tipos de campo que se pueden pedir desde el propio cuerpo, la ruta o una cabecera: {{date.desde}}. */
export type InlineKind = 'date' | 'datetime' | 'time' | 'number' | 'text' | 'bool'

export const INLINE_KIND_LABEL: Record<InlineKind, string> = {
  date: 'Fecha',
  datetime: 'Fecha y hora',
  time: 'Hora',
  number: 'Número',
  text: 'Texto',
  bool: 'Sí/No'
}

export const INLINE_HELP: [string, string][] = [
  ['{{date.desde}}', 'calendario (2026-11-12)'],
  ['{{datetime.desde}}', 'fecha y hora (2026-11-12 09:30:00)'],
  ['{{time.hora}}', 'hora (09:30)'],
  ['{{number.limite}}', 'número'],
  ['{{bool.activo}}', 'sí/no (true/false)'],
  ['{{text.nota}}', 'texto libre (puede quedar vacío)']
]

/** Un {{tipo.nombre}}: la ficha del endpoint pinta un campo de ese tipo y su valor sustituye al hueco. */
export interface InlineField {
  /** date.desde */
  key: string
  kind: InlineKind
  /** desde */
  name: string
}

const INLINE = /^(date|datetime|time|number|text|bool)\.([A-Za-z_][\w-]*)$/

/** Campos {{tipo.nombre}} de unos textos, en el orden en que aparecen y sin repetir. */
export function inlineFields(...texts: (string | undefined)[]): InlineField[] {
  const out = new Map<string, InlineField>()
  for (const text of texts) {
    if (!text) continue
    for (const key of variableNames(text)) {
      const m = INLINE.exec(key)
      if (m && !out.has(key)) out.set(key, { key, kind: m[1] as InlineKind, name: m[2]! })
    }
  }
  return [...out.values()]
}

/** Dónde va el valor de un campo en los valores del formulario. */
export const inlineValueKey = (key: string) => `inline:${key}`

/** Valor con el que empieza un campo: hoy, ahora, No… */
export function inlineDefault(kind: InlineKind, now = new Date()): string {
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  if (kind === 'date') return isoDate(now)
  if (kind === 'datetime') return `${isoDate(now)} ${time}:00`
  if (kind === 'time') return time
  if (kind === 'bool') return 'false'
  return ''
}

/** Marca interna de un {{hueco}} escrito sin comillas en una plantilla JSON. */
const RAW = '\u0000raw:'

/**
 * Convierte en cadenas marcadas los {{huecos}} escritos sin comillas, para que el texto sea JSON válido:
 * `{"data": {{body}}}` → `{"data": "\u0000raw:body"}`. Los que van dentro de comillas no se tocan.
 */
function quoteRawPlaceholders(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') out += text[++i] ?? ''
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2)
      const name = end > 0 ? text.slice(i + 2, end).trim() : ''
      if (/^[$\w.-]+$/.test(name)) {
        out += JSON.stringify(`${RAW}${name}`)
        i = end + 1
        continue
      }
    }
    out += ch
  }
  return out
}

/** Valor de una variable insertada sin comillas: número, true/false/null, objeto o lista si lo es; si no, texto. */
function rawValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Lee una plantilla JSON con {{variables}}.
 * - Entre comillas, `"{{hotel_id}}"` → siempre texto: "100001".
 * - Sin comillas, `{{hotel_id}}` → el tipo que tenga: 100001. `{{body}}` y demás huecos de `raw`
 *   insertan objetos ya montados.
 * Lanza un error con el mensaje del analizador si el JSON no es válido.
 */
export function parseJsonTemplate(text: string, vars: Vars, raw: Record<string, unknown> = {}, unresolved?: Set<string>): unknown {
  const parsed: unknown = JSON.parse(quoteRawPlaceholders(text))
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.startsWith(RAW)) {
        const name = value.slice(RAW.length)
        if (Object.hasOwn(raw, name)) return raw[name]
        if (Object.hasOwn(vars, name)) return rawValue(vars[name]!)
        unresolved?.add(name)
        return `{{${name}}}`
      }
      return substitute(value, vars, unresolved)
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
    return value
  }
  return walk(parsed)
}

/** ¿El texto es una plantilla JSON válida? Devuelve el error o null. */
export function jsonTemplateError(text: string): string | null {
  try {
    JSON.parse(quoteRawPlaceholders(text))
    return null
  } catch (err) {
    return (err as Error).message
  }
}

const segments = (path: string) => path.split('.').filter((s) => s !== '')

/** Lee un valor por su ruta con puntos: getPath(obj, 'data.list.0.id'). */
export function getPath(value: unknown, path: string): unknown {
  let current = value
  for (const key of segments(path)) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Escribe un valor por su ruta con puntos, creando los objetos intermedios que falten. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = segments(path)
  if (keys.length === 0) return
  let current: Record<string, unknown> = target
  for (const key of keys.slice(0, -1)) {
    const next = current[key]
    if (next === null || typeof next !== 'object') current[key] = {}
    current = current[key] as Record<string, unknown>
  }
  current[keys.at(-1)!] = value
}
