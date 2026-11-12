import { useState } from 'react'

/** Hijos que se pintan de golpe en listas y objetos grandes; el resto, a petición. */
const PAGE = 100

interface NodeProps {
  name?: string
  value: unknown
  depth: number
  /** Profundidad hasta la que se abre solo. */
  openDepth: number
  last: boolean
}

const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] => value !== null && typeof value === 'object'

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="json-null">null</span>
  if (typeof value === 'string') return <span className="json-string">{JSON.stringify(value)}</span>
  if (typeof value === 'number') return <span className="json-number">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="json-bool">{String(value)}</span>
  return <span>{String(value)}</span>
}

function JsonNode({ name, value, depth, openDepth, last }: NodeProps) {
  const [open, setOpen] = useState(depth < openDepth)
  const [shown, setShown] = useState(PAGE)
  const key = name !== undefined && <span className="json-key">{JSON.stringify(name)}: </span>
  const comma = last ? '' : ','

  if (!isContainer(value)) {
    return (
      <div className="json-line" style={{ paddingLeft: depth * 14 }}>
        {key}
        <Scalar value={value} />
        {comma}
      </div>
    )
  }

  const isArray = Array.isArray(value)
  const entries: [string, unknown][] = isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value)
  const [openBrace, closeBrace] = isArray ? ['[', ']'] : ['{', '}']
  if (entries.length === 0) {
    return (
      <div className="json-line" style={{ paddingLeft: depth * 14 }}>
        {key}
        {openBrace}
        {closeBrace}
        {comma}
      </div>
    )
  }

  return (
    <>
      <div className="json-line json-toggle" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen(!open)}>
        <span className="twisty">{open ? '▾' : '▸'}</span>
        {key}
        {openBrace}
        {!open && (
          <>
            <span className="json-summary">{isArray ? `${entries.length} elementos` : `${entries.length} campos`}</span>
            {closeBrace}
            {comma}
          </>
        )}
      </div>
      {open && (
        <>
          {entries.slice(0, shown).map(([k, v], i) => (
            <JsonNode
              key={k}
              name={isArray ? undefined : k}
              value={v}
              depth={depth + 1}
              openDepth={openDepth}
              last={i === entries.length - 1}
            />
          ))}
          {entries.length > shown && (
            <div className="json-line" style={{ paddingLeft: (depth + 1) * 14 }}>
              <button className="link" onClick={() => setShown(shown + PAGE)}>
                Mostrar {Math.min(PAGE, entries.length - shown)} más ({entries.length - shown} ocultos)
              </button>
            </div>
          )}
          <div className="json-line" style={{ paddingLeft: depth * 14 }}>
            {closeBrace}
            {comma}
          </div>
        </>
      )}
    </>
  )
}

/** JSON en árbol plegable: se abre hasta `openDepth` niveles y pagina las listas largas. */
export function JsonTree({ value, openDepth = 4 }: { value: unknown; openDepth?: number }) {
  return (
    <div className="json-tree mono">
      <JsonNode value={value} depth={0} openDepth={openDepth} last />
    </div>
  )
}
