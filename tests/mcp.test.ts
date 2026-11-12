import { spawn } from 'node:child_process'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ApiSummary, McpApprovalRequest, McpState } from '@shared/types'
import { buildMcpb, createZip, fillBridge } from '../src/main/mcp/bundle'
import { serverPort, startHttpServer, stopHttpServer } from '../src/main/mcp/http'
import { handleMessage, type ProtocolHandlers } from '../src/main/mcp/protocol'
import { McpService } from '../src/main/mcp/service'
import { effectiveAccess, McpSettingsStore } from '../src/main/mcp/settings'
import { callTool, toolDefinitions } from '../src/main/mcp/tools'
import { RequestRunner, type FetchFn } from '../src/main/requests'
import { ApiStore } from '../src/main/store/apis'
import { SecretVault, type SecretCipher } from '../src/main/store/secrets'
import bridgeSource from '../src/mcp-bridge/bridge.cjs?raw'

const BRIDGE_PATH = join(import.meta.dirname, '../src/mcp-bridge/bridge.cjs')

/** Servidor MCP de pega con una herramienta «eco». */
const handlers: ProtocolHandlers = {
  serverVersion: '1.2.3',
  listTools: () => [],
  callTool: async (name) => ({ content: [{ type: 'text', text: `hola ${name}` }], isError: false })
}

const cipher: SecretCipher = {
  status: async () => ({ persistent: true, backend: 'fake' }),
  encrypt: async (plain) => Buffer.from(plain),
  decrypt: async (data) => ({ value: data.toString(), reencrypt: false })
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = ''
    req.on('data', (c: Buffer) => (data += c.toString()))
    req.on('end', () => resolve(data))
  })

describe('effectiveAccess', () => {
  it('en producción, cambiar datos siempre pide aprobación', () => {
    expect(effectiveAccess({ environment: 'prod' }, 'write')).toBe('confirm')
    expect(effectiveAccess({ environment: 'dev' }, 'write')).toBe('write')
    expect(effectiveAccess({ environment: 'prod' }, undefined)).toBe('off')
  })
})

/**
 * Herramientas con la app de verdad (almacén, RequestRunner) contra una API RPC de pega:
 * credenciales en el cuerpo, plantilla, listado de hoteles y respuesta siempre 200.
 */
describe('herramientas y servicio MCP', () => {
  let pms: Server
  let pmsUrl: string
  const received: Record<string, unknown>[] = []
  let dir: string
  let store: ApiStore
  let service: McpService
  let approvals: McpApprovalRequest[]
  let states: McpState[]
  let api: ApiSummary

  beforeAll(async () => {
    pms = createServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
      received.push(body)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body.access_token === 'secreto' ? { status: 'success', data: { echo: body.data } } : { status: 'error', message: 'Access not allowed' }))
    })
    await new Promise<void>((resolve) => pms.listen(0, '127.0.0.1', resolve))
    pmsUrl = `http://127.0.0.1:${(pms.address() as AddressInfo).port}/apiv2`
  })
  afterAll(() => new Promise<void>((resolve) => pms.close(() => resolve())))

  beforeEach(async () => {
    received.length = 0
    approvals = []
    states = []
    dir = await mkdtemp(join(tmpdir(), 'gestor-api-mcp-'))
    const vault = new SecretVault(dir, cipher)
    store = new ApiStore(dir, vault)
    const runner = new RequestRunner({ store, vault, fetch: fetch as unknown as FetchFn })
    const saved = await store.save({
      config: {
        name: 'PMS',
        baseUrl: pmsUrl,
        environment: 'prod',
        auth: { type: 'custom', fields: [{ name: 'access_token', in: 'body' }] },
        headers: [],
        variables: [{ name: 'hotel_id', value: '100001', options: [{ label: 'Hotel Norte', value: '100001' }, { label: 'Hotel Sur', value: '100002' }] }],
        bodyTemplate: '{"resource": "{{resource}}", "task": "{{task}}", "data": {{body}}}',
        responseRule: { successPath: 'status', successValue: 'success', messagePath: 'message' }
      },
      secrets: { 'field:access_token': 'secreto' }
    })
    let withFolder = await store.saveFolder(saved.id, { name: 'Informes' })
    const folderId = withFolder.folders[0]!.id
    await store.saveEndpoint(saved.id, {
      name: 'reports.invoices',
      method: 'POST',
      path: '',
      folderId,
      description: 'Facturas de un periodo.\nMás detalle.',
      params: [],
      body: { kind: 'json', example: '{"hotel_id": {{hotel_id}}, "start_date": "{{date.start_date}}", "end_date": "{{date.end_date}}"}' },
      vars: [
        { name: 'resource', value: 'reports' },
        { name: 'task', value: 'invoices' }
      ],
      modifies: false
    })
    withFolder = await store.saveEndpoint(saved.id, {
      name: 'booking.update_status',
      method: 'POST',
      path: '',
      params: [],
      body: { kind: 'json', example: '{"id": 1, "status": {{number.status}}}' },
      vars: [
        { name: 'resource', value: 'booking' },
        { name: 'task', value: 'update_status' }
      ],
      modifies: true
    })
    api = withFolder
    service = new McpService({
      settings: new McpSettingsStore(dir),
      apis: store,
      runner,
      version: '1.0.0',
      logPath: join(dir, 'logs', 'mcp.log'),
      onState: (s) => states.push(s),
      onApproval: (r) => {
        approvals.push(r)
        return true
      }
    })
    await service.init()
  })
  afterEach(async () => {
    await service.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const tool = async (name: string, args: unknown) => {
    const out = await callTool(name, args, service.backend())
    return { ...out, json: out.isError ? null : (JSON.parse(out.text) as Record<string, any>) }
  }
  const grant = (level: 'read' | 'confirm' | 'write') =>
    service.saveSettings({ enabled: false, port: 47331, access: { [api.id]: level } })

  it('sin acceso no se ve ninguna API', async () => {
    expect((await tool('list_apis', {})).json!.apis).toEqual([])
    expect((await tool('list_endpoints', { api: 'PMS' })).text).toMatch(/no ha dado acceso/)
  })

  it('list_apis, list_endpoints y describe_endpoint, sin credenciales a la vista', async () => {
    await grant('read')
    const apis = (await tool('list_apis', {})).json!.apis
    expect(apis[0]).toMatchObject({ name: 'PMS', environment: 'prod', access: 'read', endpoints: 2 })
    expect(apis[0].variables[0]).toMatchObject({ name: 'hotel_id', current: '100001' })

    const list = (await tool('list_endpoints', { api: 'pms', folder: 'informes' })).json!
    expect(list.endpoints).toEqual([
      { name: 'reports.invoices', id: expect.any(String), folder: 'Informes', method: 'POST', modifies: false, summary: 'Facturas de un periodo.' }
    ])
    const update = (await tool('list_endpoints', { api: 'PMS', search: 'status' })).json!.endpoints[0]
    expect(update).toMatchObject({ name: 'booking.update_status', modifies: true, allowed: false })

    const detail = (await tool('describe_endpoint', { api: 'PMS', endpoint: 'reports.invoices' })).json!
    expect(detail.fields.map((f: { name: string; kind: string }) => `${f.kind}:${f.name}`)).toEqual(['date:start_date', 'date:end_date'])
    expect(detail.request_preview.body).toContain('"access_token":"••••••"')
    expect(JSON.stringify(detail)).not.toContain('secreto')

    expect((await tool('describe_endpoint', { api: 'PMS', endpoint: 'reports' })).text).toMatch(/Parecidos: «reports.invoices»/)
  })

  it('call_endpoint: campos por nombre, otro hotel solo para esa llamada y la respuesta de la API', async () => {
    await grant('read')
    const out = await tool('call_endpoint', {
      api: 'PMS',
      endpoint: 'reports.invoices',
      params: { start_date: '2026-11-01', end_date: '2026-11-12' },
      variables: { hotel_id: 'Hotel Sur' }
    })
    expect(out.isError).toBe(false)
    expect(out.json).toMatchObject({ success: true, status: 200, response: { status: 'success', data: { echo: { hotel_id: 100002 } } } })
    expect(received.at(-1)).toEqual({
      resource: 'reports',
      task: 'invoices',
      data: { hotel_id: 100002, start_date: '2026-11-01', end_date: '2026-11-12' },
      access_token: 'secreto'
    })
    // Lo elegido en la app no cambia.
    expect((await store.get(api.id)).variables[0]!.value).toBe('100001')
    expect(out.text).not.toContain('secreto')

    expect((await tool('call_endpoint', { api: 'PMS', endpoint: 'reports.invoices', params: { hotel: 1 } })).text).toMatch(/no tiene: hotel.*Admite: start_date, end_date/)
    expect((await tool('call_endpoint', { api: 'PMS', endpoint: 'reports.invoices', variables: { otra: 1 } })).text).toMatch(/no existen/)
  })

  it('con solo consultas, los endpoints que modifican se bloquean sin enviar nada', async () => {
    await grant('read')
    const out = await tool('call_endpoint', { api: 'PMS', endpoint: 'booking.update_status', params: { status: 7 } })
    expect(out).toMatchObject({ isError: true, outcome: 'blocked' })
    expect(received).toHaveLength(0)
  })

  it('por HTTP: en producción, lo que modifica espera a que el usuario lo apruebe', async () => {
    const port = 46_000 + Math.floor(Math.random() * 1000)
    const state = await service.saveSettings({ enabled: true, port, access: { [api.id]: 'write' } })
    expect(state.running).toBe(true)
    const call = async (args: unknown) => {
      const res = await fetch(state.url!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_endpoint', arguments: args } })
      })
      return ((await res.json()) as { result: { content: { text: string }[]; isError: boolean } }).result
    }
    const pending = call({ api: 'PMS', endpoint: 'booking.update_status', params: { status: 7 } })
    await expect.poll(() => approvals.length).toBe(1)
    expect(approvals[0]).toMatchObject({ apiName: 'PMS', environment: 'prod', endpointName: 'booking.update_status' })
    expect(approvals[0]!.request.body).toContain('"status":7')
    expect(approvals[0]!.request.body).not.toContain('secreto')
    expect(received).toHaveLength(0)
    service.respondApproval(approvals[0]!.id, true)
    expect((await pending).isError).toBe(false)
    expect(received).toHaveLength(1)

    const second = call({ api: 'PMS', endpoint: 'booking.update_status', params: { status: 9 } })
    await expect.poll(() => approvals.length).toBe(2)
    service.respondApproval(approvals[1]!.id, false)
    expect(await second).toMatchObject({ isError: true })
    expect(received).toHaveLength(1)

    const logLines = async () => (await readFile(join(dir, 'logs', 'mcp.log'), 'utf8').catch(() => '')).trim().split('\n').length
    await expect.poll(logLines).toBe(2)
    expect(states.at(-1)!.activity[0]).toMatchObject({ tool: 'call_endpoint', outcome: 'rejected' })
  })

  it('informa del puerto ocupado sin romperse', async () => {
    const other = await startHttpServer({ port: 0, token: () => 'x', handlers })
    const state = await service.saveSettings({ enabled: true, port: serverPort(other), access: {} })
    expect(state.running).toBe(false)
    expect(state.error).toContain('ya está en uso')
    await stopHttpServer(other)
  })

  it('las definiciones llevan JSON Schema y anotaciones', () => {
    const defs = toolDefinitions()
    expect(defs.map((d) => d.name)).toEqual(['list_apis', 'list_endpoints', 'describe_endpoint', 'call_endpoint'])
    expect(defs.find((d) => d.name === 'call_endpoint')).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true } })
    expect(defs[1]!.inputSchema).toMatchObject({ type: 'object', required: ['api'] })
  })
})

describe('protocolo', () => {
  it('initialize acepta versiones conocidas y si no ofrece la más nueva', async () => {
    const reply = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, handlers)) as {
      result: { protocolVersion: string; serverInfo: { version: string } }
    }
    expect(reply.result.protocolVersion).toBe('2025-03-26')
    expect(reply.result.serverInfo.version).toBe('1.2.3')
    const other = (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, handlers)) as {
      result: { protocolVersion: string }
    }
    expect(other.result.protocolVersion).toBe('2025-11-25')
  })

  it('notificaciones sin respuesta, métodos desconocidos con error y lotes', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, handlers)).toBeNull()
    expect(await handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, handlers)).toMatchObject({ error: { code: -32601 } })
    expect(await handleMessage({ foo: 1 }, handlers)).toMatchObject({ error: { code: -32600 } })
    const batch = await handleMessage(
      [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'eco' } }
      ],
      handlers
    )
    expect(batch).toEqual([{ jsonrpc: '2.0', id: 'a', result: { content: [{ type: 'text', text: 'hola eco' }], isError: false } }])
  })
})

/** POST sin fetch para poder mandar cualquier Host. */
function post(port: number, body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

describe('servidor HTTP', () => {
  const TOKEN = 't'.repeat(43)
  let server: Server
  let port: number
  beforeEach(async () => {
    server = await startHttpServer({ port: 0, token: () => TOKEN, handlers })
    port = serverPort(server)
  })
  afterEach(() => stopHttpServer(server))

  const auth = { Authorization: `Bearer ${TOKEN}` }
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }

  it('exige el token', async () => {
    expect((await post(port, ping)).status).toBe(401)
    expect((await post(port, ping, { Authorization: 'Bearer otro' })).status).toBe(401)
    const ok = await post(port, ping, auth)
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('rechaza Host y Origin ajenos (DNS rebinding, webs)', async () => {
    expect((await post(port, ping, { ...auth, Host: `evil.example:${port}` })).status).toBe(403)
    expect((await post(port, ping, { ...auth, Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(port, ping, { ...auth, Origin: `http://localhost:${port}` })).status).toBe(200)
  })

  it('202 para notificaciones, 405 para GET, 400 para JSON roto', async () => {
    expect((await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status).toBe(202)
    expect((await post(port, undefined, auth, 'GET')).status).toBe(405)
    const broken = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.end('{no es json')
    })
    expect(broken).toBe(400)
  })
})

/** Lanza el puente y le habla por stdin/stdout como lo haría Claude Desktop. */
async function talkToBridge(env: Record<string, string>, messages: unknown[]): Promise<Record<string, unknown>[]> {
  const child = spawn(process.execPath, [BRIDGE_PATH], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n')
  child.stdin.end()
  await new Promise((resolve) => child.on('exit', resolve))
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('puente de Claude Desktop', () => {
  let dir: string
  let server: Server
  const TOKEN = 'k'.repeat(43)
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-api-mcp-'))
    server = await startHttpServer({ port: 0, token: () => TOKEN, handlers })
  })
  afterEach(async () => {
    await stopHttpServer(server)
    await rm(dir, { recursive: true, force: true })
  })

  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }

  it('reenvía a la app leyendo puerto y token de mcp.json', async () => {
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ enabled: true, port: serverPort(server), token: TOKEN }))
    const replies = await talkToBridge({ GESTOR_API_DATA_DIR: dir }, [
      init,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'eco', arguments: {} } }
    ])
    expect(replies.find((r) => r.id === 1)).toMatchObject({ result: { protocolVersion: '2025-06-18', serverInfo: { version: '1.2.3' } } })
    expect(replies.find((r) => r.id === 2)).toMatchObject({ result: { content: [{ text: 'hola eco' }] } })
    expect(replies).toHaveLength(2)
  })

  it('con la app cerrada o el servidor desactivado contesta él mismo y explica qué hacer', async () => {
    const tools = toolDefinitions()
    const filled = join(dir, 'bridge.cjs')
    await writeFile(filled, fillBridge(bridgeSource, tools, '9.9.9'))
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ enabled: false, port: serverPort(server), token: TOKEN }))
    const child = spawn(process.execPath, [filled], { env: { GESTOR_API_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stdin.end(
      [init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_endpoint', arguments: {} } }]
        .map((m) => JSON.stringify(m))
        .join('\n') + '\n'
    )
    await new Promise((resolve) => child.on('exit', resolve))
    const replies = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(replies.find((r) => r.id === 1).result.serverInfo.version).toBe('9.9.9')
    expect(replies.find((r) => r.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(tools.map((t) => t.name))
    expect(replies.find((r) => r.id === 3).result).toMatchObject({ isError: true })
    expect(replies.find((r) => r.id === 3).result.content[0].text).toContain('Ajustes')
  })
})

describe('extensión .mcpb', () => {
  /** Lee un zip sencillo (sin zip64) para comprobar lo que genera createZip. */
  function unzip(buf: Buffer): Record<string, Buffer> {
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    const count = buf.readUInt16LE(end + 10)
    let p = buf.readUInt32LE(end + 16)
    const files: Record<string, Buffer> = {}
    for (let i = 0; i < count; i++) {
      expect(buf.readUInt32LE(p)).toBe(0x02014b50)
      const size = buf.readUInt32LE(p + 20)
      const nameLen = buf.readUInt16LE(p + 28)
      const extra = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
      const offset = buf.readUInt32LE(p + 42)
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString()
      const localName = buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28)
      files[name] = inflateRawSync(buf.subarray(offset + 30 + localName, offset + 30 + localName + size))
      p += 46 + nameLen + extra
    }
    return files
  }

  it('createZip produce un zip legible', () => {
    const files = unzip(createZip([{ name: 'a.txt', data: Buffer.from('hola') }, { name: 'dir/ñ.txt', data: Buffer.from('x'.repeat(1000)) }]))
    expect(files['a.txt']!.toString()).toBe('hola')
    expect(files['dir/ñ.txt']!.toString()).toBe('x'.repeat(1000))
  })

  it('lleva manifest, puente con las herramientas y la carpeta de datos', () => {
    const files = unzip(
      buildMcpb({ version: '1.0.0', dataDir: 'C:\\Users\\Ana\\AppData\\Roaming\\Gestor API', bridgeSource, tools: toolDefinitions(), icon: Buffer.from('png') })
    )
    const manifest = JSON.parse(files['manifest.json']!.toString())
    expect(manifest).toMatchObject({
      manifest_version: '0.3',
      name: 'gestor-api',
      version: '1.0.0',
      icon: 'icon.png',
      server: {
        type: 'node',
        entry_point: 'server/index.js',
        mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { GESTOR_API_DATA_DIR: 'C:\\Users\\Ana\\AppData\\Roaming\\Gestor API' } }
      }
    })
    expect(manifest.tools).toHaveLength(4)
    const bridge = files['server/index.js']!.toString()
    expect(bridge).toContain('"call_endpoint"')
    expect(bridge).not.toContain('/*@@')
    expect(files['icon.png']!.toString()).toBe('png')
  })
})

describe('McpSettingsStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-api-mcp-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('crea mcp.json con token y permisos 0600, desactivado por defecto', async () => {
    const store = new McpSettingsStore(dir)
    const file = await store.get()
    expect(file.enabled).toBe(false)
    expect(file.token.length).toBeGreaterThanOrEqual(43)
    const onDisk = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
    expect(onDisk.token).toBe(file.token)
    if (process.platform !== 'win32') expect((await stat(join(dir, 'mcp.json'))).mode & 0o777).toBe(0o600)
    expect((await new McpSettingsStore(dir).get()).token).toBe(file.token)
  })

  it('guarda solo los accesos distintos de off, olvida APIs borradas y regenera el token', async () => {
    const store = new McpSettingsStore(dir)
    const { token } = await store.get()
    await store.save({ enabled: true, port: 40000, access: { a: 'read', b: 'off' } })
    expect((await store.get()).access).toEqual({ a: 'read' })
    await store.forgetApi('a')
    expect((await new McpSettingsStore(dir).get()).access).toEqual({})
    expect((await store.regenerateToken()).token).not.toBe(token)
    await expect(store.save({ enabled: true, port: 80, access: {} })).rejects.toThrow()
  })
})
