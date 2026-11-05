import { describe, expect, it } from 'vitest'
import type { EndpointParam } from '@shared/types'
import { buildUrl, joinUrl, pathParamNames, syncPathParams } from '@shared/url'

const query = (name: string, required = false): EndpointParam => ({ name, in: 'query', type: 'string', required })

describe('pathParamNames', () => {
  it('reconoce {nombre} y :nombre, en orden y sin repetir', () => {
    expect(pathParamNames('/hoteles/{hotel}/reservas/:id/{hotel}')).toEqual(['hotel', 'id'])
    expect(pathParamNames('/reservas')).toEqual([])
  })
})

describe('syncPathParams', () => {
  it('añade los que faltan como obligatorios y conserva los que ya estaban', () => {
    const existing: EndpointParam[] = [{ name: 'hotel', in: 'path', type: 'enum', required: false, options: ['MEN'] }, query('fecha')]
    expect(syncPathParams('/hoteles/{hotel}/reservas/{id}', existing)).toEqual([
      { name: 'hotel', in: 'path', type: 'enum', required: true, options: ['MEN'] },
      query('fecha'),
      { name: 'id', in: 'path', type: 'string', required: true }
    ])
  })
})

describe('joinUrl', () => {
  it('deja una sola barra entre la base y la ruta', () => {
    expect(joinUrl('https://api.test/v1/', '/reservas')).toBe('https://api.test/v1/reservas')
    expect(joinUrl('https://api.test/v1', 'reservas')).toBe('https://api.test/v1/reservas')
    expect(joinUrl('https://api.test/v1', '')).toBe('https://api.test/v1')
  })
})

describe('buildUrl', () => {
  const params: EndpointParam[] = [{ name: 'id', in: 'path', type: 'string', required: true }, query('desde', true), query('estado')]

  it('sustituye la ruta codificada y añade solo los filtros con valor', () => {
    const { url, missing } = buildUrl('https://api.test/v1', '/reservas/{id}', params, {
      'path:id': 'A/1 b',
      'query:desde': '2026-11-05',
      'query:estado': ''
    })
    expect(url).toBe('https://api.test/v1/reservas/A%2F1%20b?desde=2026-11-05')
    expect(missing).toEqual([])
  })

  it('indica los obligatorios que faltan y deja visible el hueco de la ruta', () => {
    const { url, missing } = buildUrl('https://api.test/v1', '/reservas/{id}', params, {})
    expect(url).toBe('https://api.test/v1/reservas/{id}')
    expect(missing).toEqual(['id', 'desde'])
  })

  it('respeta una consulta que ya venga en la URL base', () => {
    expect(buildUrl('https://api.test/v1?lang=es', '', [query('q')], { 'query:q': 'a&b' }).url).toBe('https://api.test/v1?lang=es&q=a%26b')
  })
})
