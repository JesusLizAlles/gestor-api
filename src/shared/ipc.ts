import type { AppApi } from './types'

/** Un canal IPC por método de la API; el nombre del canal es el del método. Los eventos van aparte. */
export type ApiChannel = Exclude<keyof AppApi, 'onUpdateState' | 'onMcpState' | 'onMcpApproval'>

/** Evento del proceso principal al renderer con cada cambio del actualizador. */
export const UPDATE_STATE_EVENT = 'updater:state'
/** Cambios del servidor MCP (arranque, actividad del agente). */
export const MCP_STATE_EVENT = 'mcp:state'
/** Una llamada del agente espera la aprobación del usuario. */
export const MCP_APPROVAL_EVENT = 'mcp:approval'

export const API_CHANNELS = [
  'secretStorageStatus',
  'listApis',
  'saveApi',
  'deleteApi',
  'saveEndpoint',
  'deleteEndpoint',
  'saveFolder',
  'deleteFolder',
  'moveItem',
  'setVariable',
  'sendRequest',
  'cancelRequest',
  'exportConfig',
  'previewImport',
  'importConfig',
  'mcpState',
  'mcpSaveSettings',
  'mcpRegenerateToken',
  'mcpCreateExtension',
  'mcpOpenExtension',
  'mcpRespondApproval',
  'updaterState',
  'checkForUpdates',
  'downloadUpdate',
  'installUpdate'
] as const satisfies readonly ApiChannel[]

/** Respuesta envuelta: así el mensaje de error llega limpio al renderer. */
export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error: string }

export const channelName = (method: ApiChannel): string => `api:${method}`
