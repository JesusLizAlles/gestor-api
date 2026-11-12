// Prueba de humo de la app completa con Playwright controlando Electron.
// Requiere `npm run build`. E2E_SCREENSHOTS=/ruta guarda capturas de cada paso.
// E2E_RENDERER_URL=http://localhost:5173 usa la interfaz de `npm run dev` en vez de la compilada.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const env = process.env
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
})
