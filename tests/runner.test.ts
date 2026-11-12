import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ApiInput } from '@shared/types'
import { SECRET_MASK } from '@shared/request'
import { RequestRunner, type FetchFn } from '../src/main/requests'
import { ApiStore } from '../src/main/store/apis'
import { SecretVault, type SecretCipher } from '../src/main/store/secrets'

const cipher: SecretCipher = {
  status: async () => ({ persistent: true, backend: 'fake' }),
  encrypt: async (plain) => Buffer.from(plain),
  decrypt: async (data) => ({ value: data.toString(), reencrypt: false })
}

interface Seen {
  method?: string
  url?: string
  headers: IncomingMessage['headers']
  body: string
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = ''
    req.on('data', (c: Buffer) => (data += c.toString()))
    req.on('end', () => resolve(data))
  })

describe('RequestRunner', () => {
  let server: Server
  let base: string
  let seen: Seen[] = []
  let tokenCalls = 0
  let dir: string
  let store: ApiStore
  let runner: RequestRunner

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = await readBody(req)
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (req.url === '/token') {
        tokenCalls++
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ access_token: `tok${tokenCalls}`, expires_in: 3600 }))
        return
      }
      if (req.url === '/slow') return void setTimeout(() => res.end('tarde'), 5000)
      if (req.url === '/binary') {
        res.setHeader('Content-Type', 'image/png')
        return void res.end(Buffer.alloc(300))
      }
      res.setHeader('Content-Type', 'application/json')
      const parsed = body ? (JSON.parse(body) as { task?: string }) : {}
      res.end(JSON.stringify(parsed.task === 'falla' ? { status: 'error', code: 3, message: 'Hotel no válido' } : { status: 'success', data: { echo: parsed } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  beforeEach(async () => {
    seen = []
    tokenCalls = 0
    dir = await mkdtemp(join(tmpdir(), 'gestor-api-runner-'))
    const vault = new SecretVault(dir, cipher)
    store = new ApiStore(dir, vault)
    runner = new RequestRunner({ store, vault, fetch: fetch as unknown as FetchFn })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const api = (overrides: Partial<ApiInput> = {}): ApiInput => ({
    name: 'PMS',
    baseUrl: `${base}/apiv2`,
    environment: 'prod',
    auth: { type: 'custom', fields: [{ name: 'access_token', in: 'body' }] },
    headers: [],
    variables: [{ name: 'hotel_id', value: '100001', options: [{ label: 'Punta Negra', value: '100001' }] }],
    bodyTemplate: '{"resource": "{{resource}}", "task": "{{task}}", "data": {{body}}}',
    responseRule: { successPath: 'status', successValue: 'success', messagePath: 'message' },
    ...overrides
  })

  it('envía con el secreto real y devuelve la petición con el secreto tapado', async () => {
    const saved = await store.save({ config: api(), secrets: { 'field:access_token': 'secreto-real' } })
    const withEndpoint = await store.saveEndpoint(saved.id, {
      name: 'Llegadas',
      method: 'POST',
      path: '',
      params: [],
      body: { kind: 'json', example: '{"filters": {"hotel_id": {{hotel_id}}}}' },
      vars: [
        { name: 'resource', value: 'frontdesk' },
        { name: 'task', value: 'arrivals' }
      ],
      modifies: false
    })
    const ep = withEndpoint.endpoints[0]!
    const result = await runner.send({ runId: 'r1', apiId: saved.id, endpointId: ep.id, values: {}, body: ep.body.example! })

    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    expect(result.response?.status).toBe(200)
    expect(JSON.parse(seen[0]!.body)).toEqual({ resource: 'frontdesk', task: 'arrivals', data: { filters: { hotel_id: 100001 } }, access_token: 'secreto-real' })
    // El servidor de prueba devuelve lo recibido: lo que no debe llevar el secreto es la petición que ve el usuario.
    expect(JSON.stringify(result.request)).not.toContain('secreto-real')
    expect(JSON.parse(result.request.body!).access_token).toBe(SECRET_MASK)
  })

  it('un 200 con status=error cuenta como error y trae el mensaje de la API', async () => {
    const saved = await store.save({ config: api(), secrets: { 'field:access_token': 'x' } })
    const { endpoints } = await store.saveEndpoint(saved.id, {
      name: 'Falla',
      method: 'POST',
      path: '',
      params: [],
      body: { kind: 'none' },
      vars: [
        { name: 'resource', value: 'r' },
        { name: 'task', value: 'falla' }
      ]
    })
    const result = await runner.send({ runId: 'r2', apiId: saved.id, endpointId: endpoints[0]!.id, values: {}, body: '' })
    expect(result.success).toBe(false)
    expect(result.message).toBe('Hotel no válido')
  })

  it('no envía si falta un dato obligatorio', async () => {
    const saved = await store.save({ config: api({ auth: { type: 'none' }, bodyTemplate: undefined, responseRule: undefined }) })
    const { endpoints } = await store.saveEndpoint(saved.id, {
      name: 'Ver',
      method: 'GET',
      path: '/x/{id}',
      params: [{ name: 'id', in: 'path', type: 'string', required: true }],
      body: { kind: 'none' }
    })
    const result = await runner.send({ runId: 'r3', apiId: saved.id, endpointId: endpoints[0]!.id, values: {}, body: '' })
    expect(result.error).toMatch(/Falta rellenar: id/)
    expect(seen).toHaveLength(0)
  })

  it('OAuth 2.0: pide el token una vez y lo reutiliza', async () => {
    const saved = await store.save({
      config: api({ auth: { type: 'oauth2', tokenUrl: `${base}/token`, clientId: 'cli' }, bodyTemplate: undefined, responseRule: undefined }),
      secrets: { clientSecret: 'cs' }
    })
    const { endpoints } = await store.saveEndpoint(saved.id, { name: 'Ver', method: 'GET', path: '/x', params: [], body: { kind: 'none' } })
    const input = { apiId: saved.id, endpointId: endpoints[0]!.id, values: {}, body: '' }
    await runner.send({ runId: 'a', ...input })
    await runner.send({ runId: 'b', ...input })
    expect(tokenCalls).toBe(1)
    expect(seen[0]!.body).toContain('client_secret=cs')
    expect(seen.filter((s) => s.url === '/apiv2/x').map((s) => s.headers.authorization)).toEqual(['Bearer tok1', 'Bearer tok1'])
  })

  it('se puede cancelar una llamada en curso', async () => {
    const saved = await store.save({ config: api({ auth: { type: 'none' }, baseUrl: base, bodyTemplate: undefined, responseRule: undefined }) })
    const { endpoints } = await store.saveEndpoint(saved.id, { name: 'Lenta', method: 'GET', path: '/slow', params: [], body: { kind: 'none' } })
    const pending = runner.send({ runId: 'lenta', apiId: saved.id, endpointId: endpoints[0]!.id, values: {}, body: '' })
    await new Promise((r) => setTimeout(r, 100))
    runner.cancel('lenta')
    const result = await pending
    expect(result.error).toBe('Cancelada')
    expect(result.success).toBe(false)
  })

  it('los binarios no se decodifican y los errores de red se explican', async () => {
    const saved = await store.save({ config: api({ auth: { type: 'none' }, baseUrl: base, bodyTemplate: undefined, responseRule: undefined }) })
    const { endpoints } = await store.saveEndpoint(saved.id, { name: 'Imagen', method: 'GET', path: '/binary', params: [], body: { kind: 'none' } })
    const result = await runner.send({ runId: 'bin', apiId: saved.id, endpointId: endpoints[0]!.id, values: {}, body: '' })
    expect(result.response).toMatchObject({ binary: true, body: '', size: 300 })

    // Un puerto que estaba libre y ya no escucha nadie.
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const down = await store.save({ config: api({ auth: { type: 'none' }, baseUrl: `http://127.0.0.1:${port}`, bodyTemplate: undefined, responseRule: undefined }) })
    const { endpoints: eps } = await store.saveEndpoint(down.id, { name: 'X', method: 'GET', path: '/', params: [], body: { kind: 'none' } })
    const failed = await runner.send({ runId: 'down', apiId: down.id, endpointId: eps[0]!.id, values: {}, body: '' })
    expect(failed.error).toMatch(/rechazado la conexión/)
  })
})
