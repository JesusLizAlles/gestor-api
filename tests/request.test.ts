import { describe, expect, it } from 'vitest'
import type { ApiConfig, Endpoint } from '@shared/types'
import { evaluateResponse, planRequest, SECRET_MASK, type PlanContext } from '@shared/request'
import { builtinVars, getPath, inlineDefault, inlineFields, jsonTemplateError, parseJsonTemplate, setPath, substitute, variableNames } from '@shared/template'
import { pathParamNames } from '@shared/url'

describe('plantillas', () => {
  it('sustituye las variables conocidas y apunta las que faltan', () => {
    const unresolved = new Set<string>()
    expect(substitute('{{a}}-{{ b }}-{{c}}', { a: '1', b: '2' }, unresolved)).toBe('1-2-{{c}}')
    expect([...unresolved]).toEqual(['c'])
    expect(variableNames('{{a}} {{$hoy}} {{a}}')).toEqual(['a', '$hoy'])
  })

  it('variables automáticas con fecha local', () => {
    const vars = builtinVars(new Date(2026, 0, 31, 23, 30), () => 'id-fijo')
    expect(vars.$hoy).toBe('2026-01-31')
    expect(vars.$manana).toBe('2026-02-01')
    expect(vars.$ayer).toBe('2026-01-30')
    expect(vars.$uuid).toBe('id-fijo')
  })

  it('en JSON: entre comillas es texto, sin comillas conserva el tipo e inserta objetos', () => {
    const value = parseJsonTemplate(
      '{"id": "{{hotel}}", "n": {{hotel}}, "ok": {{flag}}, "name": "Hotel {{hotel}}", "data": {{body}}, "x": "a {{b}} \\"{{c}}\\""}',
      { hotel: '100001', flag: 'true', b: 'B', c: 'C' },
      { body: { limit: 5 } }
    )
    expect(value).toEqual({ id: '100001', n: 100001, ok: true, name: 'Hotel 100001', data: { limit: 5 }, x: 'a B "C"' })
  })

  it('un texto sin comillas que no es JSON se inserta como cadena', () => {
    expect(parseJsonTemplate('{"a": {{v}}}', { v: 'hola' })).toEqual({ a: 'hola' })
  })

  it('detecta plantillas que no son JSON válido', () => {
    expect(jsonTemplateError('{"data": {{body}}}')).toBeNull()
    expect(jsonTemplateError('{"data": ')).not.toBeNull()
  })

  it('rutas con puntos', () => {
    const target: Record<string, unknown> = { filters: { a: 1 } }
    setPath(target, 'filters.hotel_id', 7)
    setPath(target, 'x.y.z', 'v')
    expect(target).toEqual({ filters: { a: 1, hotel_id: 7 }, x: { y: { z: 'v' } } })
    expect(getPath({ data: { list: [{ id: 3 }] } }, 'data.list.0.id')).toBe(3)
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined()
  })

  it('los {{huecos}} no cuentan como parámetros de ruta', () => {
    expect(pathParamNames('/{{version}}/reservas/{id}')).toEqual(['id'])
  })
})

const ctx = (secrets: PlanContext['secrets'] = {}): PlanContext => ({ builtins: builtinVars(new Date(2026, 10, 12), () => 'u'), secrets })

const endpoint = (overrides: Partial<Endpoint> = {}): Endpoint => ({
  id: 'e1',
  name: 'Llamada',
  method: 'POST',
  path: '',
  params: [],
  body: { kind: 'none' },
  vars: [],
  ...overrides
})

/** Una API al estilo RPC: misma URL, todo por POST JSON, credenciales en el cuerpo y respuesta siempre 200. */
const rpcApi: ApiConfig = {
  id: 'a1',
  name: 'PMS',
  baseUrl: 'https://pms.test/apiv2',
  environment: 'prod',
  auth: {
    type: 'custom',
    fields: [
      { name: 'access_token', in: 'body' },
      { name: 'access_token_secret', in: 'body' }
    ]
  },
  headers: [],
  variables: [{ name: 'hotel_id', value: '100002', options: [{ label: 'Punta Negra', value: '100001' }, { label: 'Cozy', value: '100002' }] }],
  bodyTemplate: '{"resource": "{{resource}}", "task": "{{task}}", "data": {{body}}}',
  responseRule: { successPath: 'status', successValue: 'success', messagePath: 'message' },
  folders: [],
  endpoints: []
}

describe('planRequest', () => {
  it('monta una llamada RPC: plantilla, valores fijos, datos del cuerpo y credenciales en el cuerpo', () => {
    const ep = endpoint({
      vars: [
        { name: 'resource', value: 'frontdesk' },
        { name: 'task', value: 'arrivals' }
      ],
      body: { kind: 'json', example: '{"limit": 100, "filters": {"hotel_id": {{hotel_id}}}}' },
      params: [
        { name: 'filters.date_period', in: 'body', type: 'string', required: false },
        { name: 'start', in: 'body', type: 'number', required: false }
      ]
    })
    const plan = planRequest(
      rpcApi,
      ep,
      { values: { 'body:filters.date_period': '{{$hoy}}_{{$hoy}}', 'body:start': '20' }, body: ep.body.example! },
      ctx({ 'field:access_token': 'T', 'field:access_token_secret': 'S' })
    )
    expect(plan.errors).toEqual([])
    expect(plan.url).toBe('https://pms.test/apiv2')
    expect(plan.headers).toEqual([{ name: 'Content-Type', value: 'application/json' }])
    expect(JSON.parse(plan.body!)).toEqual({
      resource: 'frontdesk',
      task: 'arrivals',
      data: { limit: 100, start: 20, filters: { hotel_id: 100002, date_period: '2026-11-12_2026-11-12' } },
      access_token: 'T',
      access_token_secret: 'S'
    })
  })

  it('sin cuerpo propio, la plantilla recibe un objeto vacío', () => {
    const plan = planRequest(rpcApi, endpoint({ vars: [{ name: 'resource', value: 'hotel' }, { name: 'task', value: 'get' }] }), { values: {}, body: '' }, ctx({ 'field:access_token': 'T', 'field:access_token_secret': 'S' }))
    expect(JSON.parse(plan.body!)).toMatchObject({ resource: 'hotel', task: 'get', data: {} })
  })

  it('avisa de variables sin definir, credenciales sin guardar y JSON roto', () => {
    const plan = planRequest(rpcApi, endpoint({ body: { kind: 'json' } }), { values: {}, body: '{"a": ' }, ctx())
    expect(plan.errors.some((e) => e.includes('access_token'))).toBe(true)
    expect(plan.errors.some((e) => e.includes('no es JSON válido'))).toBe(true)
    const other = planRequest(rpcApi, endpoint(), { values: {}, body: '' }, ctx({ 'field:access_token': 'T', 'field:access_token_secret': 'S' }))
    expect(other.unresolved.sort()).toEqual(['resource', 'task'])
  })

  it('REST: ruta, consulta, cabeceras, Bearer y variables en la URL', () => {
    const api: ApiConfig = {
      ...rpcApi,
      baseUrl: 'https://{{host}}/v1',
      auth: { type: 'bearer' },
      headers: [{ name: 'Accept-Language', value: '{{lang}}' }],
      variables: [
        { name: 'host', value: 'api.test' },
        { name: 'lang', value: 'es' }
      ],
      bodyTemplate: undefined
    }
    const ep = endpoint({
      method: 'GET',
      path: '/reservas/{id}',
      params: [
        { name: 'id', in: 'path', type: 'string', required: true },
        { name: 'desde', in: 'query', type: 'date', required: true },
        { name: 'X-Trace', in: 'header', type: 'string', required: false }
      ]
    })
    const plan = planRequest(api, ep, { values: { 'path:id': 'A 1', 'query:desde': '{{$hoy}}', 'header:X-Trace': 'abc' }, body: '' }, ctx({ token: SECRET_MASK }))
    expect(plan.url).toBe('https://api.test/v1/reservas/A%201?desde=2026-11-12')
    expect(plan.headers).toEqual([
      { name: 'Accept-Language', value: 'es' },
      { name: 'X-Trace', value: 'abc' },
      { name: 'Authorization', value: `Bearer ${SECRET_MASK}` }
    ])
    expect(plan.body).toBeUndefined()
    expect(plan.errors).toEqual([])
  })

  it('obligatorios del cuerpo y cabeceras sin valor; GET con cuerpo no se permite', () => {
    const api: ApiConfig = { ...rpcApi, auth: { type: 'none' }, bodyTemplate: undefined }
    const plan = planRequest(
      api,
      endpoint({ params: [{ name: 'filters.hotel_id', in: 'body', type: 'string', required: true }] }),
      { values: {}, body: '' },
      ctx()
    )
    expect(plan.missing).toEqual(['filters.hotel_id'])
    const get = planRequest(api, endpoint({ method: 'GET', body: { kind: 'json' } }), { values: {}, body: '{}' }, ctx())
    expect(get.errors[0]).toMatch(/GET no puede llevar cuerpo/)
  })

  it('formulario con clave=valor y credencial en la URL', () => {
    const api: ApiConfig = { ...rpcApi, auth: { type: 'apiKey', name: 'key', in: 'query' }, bodyTemplate: undefined, variables: [{ name: 'v', value: 'x y' }] }
    const plan = planRequest(api, endpoint({ body: { kind: 'form' } }), { values: {}, body: 'a=1\n# comentario\nb={{v}}' }, ctx({ apiKey: 'K' }))
    expect(plan.url).toBe('https://pms.test/apiv2?key=K')
    expect(plan.body).toBe('a=1&b=x+y')
    expect(plan.headers).toContainEqual({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' })
  })

  it('Basic con caracteres no ASCII', () => {
    const api: ApiConfig = { ...rpcApi, auth: { type: 'basic', username: 'josé' }, bodyTemplate: undefined }
    const plan = planRequest(api, endpoint({ method: 'GET' }), { values: {}, body: '' }, ctx({ password: 'ñ' }))
    expect(plan.headers).toContainEqual({ name: 'Authorization', value: `Basic ${Buffer.from('josé:ñ').toString('base64')}` })
  })
})

describe('campos {{tipo.nombre}}', () => {
  const api: ApiConfig = { ...rpcApi, auth: { type: 'none' }, bodyTemplate: undefined }
  const ep = endpoint({ path: '/x', body: { kind: 'json' } })
  const body = '{"start_date": "{{date.start_date}}", "end_date": "{{date.end_date}}", "limit": {{number.limit}}, "all": {{bool.all}}, "note": "{{text.note}}"}'

  it('se detectan en orden y sin repetir', () => {
    expect(inlineFields(body, '{{date.start_date}} {{hotel_id}}').map((f) => `${f.kind}:${f.name}`)).toEqual([
      'date:start_date',
      'date:end_date',
      'number:limit',
      'bool:all',
      'text:note'
    ])
    expect(inlineDefault('datetime', new Date(2026, 0, 2, 9, 5))).toBe('2026-01-02 09:05:00')
  })

  it('sus valores van al cuerpo con su tipo; los vacíos faltan (menos el texto)', () => {
    const values = { 'inline:date.start_date': '2026-11-01', 'inline:date.end_date': '2026-11-12', 'inline:number.limit': '50', 'inline:bool.all': 'true' }
    const plan = planRequest(api, ep, { values, body }, ctx())
    expect(plan.missing).toEqual([])
    expect(plan.unresolved).toEqual([])
    expect(JSON.parse(plan.body!)).toEqual({ start_date: '2026-11-01', end_date: '2026-11-12', limit: 50, all: true, note: '' })

    const empty = planRequest(api, ep, { values: {}, body }, ctx())
    expect(empty.missing).toEqual(['start_date', 'end_date', 'limit', 'all'])
    expect(empty.unresolved).toEqual([])
  })
})

describe('evaluateResponse', () => {
  const rule = rpcApi.responseRule
  it('sin regla manda el código HTTP', () => {
    expect(evaluateResponse(undefined, 204, 'No Content', '')).toEqual({ success: true })
    expect(evaluateResponse(undefined, 404, 'Not Found', '')).toEqual({ success: false, message: '404 Not Found' })
  })
  it('con regla, un 200 puede ser un error', () => {
    expect(evaluateResponse(rule, 200, 'OK', '{"status":"success","data":{}}')).toEqual({ success: true })
    expect(evaluateResponse(rule, 200, 'OK', '{"status":"error","code":12,"message":"Hotel no válido"}')).toEqual({
      success: false,
      message: 'Hotel no válido'
    })
    expect(evaluateResponse(rule, 200, 'OK', '<html>')).toMatchObject({ success: false })
  })
})
