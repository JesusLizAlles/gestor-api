# Gestor API

Catálogo de escritorio para las **APIs** que usas: guarda cada API con su autenticación, explica qué hace cada
endpoint y qué datos pide, y deja probarlos rellenando un formulario. Como Postman, pero pensado para quien no
conoce los detalles de HTTP. Está hecho con Electron, TypeScript y React, con la misma base y el mismo diseño que
[Gestor BBDD](https://github.com/JesusLizAlles/gestor-bbdd).

Es un proyecto de código abierto con [licencia MIT](LICENSE).

## Qué hace ya

Es un cliente genérico: no lleva nada específico de ninguna API, pero se configura para casi cualquiera, sea REST
clásica o del estilo «una sola URL, todo por POST JSON».

- **APIs** con nombre, URL base, entorno (desarrollo, pruebas, producción) y descripción.
- **Autenticación**: sin autenticación, token Bearer, usuario y contraseña (Basic), clave de API (en una cabecera
  o en la URL), OAuth 2.0 *client credentials* (pide y renueva el token solo) y **campos personalizados**: uno o
  varios secretos con el nombre que pida la API, en una cabecera, en la URL o dentro del cuerpo JSON
  (`access_token` y `access_token_secret`, por ejemplo). Las credenciales se cifran con el llavero del sistema
  (KWallet/libsecret, Keychain, DPAPI); sin llavero, solo se guardan en memoria. Las que dejan de usarse se borran.
- **Variables** `{{nombre}}` por API, utilizables en la URL, las cabeceras, el cuerpo y los ejemplos de los parámetros.
  Una variable puede ser un **listado** de valores con nombre (los hoteles dados de alta: «Hotel Cozy» → `100002`): en
  la ficha se elige por su nombre, sin memorizar códigos, y los parámetros pueden ofrecer ese listado. Hay variables
  automáticas: `{{$hoy}}`, `{{$ayer}}`, `{{$manana}}`, `{{$ahora}}`, `{{$timestamp}}` y `{{$uuid}}`.
- **Plantilla de cuerpo** por API para las que envuelven todas las llamadas en la misma estructura:
  `{"resource": "{{resource}}", "task": "{{task}}", "data": {{body}}}`. Sin comillas, `{{body}}` recibe el cuerpo de
  cada endpoint y las variables conservan su tipo (número, sí/no…); entre comillas, se envían como texto.
- **Regla de respuesta** para las APIs que responden siempre 200: qué campo dice si fue bien (`status = success`) y de
  dónde sale el mensaje.
- **Cabeceras comunes**, tiempo de espera y método/ruta por defecto de los endpoints nuevos.
- **Carpetas anidadas** de endpoints dentro de cada API: se crean y renombran en el propio panel (doble clic), y
  carpetas y endpoints se ordenan y cambian de carpeta arrastrándolos. Al borrar una carpeta, lo que tenía dentro sube
  un nivel. Clic derecho en una API, carpeta o endpoint para ver sus acciones.
- **Endpoints** con método, ruta, carpeta y una explicación de qué hacen.
  - **Datos que pide**: nombre, dónde va (ruta, consulta, cabecera o **cuerpo**, con puntos para anidar:
    `filters.hotel_id`), tipo (texto, número, sí/no, fecha o lista de valores), si es obligatorio, un ejemplo y qué
    significa.
  - Los parámetros de ruta (`/reservas/{id}` o `/reservas/:id`) se añaden solos al escribir la ruta.
  - **Cuerpo**: JSON o formulario, con un ejemplo.
  - **Valores fijos** (`resource = booking`, `task = get`…) que rellenan la plantilla de cuerpo.
  - **Modifica datos**: pide confirmación antes de enviar; en producción, reforzada y enseñando lo que sale.
- **Campos con tipo** escritos como hueco en el cuerpo, la ruta o una cabecera: `{{date.desde}}` saca un calendario
  (con Ayer/Hoy/Mañana), y también hay `datetime.`, `time.`, `number.`, `bool.` y `text.`. Entre comillas viajan como
  texto; sin comillas, como número o sí/no.
- **Ficha del endpoint**: su explicación, los listados de la API, un campo por cada dato, el cuerpo editable y la
  petición montada mientras se escribe (con los secretos tapados), con aviso de lo que falta.
- **Envío** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) y cancelación. La respuesta muestra código, si fue bien según la regla,
  tiempo, tamaño, cuerpo en árbol plegable o como texto, cabeceras y la petición tal como salió.
- **Exportar e importar la configuración** (iconos junto a «APIs»): las APIs elegidas con sus carpetas, endpoints y
  variables en un fichero JSON para montarlo rápido en otro equipo. Las credenciales, si se incluyen, van cifradas con
  una clave que eliges (scrypt + AES-256-GCM) y se piden al importar. Reimportar sustituye en vez de duplicar.
- **Servidor MCP para agentes de IA** (engranaje junto a «APIs»): Claude Desktop, Claude Code u otro cliente MCP buscan
  y lanzan los endpoints por su cuenta con las credenciales guardadas, que nunca ven. Herramientas: `list_apis`,
  `list_endpoints`, `describe_endpoint` y `call_endpoint` (con parámetros y campos por nombre, cuerpo propio y
  variables solo para esa llamada, p. ej. otro hotel).
  - Acceso por API: sin acceso (por defecto), solo consultas (los endpoints «modifica datos» se bloquean), cambios con
    aprobación o cambios sin preguntar. En producción los cambios siempre piden aprobación: la app enseña la petición
    (con los secretos tapados) y no la envía hasta pulsar «Enviar» (se rechaza sola a los 5 minutos).
  - Streamable HTTP solo en 127.0.0.1, token aleatorio y comprobación de Host/Origin. Actividad en Ajustes y en
    `logs/mcp.log`.
  - La app genera la extensión `.mcpb` de Claude Desktop: un puente stdio ↔ HTTP sin dependencias que lee puerto y
    token de `mcp.json` y, con la app cerrada, explica qué hacer en vez de fallar.
- Panel lateral con buscador de endpoints, pestañas (<kbd>Ctrl</kbd>+<kbd>W</kbd> cierra,
  <kbd>Ctrl</kbd>+<kbd>Tab</kbd> cambia) y actualizaciones automáticas.

## Próximos pasos

1. Endpoints de tipo **script**: JavaScript con editor de código, ejecutado aislado (sin Node ni disco) y con acceso
   solo a `request()`, las variables y los datos del formulario. Para paginar, encadenar llamadas o transformar la
   respuesta.
2. Importar desde OpenAPI/Swagger y Postman.
3. Historial de llamadas.

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
│ requests.ts    envía, cancela, OAuth, regla de respuesta │      │                            │
│ updater.ts     electron-updater                          │      └────────────────────────────┘
└──────────────────────────────────────────────────────────┘
```

| Carpeta | Contenido |
| --- | --- |
| `src/shared` | Tipos, canales IPC, montaje de URLs y peticiones, plantillas y árbol de carpetas (`folders.ts`). Lo usan los dos procesos. |
| `src/main` | Proceso principal: almacenamiento, validación, IPC y actualizador. |
| `src/preload` | Puente mínimo que expone `window.api` al renderer. |
| `src/renderer` | Interfaz React. |
| `tests` | Tests unitarios (Vitest). |
| `e2e` | Prueba de humo de la app completa con Playwright. |

Las llamadas a las APIs las hace el proceso principal (`requests.ts`, con `net.fetch` de Electron: proxy y
certificados del sistema, sin cookies), no el renderer: así no hay problemas de CORS, las credenciales no pasan nunca
por la interfaz (la petición que se le devuelve lleva los secretos tapados) y la CSP del renderer sigue cerrada a la
red. El montaje de la petición (`src/shared/request.ts`) es una función pura que comparten los dos procesos: la
interfaz la usa para la vista previa con los secretos tapados y el proceso principal para enviar.

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
