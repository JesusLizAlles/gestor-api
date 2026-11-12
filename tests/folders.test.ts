import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Endpoint, EndpointInput, Folder } from '@shared/types'
import { applyMove, countEndpoints, flattenFolders, folderLabel, removeFolder } from '@shared/folders'
import { ApiStore } from '../src/main/store/apis'
import { SecretVault, type SecretCipher } from '../src/main/store/secrets'

const ep = (id: string, folderId?: string): Endpoint => ({
  id,
  name: id,
  method: 'GET',
  path: '/',
  params: [],
  body: { kind: 'none' },
  vars: [],
  ...(folderId ? { folderId } : {})
})

// reservas
//   llegadas
// clientes
const tree = () => ({
  folders: [
    { id: 'reservas', name: 'Reservas' },
    { id: 'clientes', name: 'Clientes' },
    { id: 'llegadas', name: 'Llegadas', parentId: 'reservas' }
  ] as Folder[],
  endpoints: [ep('a', 'reservas'), ep('b', 'reservas'), ep('c'), ep('d', 'llegadas')]
})

const ids = (list: { id: string }[]) => list.map((x) => x.id)

describe('árbol de carpetas', () => {
  it('rutas, orden de árbol y recuento', () => {
    const t = tree()
    expect(folderLabel(t.folders, 'llegadas')).toBe('Reservas / Llegadas')
    expect(flattenFolders(t.folders).map(({ folder, depth }) => `${depth}:${folder.id}`)).toEqual(['0:reservas', '1:llegadas', '0:clientes'])
    expect(countEndpoints(t, 'reservas')).toBe(3)
  })

  it('mueve un endpoint a otra carpeta y posición', () => {
    const t = applyMove(tree(), { kind: 'endpoint', id: 'c', parentId: 'reservas', index: 1 })
    expect(t.endpoints.filter((e) => e.folderId === 'reservas').map((e) => e.id)).toEqual(['a', 'c', 'b'])
    const back = applyMove(t, { kind: 'endpoint', id: 'a', parentId: null, index: 99 })
    expect(back.endpoints.find((e) => e.id === 'a')).not.toHaveProperty('folderId')
  })

  it('reordena carpetas y no deja meter una carpeta dentro de sí misma', () => {
    const t = applyMove(tree(), { kind: 'folder', id: 'clientes', parentId: null, index: 0 })
    expect(ids(t.folders.filter((f) => !f.parentId))).toEqual(['clientes', 'reservas'])
    expect(() => applyMove(tree(), { kind: 'folder', id: 'reservas', parentId: 'llegadas', index: 0 })).toThrow(/sí misma/)
    expect(() => applyMove(tree(), { kind: 'endpoint', id: 'a', parentId: 'nada', index: 0 })).toThrow(/no existe/)
  })

  it('al borrar una carpeta, su contenido sube un nivel', () => {
    const t = removeFolder(tree(), 'reservas')
    expect(ids(t.folders)).toEqual(['clientes', 'llegadas'])
    expect(t.folders.find((f) => f.id === 'llegadas')).not.toHaveProperty('parentId')
    expect(t.endpoints.map((e) => e.folderId)).toEqual([undefined, undefined, undefined, 'llegadas'])
  })
})

const cipher: SecretCipher = {
  status: async () => ({ persistent: true, backend: 'fake' }),
  encrypt: async (plain) => Buffer.from(plain),
  decrypt: async (data) => ({ value: data.toString(), reencrypt: false })
}

describe('ApiStore: carpetas', () => {
  let dir: string
  let store: ApiStore
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-api-folders-'))
    store = new ApiStore(dir, new SecretVault(dir, cipher))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const endpointInput = (folderId?: string): EndpointInput => ({ name: 'Ver', method: 'GET', path: '/', params: [], body: { kind: 'none' }, folderId })

  it('crea, renombra, mueve y borra carpetas; se conservan al editar la API', async () => {
    const api = await store.save({ config: { name: 'PMS', baseUrl: 'https://x.test', environment: 'dev', auth: { type: 'none' }, headers: [], variables: [] } })
    let saved = await store.saveFolder(api.id, { name: 'Reservas' })
    const reservas = saved.folders[0]!
    saved = await store.saveFolder(api.id, { name: 'Llegadas', parentId: reservas.id })
    const llegadas = saved.folders[1]!
    saved = await store.saveEndpoint(api.id, endpointInput(llegadas.id))
    expect(saved.endpoints[0]!.folderId).toBe(llegadas.id)

    await expect(store.saveFolder(api.id, { id: reservas.id, name: 'Reservas', parentId: llegadas.id })).rejects.toThrow(/sí misma/)
    await expect(store.saveEndpoint(api.id, endpointInput('no-existe'))).rejects.toThrow(/no existe/)

    saved = await store.saveFolder(api.id, { id: reservas.id, name: 'Bookings' })
    expect(saved.folders[0]!.name).toBe('Bookings')
    saved = await store.save({ config: { id: api.id, name: 'PMS 2', baseUrl: 'https://x.test', environment: 'dev', auth: { type: 'none' }, headers: [], variables: [] } })
    expect(saved.folders).toHaveLength(2)

    saved = await store.moveItem(api.id, { kind: 'folder', id: llegadas.id, parentId: null, index: 0 })
    expect(saved.folders.map((f) => f.name)).toEqual(['Llegadas', 'Bookings'])

    saved = await store.deleteFolder(api.id, llegadas.id)
    expect(saved.folders.map((f) => f.name)).toEqual(['Bookings'])
    expect(saved.endpoints[0]).not.toHaveProperty('folderId')
  })

  it('convierte los grupos de texto de versiones anteriores en carpetas (y lo guarda)', async () => {
    const legacy = {
      version: 1,
      apis: [
        {
          id: 'a1',
          name: 'Vieja',
          baseUrl: 'https://x.test',
          environment: 'dev',
          auth: { type: 'none' },
          headers: [],
          endpoints: [
            { id: 'e1', name: 'Uno', method: 'GET', path: '/', params: [], body: { kind: 'none' }, group: 'Reservas' },
            { id: 'e2', name: 'Dos', method: 'GET', path: '/', params: [], body: { kind: 'none' }, group: 'Reservas / Llegadas' },
            { id: 'e3', name: 'Tres', method: 'GET', path: '/', params: [], body: { kind: 'none' } }
          ]
        }
      ]
    }
    await writeFile(join(dir, 'apis.json'), JSON.stringify(legacy))
    const [api] = await store.list()
    expect(api!.folders.map((f) => folderLabel(api!.folders, f.id))).toEqual(['Reservas', 'Reservas / Llegadas'])
    expect(api!.endpoints.map((e) => folderLabel(api!.folders, e.folderId))).toEqual(['Reservas', 'Reservas / Llegadas', ''])
    expect(api!.endpoints[0]).not.toHaveProperty('group')
    const onDisk = JSON.parse(await readFile(join(dir, 'apis.json'), 'utf8')) as { apis: { folders: Folder[] }[] }
    expect(onDisk.apis[0]!.folders).toHaveLength(2)
  })
})

describe('credenciales pegadas', () => {
  it('se guardan sin espacios ni saltos de línea alrededor', async () => {
    const { saveApiSchema } = await import('../src/main/validation')
    const parsed = saveApiSchema.parse({
      config: { name: 'X', baseUrl: 'https://x.test', environment: 'dev', auth: { type: 'bearer' }, headers: [], variables: [] },
      secrets: { token: '  abc123\n', password: null }
    })
    expect(parsed.secrets).toEqual({ token: 'abc123', password: null })
  })
})
