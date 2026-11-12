import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { z, ZodError } from 'zod'
import bridgeSource from '../mcp-bridge/bridge.cjs?raw'
import { channelName, type ApiChannel, type IpcEnvelope } from '@shared/ipc'
import type { AppApi } from '@shared/types'
import type { ApiStore } from './store/apis'
import type { SecretVault } from './store/secrets'
import type { RequestRunner } from './requests'
import { decryptSecrets, exportApis, importApis, parseConfigFile, type ConfigFile } from './config-transfer'
import { buildMcpb } from './mcp/bundle'
import type { McpService } from './mcp/service'
import { mcpSettingsSchema, type McpSettingsStore } from './mcp/settings'
import { toolDefinitions } from './mcp/tools'
import type { Updater } from './updater'
import {
  endpointInputSchema,
  exportConfigSchema,
  folderInputSchema,
  idSchema,
  importConfigSchema,
  moveSchema,
  saveApiSchema,
  sendRequestSchema,
  setVariableSchema
} from './validation'

export interface IpcDeps {
  store: ApiStore
  vault: SecretVault
  updater: Updater
  runner: RequestRunner
  mcp: McpService
  mcpSettings: McpSettingsStore
  /** Carpeta de datos de la app: la extensión de Claude Desktop lee de aquí el puerto y el token. */
  dataDir: string
  iconPath: string
  window: () => BrowserWindow | null
}

/** Un fichero de configuración razonable ocupa unos cientos de KB; esto sobra. */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024

type Handlers = { [K in ApiChannel]: (...args: unknown[]) => ReturnType<AppApi[K]> }

function errorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    return `Datos no válidos: ${err.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}`
  }
  return err instanceof Error ? err.message : String(err)
}

export function registerIpc(deps: IpcDeps): void {
  const { store, vault, updater, runner, mcp, mcpSettings, window } = deps
  // Último fichero leído para importar: importConfig lo usa por token, sin recibir rutas del renderer.
  let pendingImport: { token: string; file: ConfigFile } | null = null
  // Última extensión de Claude Desktop guardada: mcpOpenExtension la abre sin recibir rutas del renderer.
  let lastExtension: string | null = null

  const saveDialog = async (options: Electron.SaveDialogOptions) => {
    const win = window()
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return canceled || !filePath ? null : filePath
  }

  const handlers: Handlers = {
    secretStorageStatus: () => vault.status(),
    listApis: () => store.list(),
    saveApi: async (input) => {
      const saved = await store.save(saveApiSchema.parse(input))
      runner.forget(saved.id)
      return saved
    },
    deleteApi: async (id) => {
      await store.delete(idSchema.parse(id))
      runner.forget(id as string)
      await mcpSettings.forgetApi(id as string)
    },
    saveEndpoint: (apiId, endpoint) => store.saveEndpoint(idSchema.parse(apiId), endpointInputSchema.parse(endpoint)),
    deleteEndpoint: (apiId, endpointId) => store.deleteEndpoint(idSchema.parse(apiId), idSchema.parse(endpointId)),
    saveFolder: (apiId, folder) => store.saveFolder(idSchema.parse(apiId), folderInputSchema.parse(folder)),
    deleteFolder: (apiId, folderId) => store.deleteFolder(idSchema.parse(apiId), idSchema.parse(folderId)),
    moveItem: (apiId, move) => store.moveItem(idSchema.parse(apiId), moveSchema.parse(move)),
    setVariable: (...args) => store.setVariable(...setVariableSchema.parse(args)),
    sendRequest: (input) => runner.send(sendRequestSchema.parse(input)),
    cancelRequest: async (runId) => runner.cancel(idSchema.parse(runId)),
    exportConfig: async (raw) => {
      const input = exportConfigSchema.parse(raw)
      const file = await exportApis(store, vault, input.apiIds, input.passphrase, app.getVersion())
      const path = await saveDialog({
        title: 'Exportar configuración',
        defaultPath: join(app.getPath('documents'), `gestor-api-${new Date().toISOString().slice(0, 10)}.json`),
        filters: [{ name: 'Configuración de Gestor API', extensions: ['json'] }]
      })
      if (!path) return null
      await writeFile(path, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
      return path
    },
    previewImport: async () => {
      const win = window()
      const options = {
        title: 'Importar configuración',
        properties: ['openFile' as const],
        filters: [{ name: 'Configuración de Gestor API', extensions: ['json'] }]
      }
      const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      const path = filePaths[0]
      if (canceled || !path) return null
      if ((await stat(path)).size > MAX_IMPORT_BYTES) throw new Error('El fichero es demasiado grande para ser una exportación de Gestor API')
      const file = parseConfigFile(await readFile(path, 'utf8'))
      const existing = new Set((await store.list()).map((a) => a.id))
      pendingImport = { token: randomUUID(), file }
      return {
        token: pendingImport.token,
        fileName: basename(path),
        exportedAt: file.exportedAt,
        encrypted: file.secrets !== null,
        apis: file.apis.map((a) => ({
          id: a.id,
          name: a.name,
          baseUrl: a.baseUrl,
          environment: a.environment,
          endpoints: a.endpoints.length,
          exists: existing.has(a.id)
        }))
      }
    },
    importConfig: async (raw) => {
      const input = importConfigSchema.parse(raw)
      if (pendingImport?.token !== input.token) throw new Error('Vuelve a elegir el fichero que quieres importar')
      const { file } = pendingImport
      const secrets = input.passphrase !== null && file.secrets ? await decryptSecrets(file, input.passphrase) : {}
      const result = await importApis(store, file, input.apiIds, secrets)
      for (const id of input.apiIds) runner.forget(id)
      pendingImport = null
      return result
    },
    mcpState: () => mcp.state(),
    mcpSaveSettings: (settings) => mcp.saveSettings(mcpSettingsSchema.parse(settings)),
    mcpRegenerateToken: () => mcp.regenerateToken(),
    mcpCreateExtension: async () => {
      const path = await saveDialog({
        title: 'Guardar extensión para Claude Desktop',
        defaultPath: join(app.getPath('downloads'), 'gestor-api.mcpb'),
        filters: [{ name: 'Extensión de Claude Desktop', extensions: ['mcpb'] }]
      })
      if (!path) return null
      const bundle = buildMcpb({
        version: app.getVersion(),
        dataDir: deps.dataDir,
        bridgeSource,
        tools: toolDefinitions(),
        icon: await readFile(deps.iconPath).catch(() => null)
      })
      await writeFile(path, bundle)
      lastExtension = path
      return path
    },
    mcpOpenExtension: async () => {
      if (!lastExtension) throw new Error('Primero crea la extensión')
      const error = await shell.openPath(lastExtension)
      if (error) throw new Error(`No se pudo abrir: ${error}. Arrástrala a Claude Desktop (Ajustes → Extensiones).`)
    },
    mcpRespondApproval: async (id, approved) => mcp.respondApproval(idSchema.parse(id), z.boolean().parse(approved)),
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
