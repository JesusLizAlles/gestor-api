# Gestor API

Catálogo de escritorio para las **APIs** que usas: guarda cada API con su autenticación, explica qué hace cada
endpoint y qué datos pide, y deja probarlos rellenando un formulario. Como Postman, pero pensado para quien no
conoce los detalles de HTTP. Está hecho con Electron, TypeScript y React, con la misma base y el mismo diseño que
[Gestor BBDD](https://github.com/JesusLizAlles/gestor-bbdd).

Es un proyecto de código abierto con [licencia MIT](LICENSE).

## Qué hace ya

- **APIs** con nombre, URL base, entorno (desarrollo, pruebas, producción) y descripción.
- **Autenticación**: sin autenticación, token Bearer, usuario y contraseña (Basic), clave de API (en una cabecera
  o en la URL) y OAuth 2.0 *client credentials*. Las credenciales se cifran con el llavero del sistema
  (KWallet/libsecret, Keychain, DPAPI); sin llavero, solo se guardan en memoria. Al cambiar de tipo se borran las que
  ya no se usan.
- **Cabeceras comunes** a todas las llamadas de una API.
- **Endpoints** con método, ruta, grupo (carpeta en el panel lateral) y una explicación de qué hacen.
  - **Datos que pide**: nombre, dónde va (ruta, consulta o cabecera), tipo (texto, número, sí/no, fecha o lista de
    valores), si es obligatorio, un ejemplo y qué significa.
  - Los parámetros de ruta (`/reservas/{id}` o `/reservas/:id`) se añaden solos al escribir la ruta.
  - **Cuerpo**: JSON o formulario, con un ejemplo.
- **Ficha del endpoint**: su explicación, un campo por cada dato (con selector para listas y sí/no, calendario para
  fechas), el cuerpo editable y la URL final montada mientras se escribe, con aviso de lo obligatorio que falta.
- Panel lateral con buscador de endpoints, pestañas (<kbd>Ctrl</kbd>+<kbd>W</kbd> cierra,
  <kbd>Ctrl</kbd>+<kbd>Tab</kbd> cambia) y actualizaciones automáticas.

## Próximos pasos

- Enviar la petición y ver la respuesta (estado, tiempo, cabeceras y cuerpo con visor de JSON).
- Pedir y renovar el token OAuth 2.0.
- Importar APIs desde OpenAPI/Swagger y colecciones de Postman; exportar e importar entre equipos.
- Historial de llamadas.

## Puesta en marcha

```bash
npm install
npm run dev          # desarrollo con recarga en caliente
npm run build        # compila a out/
npm start            # ejecuta lo compilado
npm run dist:linux   # dist/gestor-api-<versión>-linux-x86_64.AppImage
npm run dist:win     # dist/gestor-api-<versión>-setup.exe (mejor en Windows o en GitHub Actions)
npm run dist:mac     # dist/gestor-api-<versión>-mac-{arm64,x64}.dmg (solo en macOS o en GitHub Actions)
npm run icons        # regenera resources/icon.png e icon.ico desde icon.svg (rsvg-convert + ImageMagick)
```

Requiere Node.js 22.12 o superior. La primera ejecución descarga el binario de Electron.

## Integración continua y versiones

El flujo `.github/workflows/ci.yml` se ejecuta en GitHub Actions:

| Cuándo | Qué hace |
| --- | --- |
| Push a `main` o pull request | Tipos, tests unitarios y E2E con pantalla virtual (`xvfb`). |
| «Run workflow» a mano (pestaña Actions) | Lo anterior y, además, el AppImage, el `.exe` y los `.dmg`. Quedan como artefactos 7 días. |
| Etiqueta `vX.Y.Z` | Lo anterior y una **Release en borrador** con los instaladores y `SHA256SUMS.txt`. |

Para sacar una versión:

```bash
npm version 0.2.0 -m "Versión %s"   # cambia package.json, hace commit y crea la etiqueta v0.2.0
git push --follow-tags
```

Cuando termine el flujo, la Release aparece en borrador en GitHub → Releases. Al publicarla, las apps instaladas la
detectan. Las actualizaciones automáticas funcionan igual que en Gestor BBDD: la app busca a los 10 segundos de
arrancar y cada 6 horas, descarga cuando se le pide y se instala al reiniciar. En macOS (sin firma Developer ID) solo
avisa y abre el `.dmg` en el navegador. El certificado propio de macOS se configura con
`scripts/crear-certificado-mac.sh` y los secretos `MAC_CERT_P12` y `MAC_CERT_PASSWORD`. Para que las apps instaladas
encuentren las versiones, el repositorio tiene que ser público.

## Arquitectura

```
┌──────────────── Proceso principal (Node) ────────────────┐      ┌──── Renderer (sandbox) ────┐
│ ipc.ts         valida cada llamada con zod               │ IPC  │ React                      │
│ store/apis.ts  apis.json: APIs y endpoints               │◀────▶│ Sin acceso a Node ni red   │
│ store/secrets  credenciales cifradas (safeStorage)       │      │ CSP: solo recursos propios │
│ updater.ts     electron-updater                          │      └────────────────────────────┘
└──────────────────────────────────────────────────────────┘
```

| Carpeta | Contenido |
| --- | --- |
| `src/shared` | Tipos, canales IPC y montaje de URLs (`url.ts`). Lo usan los dos procesos. |
| `src/main` | Proceso principal: almacenamiento, validación, IPC y actualizador. |
| `src/preload` | Puente mínimo que expone `window.api` al renderer. |
| `src/renderer` | Interfaz React. |
| `tests` | Tests unitarios (Vitest). |
| `e2e` | Prueba de humo de la app completa con Playwright. |

Las llamadas a las APIs las hará el proceso principal, no el renderer: así no hay problemas de CORS, las
credenciales no pasan nunca por la interfaz y la CSP del renderer sigue cerrada a la red.

Los datos de la app se guardan en `~/.config/Gestor API/`: `apis.json`, `secrets.json` y `window-state.json`, con
permisos 0600.

## Tests

```bash
npm test             # unitarios
npm run typecheck
E2E_SCREENSHOTS=/tmp/capturas npm run test:e2e
```

Ayuda de desarrollo: con `GESTOR_SCREENSHOT=/ruta.png npm start` la app guarda una captura y se cierra. En la app
empaquetada está desactivado.

## Seguridad

- Renderer con `sandbox`, `contextIsolation`, sin `nodeIntegration`, sin navegación externa y con CSP estricta sin CDN.
- Todo lo que llega por IPC se valida con zod: URLs solo `http`/`https`, cabeceras sin saltos de línea. El renderer
  nunca recibe credenciales descifradas, solo qué credenciales hay guardadas.
- Credenciales con `safeStorage`. En Linux, si el sistema solo ofrece `basic_text` (clave fija), no se escriben en disco.
- **Dependencias:** `npm audit` avisa de `minimatch` dentro de `electron-builder`, que solo se usa al empaquetar y no
  va en la app instalada.
