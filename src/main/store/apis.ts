import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AUTH_SECRETS, type ApiConfig, type ApiSummary, type EndpointInput, type SaveApiInput, type SecretsPatch } from '@shared/types'
import { apiInputSchema, endpointInputSchema } from '../validation'
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
    // Los endpoints no vienen del formulario de la API: se conservan al editarla.
    const config: ApiConfig = { ...parsed, id, endpoints: index >= 0 ? file.apis[index]!.endpoints : [] }
    if (index >= 0) file.apis[index] = config
    else file.apis.push(config)
    await writeJson(this.path, file)
    await this.vault.apply(id, withoutUnusedSecrets(config, input.secrets))
    return this.summarize(config)
  }

  async delete(id: string): Promise<void> {
    const file = await this.load()
    file.apis = file.apis.filter((a) => a.id !== id)
    await writeJson(this.path, file)
    await this.vault.delete(id)
  }

  async saveEndpoint(apiId: string, input: EndpointInput): Promise<ApiSummary> {
    const parsed = endpointInputSchema.parse(input)
    const file = await this.load()
    const api = file.apis.find((a) => a.id === apiId)
    if (!api) throw new Error('La API no existe')
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

  private async summarize(config: ApiConfig): Promise<ApiSummary> {
    return { ...config, storedSecrets: await this.vault.storedKeys(config.id) }
  }

  private async load(): Promise<ApisFile> {
    this.file ??= readJson<ApisFile>(this.path, { version: 1, apis: [] })
    return this.file
  }
}

/**
 * Al cambiar de tipo de autenticación se borran los secretos que el nuevo tipo no usa:
 * así no queda un token viejo guardado sin que se vea en ningún sitio.
 */
function withoutUnusedSecrets(config: ApiConfig, patch: SecretsPatch | undefined): SecretsPatch {
  const used = new Set(AUTH_SECRETS[config.auth.type])
  const out: SecretsPatch = {}
  for (const key of ['token', 'password', 'apiKey', 'clientSecret'] as const) {
    if (!used.has(key)) out[key] = null
    else if (patch?.[key] !== undefined) out[key] = patch[key]
  }
  return out
}
