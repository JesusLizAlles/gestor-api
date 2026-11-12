import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApiInput, EndpointInput } from '@shared/types'
import { ApiStore } from '../src/main/store/apis'
import { SecretVault, type SecretCipher } from '../src/main/store/secrets'

/** Cifrado de pega: invierte y codifica, suficiente para comprobar que nada se guarda en claro. */
const fakeCipher = (persistent: boolean): SecretCipher => ({
  status: async () => ({ persistent, backend: persistent ? 'fake' : 'basic_text' }),
  encrypt: async (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`),
  decrypt: async (data) => ({ value: [...data.toString().slice(4)].reverse().join(''), reencrypt: false })
})

const apiInput = (overrides: Partial<ApiInput> = {}): ApiInput => ({
  name: 'Motor de reservas',
  baseUrl: 'https://api.test/v1',
  environment: 'dev',
  auth: { type: 'bearer' },
  headers: [{ name: 'Accept-Language', value: 'es' }],
  variables: [],
  ...overrides
})

const endpointInput = (overrides: Partial<EndpointInput> = {}): EndpointInput => ({
  name: 'Ver reserva',
  method: 'GET',
  path: '/reservas/{id}',
  params: [{ name: 'id', in: 'path', type: 'string', required: true }],
  body: { kind: 'none' },
  ...overrides
})

describe('ApiStore + SecretVault', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-api-store-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('guarda la API sin el token, y el token cifrado aparte', async () => {
    const vault = new SecretVault(dir, fakeCipher(true))
    const store = new ApiStore(dir, vault)
    const saved = await store.save({ config: apiInput(), secrets: { token: 'token-secreto' } })

    expect(saved.storedSecrets).toEqual(['token'])
    const apis = await readFile(join(dir, 'apis.json'), 'utf8')
    const secrets = await readFile(join(dir, 'secrets.json'), 'utf8')
    expect(apis).not.toContain('token-secreto')
    expect(secrets).not.toContain('token-secreto')
    expect(await vault.get(saved.id)).toEqual({ token: 'token-secreto' })
    expect((await stat(join(dir, 'apis.json'))).mode & 0o777).toBe(0o600)
  })

  it('al editar la API conserva sus endpoints y el token si no se cambia', async () => {
    const vault = new SecretVault(dir, fakeCipher(true))
    const store = new ApiStore(dir, vault)
    const api = await store.save({ config: apiInput(), secrets: { token: 't1' } })
    await store.saveEndpoint(api.id, endpointInput())

    const edited = await store.save({ config: apiInput({ id: api.id, name: 'Reservas' }) })
    expect(edited.name).toBe('Reservas')
    expect(edited.endpoints).toHaveLength(1)
    expect(await vault.get(api.id)).toEqual({ token: 't1' })
  })

  it('al cambiar de autenticación borra los secretos que ya no se usan', async () => {
    const vault = new SecretVault(dir, fakeCipher(true))
    const store = new ApiStore(dir, vault)
    const api = await store.save({ config: apiInput(), secrets: { token: 't1' } })
    const edited = await store.save({
      config: apiInput({ id: api.id, auth: { type: 'basic', username: 'ana' } }),
      secrets: { password: 'clave', token: 'ignorado' }
    })
    expect(edited.storedSecrets).toEqual(['password'])
    expect(await vault.get(api.id)).toEqual({ password: 'clave' })
  })

  it('crea, sustituye y borra endpoints', async () => {
    const store = new ApiStore(dir, new SecretVault(dir, fakeCipher(true)))
    const api = await store.save({ config: apiInput() })
    const withOne = await store.saveEndpoint(api.id, endpointInput())
    const endpoint = withOne.endpoints[0]!
    const renamed = await store.saveEndpoint(api.id, endpointInput({ id: endpoint.id, name: 'Consultar reserva' }))
    expect(renamed.endpoints.map((e) => e.name)).toEqual(['Consultar reserva'])
    expect((await store.deleteEndpoint(api.id, endpoint.id)).endpoints).toEqual([])
  })

  it('al borrar la API borra también sus secretos', async () => {
    const vault = new SecretVault(dir, fakeCipher(true))
    const store = new ApiStore(dir, vault)
    const api = await store.save({ config: apiInput(), secrets: { token: 't1' } })
    await store.delete(api.id)
    expect(await store.list()).toEqual([])
    expect(await vault.get(api.id)).toEqual({})
  })

  it('rechaza URLs que no son http(s) y cabeceras con saltos de línea', async () => {
    const store = new ApiStore(dir, new SecretVault(dir, fakeCipher(true)))
    await expect(store.save({ config: apiInput({ baseUrl: 'file:///etc/passwd' }) })).rejects.toThrow(/http/)
    await expect(
      store.save({ config: apiInput({ headers: [{ name: 'X-Test', value: 'a\r\nSet-Cookie: x' }] }) })
    ).rejects.toThrow(/saltos de línea/)
  })

  it('sin llavero, los secretos se quedan en memoria y no se escriben en disco', async () => {
    const store = new ApiStore(dir, new SecretVault(dir, fakeCipher(false)))
    const api = await store.save({ config: apiInput(), secrets: { token: 't1' } })
    expect(api.storedSecrets).toEqual(['token'])
    await expect(stat(join(dir, 'secrets.json'))).rejects.toThrow()
  })
})
