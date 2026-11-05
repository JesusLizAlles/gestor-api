import { ipcMain, type BrowserWindow } from 'electron'
import { ZodError } from 'zod'
import { channelName, type ApiChannel, type IpcEnvelope } from '@shared/ipc'
import type { AppApi } from '@shared/types'
import type { ApiStore } from './store/apis'
import type { SecretVault } from './store/secrets'
import type { Updater } from './updater'
import { endpointInputSchema, idSchema, saveApiSchema } from './validation'

export interface IpcDeps {
  store: ApiStore
  vault: SecretVault
  updater: Updater
  window: () => BrowserWindow | null
}

type Handlers = { [K in ApiChannel]: (...args: unknown[]) => ReturnType<AppApi[K]> }

function errorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    return `Datos no válidos: ${err.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}`
  }
  return err instanceof Error ? err.message : String(err)
}

export function registerIpc(deps: IpcDeps): void {
  const { store, vault, updater, window } = deps
  const handlers: Handlers = {
    secretStorageStatus: () => vault.status(),
    listApis: () => store.list(),
    saveApi: (input) => store.save(saveApiSchema.parse(input)),
    deleteApi: (id) => store.delete(idSchema.parse(id)),
    saveEndpoint: (apiId, endpoint) => store.saveEndpoint(idSchema.parse(apiId), endpointInputSchema.parse(endpoint)),
    deleteEndpoint: (apiId, endpointId) => store.deleteEndpoint(idSchema.parse(apiId), idSchema.parse(endpointId)),
    updaterState: async () => updater.get(),
    checkForUpdates: () => updater.check(true),
    downloadUpdate: () => updater.download(),
    installUpdate: async () => updater.install()
  }

  for (const [method, handler] of Object.entries(handlers) as [ApiChannel, (...args: unknown[]) => Promise<unknown>][]) {
    ipcMain.handle(channelName(method), async (event, ...args): Promise<IpcEnvelope<unknown>> => {
      // Solo aceptamos llamadas de nuestra propia ventana.
      if (event.sender !== window()?.webContents) return { ok: false, error: 'Origen IPC no permitido' }
      try {
        return { ok: true, value: await handler(...args) }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    })
  }
}
