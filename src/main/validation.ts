import { z } from 'zod'
import { HTTP_METHODS } from '@shared/types'

// Todo lo que llega del renderer pasa por aquí: el proceso principal no se fía de la interfaz.

const text = (max: number) => z.string().max(max)
const optionalText = (max: number) => z.string().max(max).optional()

export const idSchema = z.string().min(1).max(100)

/** Solo http y https: nada de file:, javascript: ni similares. */
const httpUrl = z
  .string()
  .trim()
  .min(1, 'La URL es obligatoria')
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'Tiene que ser una URL http:// o https://')

/** Nombre de cabecera según RFC 9110 (token). */
const headerName = z.string().trim().min(1).max(200).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'Nombre de cabecera no válido')
// Sin saltos de línea: evitaría inyectar cabeceras.
const headerValue = z.string().max(8000).regex(/^[^\r\n]*$/, 'El valor no puede tener saltos de línea')

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('basic'), username: text(200) }),
  z.object({ type: z.literal('apiKey'), name: headerName, in: z.enum(['header', 'query']) }),
  z.object({ type: z.literal('oauth2'), tokenUrl: httpUrl, clientId: text(500), scope: optionalText(1000) })
])

export const apiInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1, 'El nombre es obligatorio').max(120),
  description: optionalText(5000),
  baseUrl: httpUrl,
  environment: z.enum(['dev', 'test', 'prod']),
  auth: authSchema,
  headers: z.array(z.object({ name: headerName, value: headerValue })).max(100)
})

const secretValue = z.string().max(20000).nullable().optional()
export const saveApiSchema = z.object({
  config: apiInputSchema,
  secrets: z
    .object({ token: secretValue, password: secretValue, apiKey: secretValue, clientSecret: secretValue })
    .strict()
    .optional()
})

const paramSchema = z.object({
  name: z.string().trim().min(1, 'Cada parámetro necesita un nombre').max(200),
  in: z.enum(['path', 'query', 'header']),
  type: z.enum(['string', 'number', 'boolean', 'date', 'enum']),
  required: z.boolean(),
  description: optionalText(5000),
  example: optionalText(5000),
  options: z.array(text(500)).max(200).optional()
})

export const endpointInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
  method: z.enum(HTTP_METHODS),
  path: z.string().trim().max(2000).regex(/^[^\s]*$/, 'La ruta no puede tener espacios'),
  group: optionalText(200),
  description: optionalText(20000),
  params: z.array(paramSchema).max(200),
  body: z.object({
    kind: z.enum(['none', 'json', 'form']),
    description: optionalText(5000),
    example: optionalText(200000)
  })
})
