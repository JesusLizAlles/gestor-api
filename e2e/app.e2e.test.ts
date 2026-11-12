// Prueba de humo de la app completa con Playwright controlando Electron.
// Requiere `npm run build`. E2E_SCREENSHOTS=/ruta guarda capturas de cada paso.
// E2E_RENDERER_URL=http://localhost:5173 usa la interfaz de `npm run dev` en vez de la compilada.
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createInterface } from 'node:readline'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const env = process.env

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

type McpResult = { content?: { text: string }[]; isError?: boolean } & Record<string, unknown>

/** El puente de Claude Desktop, hablándole por stdin/stdout como lo hace Claude. */
function startBridge(dataDir: string) {
  const child = spawn(process.execPath, ['src/mcp-bridge/bridge.cjs'], {
    env: { PATH: process.env.PATH ?? '', GESTOR_API_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const waiting = new Map<number, (result: McpResult) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const reply = JSON.parse(line)
    waiting.get(reply.id)?.(reply.result)
    waiting.delete(reply.id)
  })
  let nextId = 1
  const send = (method: string, params: unknown = {}) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise<McpResult>((resolve) => waiting.set(id, resolve))
  }
  return {
    send,
    tool: (name: string, args: Record<string, unknown>) => send('tools/call', { name, arguments: args }),
    close: () => child.stdin.end()
  }
}

/**
 * Arrastrar y soltar con eventos HTML5: el dragTo de Playwright mueve el ratón, pero en Electron
 * no llega a disparar el arrastre nativo. Se suelta en el centro del destino.
 */
async function dragAndDrop(source: Locator, target: Locator) {
  const box = await target.boundingBox()
  if (!box) throw new Error('El destino no se ve')
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  const dataTransfer = await source.page().evaluateHandle('new DataTransfer()')
  await source.dispatchEvent('dragstart', { dataTransfer })
  await target.dispatchEvent('dragenter', { dataTransfer, ...at })
  await target.dispatchEvent('dragover', { dataTransfer, ...at })
  await target.dispatchEvent('drop', { dataTransfer, ...at })
  await source.dispatchEvent('dragend', { dataTransfer })
}
const shots = env.E2E_SCREENSHOTS

describe('Gestor API (E2E)', () => {
  let app: ElectronApplication
  let page: Page
  let userData: string
  /** API de pega al estilo RPC: responde siempre 200 y dice en el cuerpo si fue bien. */
  let server: Server
  let serverUrl: string
  const received: unknown[] = []

  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = ''
      req.on('data', (c: Buffer) => (data += c.toString()))
      req.on('end', () => {
        const body = JSON.parse(data || '{}') as { access_token?: string; data?: { filters?: { hotel_id?: unknown } } }
        received.push(body)
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify(
            body.access_token === 'clave-e2e'
              ? { status: 'success', data: { list: [{ id: 1, hotel_id: body.data?.filters?.hotel_id, guest: 'Ana' }] } }
              : { status: 'error', code: 401, message: 'Token no válido' }
          )
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/apiv2`
    userData = await mkdtemp(join(tmpdir(), 'gestor-api-e2e-'))
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`, '--password-store=basic'],
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RENDERER_URL: env.E2E_RENDERER_URL ?? '' }
    })
    page = await app.firstWindow()
    await page.waitForSelector('.welcome')
  })

  afterAll(async () => {
    await app?.close()
    server?.close()
    if (userData) await rm(userData, { recursive: true, force: true })
  })

  it('arranca en la bienvenida, sin APIs', async () => {
    await expect(page.locator('.welcome h1').textContent()).resolves.toBe('Gestor API')
    await expect(page.locator('.empty-note').textContent()).resolves.toContain('Aún no hay APIs')
    await shot('01-bienvenida')
  })

  it('crea una API con token', async () => {
    await page.getByRole('button', { name: 'Nueva API' }).click()
    await page.fill('#api-name', 'Motor de reservas')
    await page.fill('#api-url', 'https://api.ejemplo.com/v1')
    await page.getByRole('tab', { name: 'Autenticación' }).click()
    await page.selectOption('#auth-type', 'bearer')
    await page.fill('#secret-token', 'token-de-prueba')
    await shot('02-nueva-api')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect(page.locator('.api-row .name').textContent()).resolves.toBe('Motor de reservas')
  })

  it('añade un endpoint y lo abre con sus parámetros y la URL montada', async () => {
    await page.locator('.api-row').hover()
    await page.getByTitle('Nuevo endpoint').click()
    await page.fill('#ep-name', 'Ver reserva')
    await page.fill('#ep-path', '/reservas/{localizador}')
    await page.fill('#ep-desc', 'Devuelve los datos de una reserva a partir de su localizador.')
    await page.locator('[aria-label="Ejemplo"]').fill('ABC123')
    await shot('03-nuevo-endpoint')
    await page.getByRole('button', { name: 'Guardar' }).click()

    await page.waitForSelector('.endpoint-view:not([hidden])')
    await expect(page.locator('.endpoint-title h1').textContent()).resolves.toBe('Ver reserva')
    await expect(page.locator('.request-url').textContent()).resolves.toContain('https://api.ejemplo.com/v1/reservas/ABC123')
    await expect(page.locator('.auth-line').textContent()).resolves.toContain('credencial guardada')

    await page.fill('#param-path-localizador', 'XYZ 9')
    await expect(page.locator('.request-url').textContent()).resolves.toContain('/reservas/XYZ%209')
    await shot('04-endpoint')
  })

  it('configura una API tipo RPC con credenciales en el cuerpo, listado de hoteles y plantilla', async () => {
    await page.getByTitle('Nueva API').click()
    await page.fill('#api-name', 'PMS de prueba')
    await page.fill('#api-url', serverUrl)
    await page.selectOption('#api-env', 'prod')

    await page.getByRole('tab', { name: 'Autenticación' }).click()
    await page.selectOption('#auth-type', 'custom')
    await page.fill('[aria-label="Valor de access_token"]', 'clave-e2e')

    await page.getByRole('tab', { name: /Variables/ }).click()
    await page.getByRole('button', { name: 'Listado' }).click()
    await page.fill('[aria-label="Nombre de la variable"]', 'hotel_id')
    await page.getByRole('button', { name: 'Pegar varias' }).click()
    await page.fill('[aria-label="Opciones pegadas"]', 'Hotel Punta Negra;100001\nHotel Cozy;100002')
    await page.getByRole('button', { name: /^Añadir 2/ }).click()
    await shot('05-variables')

    await page.getByRole('tab', { name: 'Avanzado' }).click()
    await page.getByRole('button', { name: 'Usar el ejemplo' }).click()
    await page.getByLabel(/responde siempre 200/).check()
    await shot('06-avanzado')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await page.waitForSelector('.modal-overlay', { state: 'detached' })
  })

  it('crea un endpoint con valores fijos y un dato del cuerpo que sale del listado', async () => {
    const row = page.locator('.api-row', { hasText: 'PMS de prueba' })
    await row.hover()
    await row.getByTitle('Nuevo endpoint').click()
    await page.fill('#ep-name', 'Llegadas del día')
    await page.fill('#ep-path', '')
    await page.getByRole('button', { name: '+ resource' }).click()
    await page.getByRole('button', { name: '+ task' }).click()
    const fixedValues = page.locator('[aria-label="Valor fijo"]')
    await fixedValues.nth(0).fill('frontdesk')
    await fixedValues.nth(1).fill('arrivals')

    await page.getByRole('button', { name: '+ Añadir parámetro' }).click()
    await page.fill('[aria-label="Nombre del parámetro"]', 'filters.hotel_id')
    await page.selectOption('[aria-label="Dónde va"]', 'body')
    await page.selectOption('[aria-label="Tipo"]', 'enum')
    await page.selectOption('[aria-label="De dónde salen los valores"]', 'hotel_id')
    await page.fill('[aria-label="Ejemplo"]', '{{hotel_id}}')
    await shot('07-endpoint-rpc')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await page.waitForSelector('.endpoint-view:not([hidden]) .endpoint-title h1:has-text("Llegadas del día")')
  })

  it('elige el hotel por su nombre, confirma y ve la respuesta', async () => {
    const view = page.locator('.endpoint-view:not([hidden])')
    await view.locator('select[id^="var-"]').selectOption({ label: 'Hotel Cozy' })
    await view.getByRole('button', { name: 'Ver la petición' }).click()
    await expect(view.locator('.request-details pre').textContent()).resolves.toContain('"hotel_id": "100002"')
    await expect(view.locator('.request-details pre').textContent()).resolves.toContain('••••••')

    await view.getByRole('button', { name: 'Enviar' }).click()
    await page.waitForSelector('[role="alertdialog"]')
    await expect(page.locator('[role="alertdialog"] h2').textContent()).resolves.toBe('Enviar a PRODUCCIÓN')
    await shot('08-confirmar')
    await page.getByRole('button', { name: 'Enviar a producción' }).click()

    await view.locator('.response').waitFor()
    await expect(view.locator('.verdict').textContent()).resolves.toContain('Correcta')
    await expect(view.locator('.json-tree').textContent()).resolves.toContain('Ana')
    expect(received.at(-1)).toEqual({
      resource: 'frontdesk',
      task: 'arrivals',
      data: { filters: { hotel_id: '100002' } },
      access_token: 'clave-e2e'
    })
    await page.waitForTimeout(700) // el desplazamiento hasta la respuesta es suave
    await shot('09-respuesta')
  })

  it('organiza endpoints en carpetas anidadas arrastrándolos', async () => {
    const apiRow = page.locator('.api-row', { hasText: 'PMS de prueba' })
    await apiRow.hover()
    await apiRow.getByTitle('Nueva carpeta').click()
    await page.getByLabel('Nombre de la carpeta').fill('Recepción')
    await page.getByLabel('Nombre de la carpeta').press('Enter')
    const recepcion = page.locator('.folder-row', { hasText: 'Recepción' })
    await recepcion.waitFor()

    await recepcion.hover()
    await recepcion.getByTitle('Nueva subcarpeta').click()
    await page.getByLabel('Nombre de la carpeta').fill('Llegadas')
    await page.getByLabel('Nombre de la carpeta').press('Enter')
    const llegadas = page.locator('.folder-row', { hasText: 'Llegadas' }).filter({ hasNotText: 'Recepción' })
    await llegadas.waitFor()

    await dragAndDrop(page.locator('.endpoint-row', { hasText: 'Llegadas del día' }), llegadas)
    const view = page.locator('.endpoint-view:not([hidden])')
    await expect.poll(() => view.locator('.endpoint-folder').textContent(), { timeout: 5000 }).toBe('Recepción / Llegadas')
    await expect(page.locator('.folder-row', { hasText: 'Recepción' }).locator('.meta').textContent()).resolves.toBe('1')
    await shot('10-carpetas')

    // Un endpoint nuevo desde la carpeta ya viene con ella elegida.
    await llegadas.hover()
    await llegadas.getByTitle('Nuevo endpoint aquí').click()
    await expect(page.locator('#ep-folder option:checked').textContent()).resolves.toContain('Llegadas')
    await shot('11-endpoint-en-carpeta')
    await page.getByRole('button', { name: 'Cancelar' }).click()
  })

  it('un {{date.x}} en el cuerpo saca un calendario y su valor va en la petición', async () => {
    await page.locator('.endpoint-row', { hasText: 'Llegadas del día' }).click()
    const view = page.locator('.endpoint-view:not([hidden])')
    await view.getByLabel('Cuerpo').fill('{"filters": {"hotel_id": {{hotel_id}}, "date_period": "{{date.desde}}_{{date.hasta}}", "limit": {{number.limite}}}}')
    const desde = view.locator('input[type="date"]').first()
    await desde.waitFor()
    await expect(view.locator('input[type="date"]').count()).resolves.toBe(2)
    await desde.fill('2026-11-01')
    // El número empieza vacío: falta rellenarlo y no deja enviar.
    await expect(view.locator('.request-bar .notice').textContent()).resolves.toContain('Falta rellenar: limite')
    await view.locator('input[type="number"]').fill('25')
    // La petición ya quedó a la vista en una prueba anterior de esta misma ficha.
    if (!(await view.locator('.request-details').isVisible())) await view.getByRole('button', { name: 'Ver la petición' }).click()
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const sent = await view.locator('.request-details pre').textContent()
    expect(sent).toContain(`"date_period": "2026-11-01_${iso}"`)
    expect(sent).toContain('"limit": 25')
    await shot('12-campos-con-tipo')
  })

  it('servidor MCP: se activa en Ajustes y un agente consulta y, con aprobación, lanza lo que modifica', async () => {
    await page.getByTitle('Ajustes (servidor MCP para agentes de IA)').click()
    const settings = page.getByRole('dialog', { name: 'Ajustes' })
    await settings.getByText('Parado').waitFor()
    await settings.getByLabel('Activar el servidor MCP').check()
    await settings.getByLabel('Puerto').fill(String(await freePort()))
    await settings.getByLabel('Acceso del agente a PMS de prueba').selectOption('confirm')
    await settings.getByRole('button', { name: 'Guardar' }).click()
    await settings.locator('.badge.mcp-on', { hasText: 'En marcha' }).waitFor()
    await shot('13-mcp-ajustes')
    await settings.getByRole('button', { name: 'Cerrar' }).click()
    await page.locator('.statusbar-mcp', { hasText: 'MCP activo' }).waitFor()

    const bridge = startBridge(userData)
    try {
      const init = await bridge.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
      expect(init).toMatchObject({ serverInfo: { name: 'gestor-api' } })
      const list = JSON.parse((await bridge.tool('list_apis', {})).content![0]!.text)
      expect(list.apis).toMatchObject([{ name: 'PMS de prueba', access: 'confirm', environment: 'prod' }])
      const endpoints = JSON.parse((await bridge.tool('list_endpoints', { api: 'PMS de prueba' })).content![0]!.text)
      expect(endpoints.endpoints).toMatchObject([{ name: 'Llegadas del día', folder: 'Recepción / Llegadas', modifies: true }])

      // Modifica datos: espera a que el usuario la apruebe en la app.
      const before = received.length
      const call = bridge.tool('call_endpoint', { api: 'PMS de prueba', endpoint: 'Llegadas del día', variables: { hotel_id: 'Hotel Cozy' } })
      const approval = page.getByRole('alertdialog', { name: 'Aprobar llamada del agente' })
      await approval.getByText('"hotel_id": "100002"').waitFor()
      await shot('14-mcp-aprobacion')
      await approval.getByRole('button', { name: 'Enviar' }).click()
      const ok = await call
      expect(ok.isError).toBe(false)
      expect(JSON.parse(ok.content![0]!.text)).toMatchObject({ success: true, response: { data: { list: [{ guest: 'Ana' }] } } })
      expect(received).toHaveLength(before + 1)

      const rejected = bridge.tool('call_endpoint', { api: 'PMS de prueba', endpoint: 'Llegadas del día' })
      await approval.waitFor()
      await approval.getByRole('button', { name: 'Rechazar' }).click()
      expect(await rejected).toMatchObject({ isError: true })
      expect(received).toHaveLength(before + 1)
    } finally {
      bridge.close()
    }

    await page.locator('.statusbar-mcp').click()
    await settings.locator('.mcp-activity-row', { hasText: 'call_endpoint' }).first().waitFor()
    expect(await settings.locator('.mcp-activity-row.outcome-rejected').count()).toBe(1)
    await settings.getByRole('button', { name: 'Cerrar' }).click()
  })

  it('exporta con clave, y al importar recupera una API borrada con su credencial', async () => {
    const file = join(userData, 'exportacion.json')
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
    }, file)

    await page.getByTitle('Exportar configuración…').click()
    const exporting = page.getByRole('dialog', { name: 'Exportar configuración' })
    await exporting.getByLabel('Incluir las credenciales (tokens, claves, contraseñas)').check()
    await exporting.getByLabel('Clave', { exact: true }).fill('clave-de-prueba')
    await exporting.getByLabel('Repite la clave').fill('clave-de-prueba')
    await shot('15-exportar')
    await exporting.getByRole('button', { name: 'Exportar…' }).click()
    await page.getByRole('dialog', { name: 'Configuración exportada' }).getByRole('button', { name: 'Cerrar' }).click()

    const row = page.locator('.api-row', { hasText: 'Motor de reservas' })
    await row.hover()
    await row.getByTitle('Borrar API').click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Borrar' }).click()
    await row.waitFor({ state: 'detached' })

    await page.getByTitle('Importar configuración…').click()
    const importing = page.getByRole('dialog', { name: 'Importar configuración' })
    await importing.locator('.badge', { hasText: 'Sustituye' }).waitFor()
    await importing.getByLabel('Clave', { exact: true }).fill('clave-de-prueba')
    await shot('16-importar')
    await importing.getByRole('button', { name: 'Importar 2' }).click()
    const done = page.getByRole('dialog', { name: 'Configuración importada' })
    await expect(done.locator('.notice').textContent()).resolves.toBe('Importado: 1 API nueva y 1 actualizada, con sus credenciales.')
    await done.getByRole('button', { name: 'Cerrar' }).click()

    await page.locator('.endpoint-row', { hasText: 'Ver reserva' }).click()
    await expect(page.locator('.endpoint-view:not([hidden]) .auth-line').textContent()).resolves.toContain('credencial guardada')
  })
})
