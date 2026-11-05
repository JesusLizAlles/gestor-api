import { contextBridge, ipcRenderer } from 'electron'
import { API_CHANNELS, channelName, UPDATE_STATE_EVENT, type IpcEnvelope } from '@shared/ipc'
import type { AppApi, UpdateState } from '@shared/types'

/** Suscripción a un evento del proceso principal; devuelve la función para darse de baja. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  ...Object.fromEntries(
    API_CHANNELS.map((method) => [
      method,
      async (...args: unknown[]) => {
        const reply = (await ipcRenderer.invoke(channelName(method), ...args)) as IpcEnvelope<unknown>
        if (!reply.ok) throw new Error(reply.error)
        return reply.value
      }
    ])
  ),
  onUpdateState: (listener: (state: UpdateState) => void) => subscribe(UPDATE_STATE_EVENT, listener)
} as unknown as AppApi

contextBridge.exposeInMainWorld('api', api)
