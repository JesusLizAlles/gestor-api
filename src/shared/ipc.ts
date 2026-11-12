import type { AppApi } from './types'

/** Un canal IPC por método de la API; el nombre del canal es el del método. Los eventos van aparte. */
export type ApiChannel = Exclude<keyof AppApi, 'onUpdateState'>

/** Evento del proceso principal al renderer con cada cambio del actualizador. */
export const UPDATE_STATE_EVENT = 'updater:state'

export const API_CHANNELS = [
  'secretStorageStatus',
  'listApis',
  'saveApi',
  'deleteApi',
  'saveEndpoint',
  'deleteEndpoint',
  'setVariable',
  'sendRequest',
  'cancelRequest',
  'updaterState',
  'checkForUpdates',
  'downloadUpdate',
  'installUpdate'
] as const satisfies readonly ApiChannel[]

/** Respuesta envuelta: así el mensaje de error llega limpio al renderer. */
export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error: string }

export const channelName = (method: ApiChannel): string => `api:${method}`
