// Exportar e importar APIs entre equipos. Las credenciales guardadas van cifradas con el llavero de
// cada sistema, así que no se pueden copiar tal cual: si se incluyen, se cifran con una clave que
// elige el usuario (scrypt + AES-256-GCM) y hay que darla al importar.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { z } from 'zod'
import type { ApiConfig, ImportResult, SecretKey } from '@shared/types'
import type { ApiStore } from './store/apis'
import type { SecretVault } from './store/secrets'
import { importedApiSchema, secretKeySchema } from './validation'

export const CONFIG_FORMAT = 'gestor-api-config'
export const MIN_PASSPHRASE = 8

type Secrets = Partial<Record<SecretKey, string>>

const KDF = { N: 2 ** 15, r: 8, p: 1 } as const

const b64 = z.string().max(20_000_000)
const encryptedSchema = z.object({
  kdf: z.literal('scrypt'),
  N: z.number().int().min(2 ** 14).max(2 ** 20),
  r: z.number().int().min(1).max(32),
  p: z.number().int().min(1).max(16),
  salt: b64,
  iv: b64,
  tag: b64,
  data: b64
})

const fileSchema = z.object({
  format: z.literal(CONFIG_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().max(64),
  appVersion: z.string().max(64),
  // Se valida a fondo al importar cada API (importedApiSchema); aquí basta con lo que enseña la vista previa.
  apis: z
    .array(
      z.looseObject({
        id: z.string().min(1).max(100),
        name: z.string().max(200),
        baseUrl: z.string().max(2000),
        environment: z.enum(['dev', 'test', 'prod']),
        endpoints: z.array(z.unknown()).max(10000)
      })
    )
    .max(1000),
  secrets: encryptedSchema.nullable()
})

export type ConfigFile = z.infer<typeof fileSchema>

const secretsSchema = z.record(z.string().min(1).max(100), z.record(secretKeySchema, z.string().max(20000)))

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    // maxmem: scrypt con N = 2^15 necesita 32 MiB, justo el límite por defecto.
    scrypt(passphrase, salt, 32, { ...params, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

/** Fichero de exportación; `secrets` (por id de API) solo se incluye con clave. */
export async function buildConfigFile(
  apis: ApiConfig[],
  secrets: Record<string, Secrets> | null,
  passphrase: string | null,
  appVersion: string
): Promise<ConfigFile> {
  let encrypted: ConfigFile['secrets'] = null
  if (secrets && passphrase !== null) {
    if (passphrase.length < MIN_PASSPHRASE) throw new Error(`La clave debe tener al menos ${MIN_PASSPHRASE} caracteres`)
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt, KDF), iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
    encrypted = {
      kdf: 'scrypt',
      ...KDF,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    }
  }
  // Una ApiConfig es un objeto plano: encaja en el esquema abierto del fichero.
  return { format: CONFIG_FORMAT, version: 1, exportedAt: new Date().toISOString(), appVersion, apis: apis as unknown as ConfigFile['apis'], secrets: encrypted }
}

/** Lee y valida un fichero exportado; los errores se explican para el usuario. */
export function parseConfigFile(text: string): ConfigFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('El fichero no es un JSON válido')
  }
  if ((json as { format?: unknown } | null)?.format !== CONFIG_FORMAT) throw new Error('El fichero no es una exportación de Gestor API')
  const parsed = fileSchema.safeParse(json)
  if (!parsed.success) throw new Error('La exportación está incompleta o dañada')
  return parsed.data
}

/** Credenciales del fichero; la clave equivocada (o un fichero alterado) da un error claro. */
export async function decryptSecrets(file: ConfigFile, passphrase: string): Promise<Record<string, Secrets>> {
  const enc = file.secrets
  if (!enc) return {}
  try {
    const key = await deriveKey(passphrase, Buffer.from(enc.salt, 'base64'), enc)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]).toString('utf8')
    return secretsSchema.parse(JSON.parse(plain)) as Record<string, Secrets>
  } catch {
    throw new Error('Clave incorrecta: no se han podido descifrar las credenciales')
  }
}

/** Fichero con las APIs elegidas (con carpetas, endpoints y variables), en el orden en que están guardadas. */
export async function exportApis(store: ApiStore, vault: SecretVault, ids: string[], passphrase: string | null, appVersion: string): Promise<ConfigFile> {
  const wanted = new Set(ids)
  const apis = (await store.list()).filter((a) => wanted.has(a.id)).map(({ storedSecrets: _stored, ...config }) => config)
  if (apis.length === 0) throw new Error('No hay APIs que exportar')
  const secrets = passphrase === null ? null : Object.fromEntries(await Promise.all(apis.map(async (a) => [a.id, await vault.get(a.id)] as const)))
  return buildConfigFile(apis, secrets, passphrase, appVersion)
}

/** Importa las APIs elegidas. Con el mismo id que una existente, la sustituye. */
export async function importApis(store: ApiStore, file: ConfigFile, ids: string[], secrets: Record<string, Secrets>): Promise<ImportResult> {
  const wanted = new Set(ids)
  const existing = new Set((await store.list()).map((a) => a.id))
  const result: ImportResult = { added: 0, updated: 0, withSecrets: Object.keys(secrets).length > 0 }
  for (const api of file.apis.filter((a) => wanted.has(a.id))) {
    const name = api.name
    try {
      await store.importApi(importedApiSchema.parse(api), secrets[api.id])
    } catch (err) {
      throw new Error(`No se ha podido importar «${name}»: ${(err as Error).message}`)
    }
    if (existing.has(api.id)) result.updated++
    else result.added++
  }
  return result
}
