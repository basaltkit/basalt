import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from '@machize/core'
import { FASTIFY, fastifyPlugin, generateOpenApi, openapiPlugin, route, zodToJsonSchema } from '../src/index.js'

describe('zodToJsonSchema', () => {
  it('maps common Zod types', () => {
    expect(zodToJsonSchema(z.string().email())).toEqual({ type: 'string', format: 'email' })
    expect(zodToJsonSchema(z.number().int().min(1))).toEqual({ type: 'integer', minimum: 1 })
    expect(zodToJsonSchema(z.enum(['a', 'b']))).toEqual({ type: 'string', enum: ['a', 'b'] })
    expect(zodToJsonSchema(z.array(z.boolean()))).toEqual({ type: 'array', items: { type: 'boolean' } })
  })

  it('objects mark required vs optional/default', () => {
    const schema = zodToJsonSchema(z.object({ a: z.string(), b: z.string().optional(), c: z.number().default(1) }))
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['a'])
    expect(schema.properties.c.default).toBe(1)
  })
})

describe('generateOpenApi', () => {
  it('produces paths, params, body, responses and security', () => {
    const doc = generateOpenApi(
      [
        {
          method: 'POST',
          url: '/users/:id',
          params: z.object({ id: z.string() }),
          body: z.object({ name: z.string() }),
          response: { 201: z.object({ id: z.string() }) },
          meta: { auth: true },
        },
      ],
      { title: 'Test API', version: '1.0.0' },
    )
    expect(doc.openapi).toBe('3.0.3')
    // path templating
    expect(doc.paths['/users/{id}']).toBeDefined()
    const op = doc.paths['/users/{id}'].post
    expect(op.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true })
    expect(op.requestBody.content['application/json'].schema.properties.name.type).toBe('string')
    expect(op.responses['201']).toBeDefined()
    expect(op.security).toEqual([{ bearerAuth: [] }])
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer')
  })
})

describe('openapiPlugin', () => {
  it('serves a document generated from the registered routes', async () => {
    const routes = [
      route({ method: 'GET', url: '/health', async handler() { return { ok: true } } }),
      route({
        method: 'POST',
        url: '/things',
        body: z.object({ label: z.string() }),
        async handler({ body }) { return body },
      }),
    ]
    const app = await createApp({
      plugins: [fastifyPlugin({ routes }), openapiPlugin({ info: { title: 'My API', version: '2.0.0' } })],
    }).boot()
    const server = app.container.get(FASTIFY)

    const res = await server.inject({ method: 'GET', url: '/openapi.json' })
    expect(res.statusCode).toBe(200)
    const doc = JSON.parse(res.body)
    expect(doc.info).toMatchObject({ title: 'My API', version: '2.0.0' })
    expect(doc.paths['/health'].get).toBeDefined()
    expect(doc.paths['/things'].post.requestBody).toBeDefined()
    await app.shutdown()
  })
})
