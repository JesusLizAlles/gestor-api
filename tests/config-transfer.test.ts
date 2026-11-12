import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptSecrets, exportApis, importApis, parseConfigFile } from '../src/main/config-transfer'
import { ApiStore } from '../src/main/store/apis'
import { SecretVault, type SecretCipher } from '../src/main/store/secrets'

const cipher: SecretCipher = {
  status: async () => ({ persistent: true, backend: 'fake' }),
  encrypt: async (plain) => Buffer.from(`enc:${plain}`),
  decrypt: async (data) => ({ value: data.toString().slice(4), reencrypt: false })
}

describe('exportar e importar la configuración', () => {
  let dirs: string[] = []
  const machine = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gestor-api-transfer-'))
    dirs.push(dir)
    const vault = new SecretVault(dir, cipher)
    return { store: new ApiStore(dir, vault), vault }
  }
  beforeEach(() => {
    dirs = []
  })
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true })
  })

  /** Un equipo con una API completa: carpetas anidadas, endpoints, listado y credenciales. */
  async function origin() {
    const m = await machine()
    const api = await m.store.save({
      config: {
        name: 'GuestPro',
        baseUrl: 'https://pms.test/apiv2',
        environment: 'prod',
        auth: { type: 'custom', fields: [{ name: 'access_token', in: 'body' }, { name: 'access_token_secret', in: 'body' }] },
        headers: [],
        variables: [{ name: 'hotel_id', value: '100001', options: [{ label: 'Hotel Norte', value: '100001' }] }],
        bodyTemplate: '{"resource": "{{resource}}", "data": {{body}}}'
      },
      secrets: { 'field:access_token': 'TOKEN', 'field:access_token_secret': 'SECRETO' }
    })
    const parent = (await m.store.saveFolder(api.id, { name: 'Reservas' })).folders[0]!
    const child = (await m.store.saveFolder(api.id, { name: 'booking', parentId: parent.id })).folders[1]!
    await m.store.saveEndpoint(api.id, { name: 'booking.get', method: 'POST', path: '', folderId: child.id, params: [], body: { kind: 'json', example: '{"id": 1}' }, vars: [{ name: 'resource', value: 'booking' }] })
    const other = await m.store.save({ config: { name: 'Otra', baseUrl: 'https://otra.test', environment: 'dev', auth: { type: 'none' }, headers: [], variables: [] } })
    return { ...m, api: await m.store.get(api.id), other }
  }

  it('sin clave: lleva todo menos las credenciales; con clave, las cifra', async () => {
    const { store, vault, api } = await origin()
    const plain = await exportApis(store, vault, [api.id], null, '1.0.0')
    expect(plain.secrets).toBeNull()
    expect(plain.apis).toHaveLength(1)
    expect(JSON.stringify(plain)).not.toContain('TOKEN')

    const file = await exportApis(store, vault, [api.id], 'clave-larga', '1.0.0')
    const text = JSON.stringify(file)
    expect(text).not.toContain('TOKEN')
    expect(text).not.toContain('SECRETO')
    const parsed = parseConfigFile(text)
    await expect(decryptSecrets(parsed, 'otra-clave')).rejects.toThrow(/Clave incorrecta/)
    expect(await decryptSecrets(parsed, 'clave-larga')).toEqual({ [api.id]: { 'field:access_token': 'TOKEN', 'field:access_token_secret': 'SECRETO' } })
    await expect(exportApis(store, vault, [api.id], 'corta', '1.0.0')).rejects.toThrow(/al menos 8/)
  })

  it('en otro equipo queda igual (carpetas, endpoints, variables y credenciales) y reimportar no duplica', async () => {
    const { store, vault, api } = await origin()
    const file = parseConfigFile(JSON.stringify(await exportApis(store, vault, [api.id], 'clave-larga', '1.0.0')))
    const target = await machine()
    const secrets = await decryptSecrets(file, 'clave-larga')
    expect(await importApis(target.store, file, [api.id], secrets)).toEqual({ added: 1, updated: 0, withSecrets: true })
    const [copy] = await target.store.list()
    const { storedSecrets, ...config } = copy!
    expect(config).toEqual(api)
    expect(storedSecrets.sort()).toEqual(['field:access_token', 'field:access_token_secret'])
    expect(await target.vault.get(api.id)).toEqual({ 'field:access_token': 'TOKEN', 'field:access_token_secret': 'SECRETO' })

    // Otra vez, sin credenciales: sustituye la configuración y conserva las credenciales guardadas.
    expect(await importApis(target.store, file, [api.id], {})).toEqual({ added: 0, updated: 1, withSecrets: false })
    expect(await target.store.list()).toHaveLength(1)
    expect(await target.vault.get(api.id)).toEqual({ 'field:access_token': 'TOKEN', 'field:access_token_secret': 'SECRETO' })
  })

  it('se eligen las APIs a exportar e importar', async () => {
    const { store, vault, api, other } = await origin()
    const file = parseConfigFile(JSON.stringify(await exportApis(store, vault, [api.id, other.id], null, '1.0.0')))
    expect(file.apis.map((a) => a.name)).toEqual(['GuestPro', 'Otra'])
    const target = await machine()
    await importApis(target.store, file, [other.id], {})
    expect((await target.store.list()).map((a) => a.name)).toEqual(['Otra'])
  })

  it('ficheros que no son una exportación o vienen dañados', async () => {
    expect(() => parseConfigFile('no json')).toThrow(/no es un JSON/)
    expect(() => parseConfigFile('{"format": "gestor-bbdd-config"}')).toThrow(/no es una exportación de Gestor API/)
    expect(() => parseConfigFile('{"format": "gestor-api-config", "version": 1}')).toThrow(/incompleta o dañada/)

    // Referencias rotas (carpeta que no existe) se arreglan al importar en vez de romper el árbol.
    const { store, vault, api } = await origin()
    const file = parseConfigFile(JSON.stringify(await exportApis(store, vault, [api.id], null, '1.0.0')))
    const broken = file.apis[0] as unknown as { endpoints: { folderId?: string }[] }
    broken.endpoints[0]!.folderId = 'no-existe'
    const target = await machine()
    await importApis(target.store, file, [api.id], {})
    expect((await target.store.list())[0]!.endpoints[0]).not.toHaveProperty('folderId')
  })
})
