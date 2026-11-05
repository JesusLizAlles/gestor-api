import type { HttpMethod } from '@shared/types'

/** Método HTTP con su color: verde para leer, azul para crear, naranja para cambiar, rojo para borrar. */
export function MethodBadge({ method, large }: { method: HttpMethod; large?: boolean }) {
  return <span className={`method method-${method.toLowerCase()} ${large ? 'large' : ''}`}>{method === 'DELETE' ? 'DEL' : method}</span>
}
