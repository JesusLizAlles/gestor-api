import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  authSecrets,
  type ApiConfig,
  type ApiSummary,
  type EndpointInput,
  type Folder,
  type FolderInput,
  type MoveInput,
  type SaveApiInput,
  type SecretKey,
  type SecretsPatch
} from '@shared/types'
import { applyMove, descendantIds, removeFolder } from '@shared/folders'
import { apiInputSchema, endpointInputSchema, folderInputSchema, importedApiSchema, moveSchema } from '../validation'
import { readJson, writeJson } from './fs-utils'
import type { SecretVault } from './secrets'

interface ApisFile {
  version: 1
  apis: ApiConfig[]
}

/** APIs guardadas en apis.json, con sus endpoints (sin secretos; esos van al SecretVault). */
export class ApiStore {
  private readonly path: string
  // Se cachea la promesa (no el valor) para que dos llamadas simultáneas compartan la misma copia.
  private file: Promise<ApisFile> | null = null

  constructor(dir: string, private readonly vault: SecretVault) {
    this.path = join(dir, 'apis.json')
  }

  async list(): Promise<ApiSummary[]> {
    const { apis } = await this.load()
    return Promise.all(apis.map((a) => this.summarize(a)))
  }

  async get(id: string): Promise<ApiConfig> {
    const found = (await this.load()).apis.find((a) => a.id === id)
    if (!found) throw new Error('La API no existe')
    return found
  }

  async save(input: SaveApiInput): Promise<ApiSummary> {
    const parsed = apiInputSchema.parse(input.config)
    const file = await this.load()
    const id = parsed.id ?? randomUUID()
    const index = file.apis.findIndex((a) => a.id === id)
    // Carpetas y endpoints no vienen del formulario de la API: se conservan al editarla.
    const config: ApiConfig = {
      ...parsed,
      bodyTemplate: parsed.bodyTemplate?.trim() ? parsed.bodyTemplate : undefined,
      id,
      folders: index >= 0 ? file.apis[index]!.folders : [],
      endpoints: index >= 0 ? file.apis[index]!.endpoints : []
    }
    if (index >= 0) file.apis[index] = config
    else file.apis.push(config)
    await writeJson(this.path, file)
    await this.vault.apply(id, withoutUnusedSecrets(config, input.secrets, await this.vault.storedKeys(id)))
    return this.summarize(config)
  }

  /**
   * Guarda una API completa que viene de otro equipo, con su mismo id: si ya existe, la sustituye
   * (reimportar no duplica). Sin credenciales en el fichero se conservan las que hubiera guardadas.
   */
  async importApi(input: unknown, secrets: SecretsPatch | undefined): Promise<ApiSummary> {
    const parsed = importedApiSchema.parse(input)
    const file = await this.load()
    const config: ApiConfig = {
      ...parsed,
      bodyTemplate: parsed.bodyTemplate?.trim() ? parsed.bodyTemplate : undefined,
      ...sanitizeTree(parsed.folders, parsed.endpoints)
    }
    const index = file.apis.findIndex((a) => a.id === config.id)
    if (index >= 0) file.apis[index] = config
    else file.apis.push(config)
    await writeJson(this.path, file)
    await this.vault.apply(config.id, withoutUnusedSecrets(config, secrets, await this.vault.storedKeys(config.id)))
    return this.summarize(config)
  }

  async delete(id: string): Promise<void> {
    const file = await this.load()
    file.apis = file.apis.filter((a) => a.id !== id)
    await writeJson(this.path, file)
    await this.vault.delete(id)
  }

  /** Cambia el valor actual de una variable: en un listado, la opción elegida. */
  async setVariable(apiId: string, name: string, value: string): Promise<ApiSummary> {
    const file = await this.load()
    const api = file.apis.find((a) => a.id === apiId)
    if (!api) throw new Error('La API no existe')
    const variable = api.variables.find((v) => v.name === name)
    if (!variable) throw new Error(`La variable ${name} no existe`)
    variable.value = value
    await writeJson(this.path, file)
    return this.summarize(api)
  }

  async saveEndpoint(apiId: string, input: EndpointInput): Promise<ApiSummary> {
    const parsed = endpointInputSchema.parse(input)
    const file = await this.load()
    const api = file.apis.find((a) => a.id === apiId)
    if (!api) throw new Error('La API no existe')
    if (parsed.folderId && !api.folders.some((f) => f.id === parsed.folderId)) throw new Error('La carpeta no existe')
    const endpoint = { ...parsed, id: parsed.id ?? randomUUID() }
    const index = api.endpoints.findIndex((e) => e.id === endpoint.id)
    if (index >= 0) api.endpoints[index] = endpoint
    else api.endpoints.push(endpoint)
    await writeJson(this.path, file)
    return this.summarize(api)
  }

  async deleteEndpoint(apiId: string, endpointId: string): Promise<ApiSummary> {
    const file = await this.load()
    const api = file.apis.find((a) => a.id === apiId)
    if (!api) throw new Error('La API no existe')
    api.endpoints = api.endpoints.filter((e) => e.id !== endpointId)
    await writeJson(this.path, file)
    return this.summarize(api)
  }

  /** Crea una carpeta (sin id) o la renombra / cambia de carpeta padre. */
  async saveFolder(apiId: string, input: FolderInput): Promise<ApiSummary> {
    const parsed = folderInputSchema.parse(input)
    const file = await this.load()
    const api = this.find(file, apiId)
    if (parsed.parentId && !api.folders.some((f) => f.id === parsed.parentId)) throw new Error('La carpeta de destino no existe')
    const folder: Folder = { id: parsed.id ?? randomUUID(), name: parsed.name, ...(parsed.parentId ? { parentId: parsed.parentId } : {}) }
    const index = api.folders.findIndex((f) => f.id === folder.id)
    if (index < 0) api.folders.push(folder)
    else {
      if (folder.parentId && (folder.parentId === folder.id || descendantIds(api.folders, folder.id).has(folder.parentId))) {
        throw new Error('Una carpeta no puede ir dentro de sí misma')
      }
      api.folders[index] = folder
    }
    await writeJson(this.path, file)
    return this.summarize(api)
  }

  async deleteFolder(apiId: string, folderId: string): Promise<ApiSummary> {
    const file = await this.load()
    const api = this.find(file, apiId)
    Object.assign(api, removeFolder(api, folderId))
    await writeJson(this.path, file)
    return this.summarize(api)
  }

  async moveItem(apiId: string, move: MoveInput): Promise<ApiSummary> {
    const parsed = moveSchema.parse(move)
    const file = await this.load()
    const api = this.find(file, apiId)
    Object.assign(api, applyMove(api, parsed))
    await writeJson(this.path, file)
    return this.summarize(api)
  }

  private find(file: ApisFile, apiId: string): ApiConfig {
    const api = file.apis.find((a) => a.id === apiId)
    if (!api) throw new Error('La API no existe')
    return api
  }

  private async summarize(config: ApiConfig): Promise<ApiSummary> {
    return { ...config, storedSecrets: await this.vault.storedKeys(config.id) }
  }

  private async load(): Promise<ApisFile> {
    this.file ??= readJson<ApisFile>(this.path, { version: 1, apis: [] }).then(async (file) => {
      // Las carpetas nuevas de la migración llevan ids aleatorios: se guardan ya para que no cambien en cada arranque.
      // Si no se puede escribir ahora, se guardará con el siguiente cambio.
      if (normalize(file)) await writeJson(this.path, file).catch(() => undefined)
      return file
    })
    return this.file
  }
}

/** Quita referencias rotas de un árbol importado: carpetas o padres que no existen y ciclos. */
function sanitizeTree(folders: Folder[], endpoints: ApiConfig['endpoints']): Pick<ApiConfig, 'folders' | 'endpoints'> {
  const ids = new Set(folders.map((f) => f.id))
  const clean: Folder[] = folders.map(({ parentId, ...f }) => (parentId && ids.has(parentId) ? { ...f, parentId } : f))
  // Una carpeta que acaba siendo su propia antecesora sube a la raíz.
  for (const f of clean) if (f.parentId && descendantIds(clean, f.id).has(f.parentId)) delete f.parentId
  return {
    folders: clean,
    endpoints: endpoints.map(({ folderId, ...e }) => ({ ...e, vars: e.vars ?? [], ...(folderId && ids.has(folderId) ? { folderId } : {}) }))
  }
}

/** Endpoint de versiones anteriores, con grupo de texto en vez de carpeta. */
type LegacyEndpoint = ApiConfig['endpoints'][number] & { group?: string }

/** Completa los campos que no existían en versiones anteriores de apis.json. Devuelve si cambió algo que haya que guardar. */
function normalize(file: ApisFile): boolean {
  let migrated = false
  for (const api of file.apis) {
    api.variables ??= []
    api.folders ??= []
    for (const endpoint of api.endpoints as LegacyEndpoint[]) {
      endpoint.vars ??= []
      if (endpoint.group === undefined) continue
      // «Reservas/Llegadas» pasa a ser la carpeta Llegadas dentro de Reservas.
      const names = endpoint.group.split('/').map((n) => n.trim()).filter((n) => n !== '')
      let parentId: string | undefined
      for (const name of names) {
        let folder = api.folders.find((f) => f.name === name && f.parentId === parentId)
        if (!folder) {
          folder = { id: randomUUID(), name, ...(parentId ? { parentId } : {}) }
          api.folders.push(folder)
        }
        parentId = folder.id
      }
      if (parentId) endpoint.folderId = parentId
      delete endpoint.group
      migrated = true
    }
  }
  return migrated
}

/**
 * Al cambiar de tipo de autenticación (o renombrar un campo) se borran los secretos que ya no se usan:
 * así no queda un token viejo guardado sin que se vea en ningún sitio.
 */
function withoutUnusedSecrets(config: ApiConfig, patch: SecretsPatch | undefined, stored: SecretKey[]): SecretsPatch {
  const used = new Set(authSecrets(config.auth))
  const out: SecretsPatch = {}
  for (const key of stored) if (!used.has(key)) out[key] = null
  for (const key of used) if (patch?.[key] !== undefined) out[key] = patch[key]
  return out
}
