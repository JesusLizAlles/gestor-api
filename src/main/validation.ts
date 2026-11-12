import { z } from 'zod'
import { HTTP_METHODS } from '@shared/types'
import { jsonTemplateError } from '@shared/template'

// Todo lo que llega del renderer pasa por aquí: el proceso principal no se fía de la interfaz.

const text = (max: number) => z.string().max(max)
const optionalText = (max: number) => z.string().max(max).optional()

export const idSchema = z.string().min(1).max(100)

/** ¿Es una URL http(s)? Las {{variables}} cuentan como texto cualquiera: se comprueba de nuevo al enviar. */
const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value.replace(/\{\{[^}]*\}\}/g, 'x'))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Solo http y https: nada de file:, javascript: ni similares. */
const httpUrl = z.string().trim().min(1, 'La URL es obligatoria').max(2000).refine(isHttpUrl, 'Tiene que ser una URL http:// o https://')

/** Nombre de cabecera según RFC 9110 (token). */
const headerName = z.string().trim().min(1).max(200).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'Nombre de cabecera no válido')
// Sin saltos de línea: evitaría inyectar cabeceras.
const headerValue = z.string().max(8000).regex(/^[^\r\n]*$/, 'El valor no puede tener saltos de línea')

/** Nombre de variable o de campo: letras, números, _ . - (sin espacios ni llaves). */
const fieldName = (what: string) =>
  z
    .string()
    .trim()
    .min(1, `${what}: falta el nombre`)
    .max(200)
    .regex(/^[A-Za-z_][\w.-]*$/, `${what}: el nombre solo puede tener letras, números, _ . - y no puede empezar por número`)

const authFieldSchema = z
  .object({ name: z.string().trim().min(1, 'Cada campo de autenticación necesita un nombre').max(200), in: z.enum(['header', 'query', 'body']) })
  .superRefine((field, ctx) => {
    if (field.in === 'header' && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(field.name)) {
      ctx.addIssue({ code: 'custom', message: `«${field.name}» no es un nombre de cabecera válido` })
    }
  })

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('basic'), username: text(200) }),
  z.object({ type: z.literal('apiKey'), name: headerName, in: z.enum(['header', 'query']) }),
  z.object({ type: z.literal('oauth2'), tokenUrl: httpUrl, clientId: text(500), scope: optionalText(1000) }),
  z.object({
    type: z.literal('custom'),
    fields: z
      .array(authFieldSchema)
      .min(1, 'Añade al menos un campo de autenticación')
      .max(20)
      .refine((list) => new Set(list.map((f) => f.name)).size === list.length, 'Hay dos campos de autenticación con el mismo nombre')
  })
])

const variableSchema = z.object({
  name: fieldName('Variable'),
  description: optionalText(2000),
  value: text(20000),
  options: z
    .array(z.object({ label: z.string().trim().min(1, 'Cada opción del listado necesita un nombre').max(300), value: text(20000) }))
    .max(1000)
    .optional()
})

const jsonTemplate = z
  .string()
  .max(200000)
  .superRefine((value, ctx) => {
    if (value.trim() === '') return
    const error = jsonTemplateError(value)
    if (error) ctx.addIssue({ code: 'custom', message: `La plantilla de cuerpo no es JSON válido: ${error}` })
  })

export const apiInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1, 'El nombre es obligatorio').max(120),
  description: optionalText(5000),
  baseUrl: httpUrl,
  environment: z.enum(['dev', 'test', 'prod']),
  auth: authSchema,
  headers: z.array(z.object({ name: headerName, value: headerValue })).max(100),
  variables: z
    .array(variableSchema)
    .max(200)
    .refine((list) => new Set(list.map((v) => v.name)).size === list.length, 'Hay dos variables con el mismo nombre')
    .default([]),
  bodyTemplate: jsonTemplate.optional(),
  responseRule: z
    .object({ successPath: z.string().trim().min(1).max(500), successValue: text(500), messagePath: optionalText(500) })
    .optional(),
  endpointDefaults: z.object({ method: z.enum(HTTP_METHODS), path: z.string().trim().max(2000) }).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional()
})

const secretValue = z.string().max(20000).nullable().optional()
const secretKey = z.string().regex(/^(token|password|apiKey|clientSecret|field:[^\s]{1,200})$/, 'Credencial desconocida')
export const saveApiSchema = z.object({
  config: apiInputSchema,
  secrets: z.record(secretKey, secretValue).optional()
})

const paramSchema = z.object({
  name: z.string().trim().min(1, 'Cada parámetro necesita un nombre').max(200),
  in: z.enum(['path', 'query', 'header', 'body']),
  type: z.enum(['string', 'number', 'boolean', 'date', 'enum']),
  required: z.boolean(),
  description: optionalText(5000),
  example: optionalText(5000),
  options: z.array(text(500)).max(200).optional(),
  optionsFrom: optionalText(200)
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
    example: optionalText(200000),
    useTemplate: z.boolean().optional()
  }),
  vars: z
    .array(z.object({ name: fieldName('Valor fijo'), value: text(20000) }))
    .max(100)
    .default([]),
  modifies: z.boolean().optional()
})

export const setVariableSchema = z.tuple([idSchema, z.string().min(1).max(200), text(20000)])

export const sendRequestSchema = z.object({
  runId: idSchema,
  apiId: idSchema,
  endpointId: idSchema,
  values: z.record(z.string().max(300), z.string().max(200000)),
  body: z.string().max(5_000_000)
})
