import type { McpApprovalRequest } from '@shared/types'
import { ENV_LABEL } from '../lib/labels'
import { MethodBadge } from './MethodBadge'

/** El cuerpo con sangría si es JSON; tal cual si no. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** Un agente quiere lanzar un endpoint que modifica datos: el usuario ve la petición y decide. Por defecto, rechazar. */
export function McpApprovalDialog({
  request,
  pending,
  onAnswer
}: {
  request: McpApprovalRequest
  /** Cuántas más esperan detrás de esta. */
  pending: number
  onAnswer: (approved: boolean) => void
}) {
  const prod = request.environment === 'prod'
  const { method, url, headers, body } = request.request
  return (
    <div className="modal-overlay">
      <div className="dialog wide" role="alertdialog" aria-label="Aprobar llamada del agente" onKeyDown={(e) => e.key === 'Escape' && onAnswer(false)}>
        <h2>Un agente de IA quiere modificar datos</h2>
        <div className="body">
          <p>
            <span className={`env-dot env-${request.environment}`} /> <strong>{request.apiName}</strong> · {request.endpointName} ·{' '}
            {prod ? <span className="badge prod">PRODUCCIÓN</span> : ENV_LABEL[request.environment]}
          </p>
          <p className="note">Esta petición solo se envía si pulsas «Enviar». Las credenciales se ven tapadas.</p>
          <div className="mcp-approval-request">
            <div className="request-url mono">
              <MethodBadge method={method} />
              <span>{url}</span>
            </div>
            {headers.length > 0 && (
              <pre className="code-block">{headers.map((h) => `${h.name}: ${h.value}`).join('\n')}</pre>
            )}
            {body && <pre className="code-block review-sql">{pretty(body)}</pre>}
          </div>
          {pending > 0 && <p className="note">Hay {pending} petición(es) más esperando.</p>}
        </div>
        <div className="footer">
          <span className="note">Si no respondes en 5 minutos, se rechaza.</span>
          <div className="spacer" />
          <button autoFocus onClick={() => onAnswer(false)}>
            Rechazar
          </button>
          <button className={prod ? 'danger' : 'primary'} onClick={() => onAnswer(true)}>
            Enviar
          </button>
        </div>
      </div>
    </div>
  )
}
