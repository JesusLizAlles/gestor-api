// Prueba de humo de la app completa con Playwright controlando Electron.
// Requiere `npm run build`. E2E_SCREENSHOTS=/ruta guarda capturas de cada paso.
// E2E_RENDERER_URL=http://localhost:5173 usa la interfaz de `npm run dev` en vez de la compilada.
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

  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
  }

  beforeAll(async () => {
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
})
