import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HttpServerCollector, generateOpenApi, openapiPlugin, zodToJsonSchema } from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

describe('zodToJsonSchema', () => {
  it('maps primitives, dates and enums', () => {
    expect(zodToJsonSchema(z.string().uuid())).toMatchObject({ type: 'string', format: 'uuid' })
    expect(zodToJsonSchema(z.number().int().max(10))).toEqual({ type: 'integer', maximum: 10 })
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' })
    expect(zodToJsonSchema(z.date())).toEqual({ type: 'string', format: 'date-time' })
    expect(zodToJsonSchema(z.enum(['a', 'b']))).toEqual({ type: 'string', enum: ['a', 'b'] })
  })

  it('degrades an unmapped type to {}', () => {
    expect(zodToJsonSchema(z.map(z.string(), z.string()) as never)).toEqual({})
  })
})

describe('generateOpenApi', () => {
  it('templates path params and marks query fields required or optional', () => {
    const doc = generateOpenApi(
      [
        {
          method: 'GET',
          url: '/users/:id',
          params: z.object({ id: z.string() }),
          query: z.object({ q: z.string().optional(), page: z.number() }),
        },
      ],
      { title: 'API', version: '1.0.0' },
    ) as any
    const params = doc.paths['/users/{id}'].get.parameters
    expect(params.find((p: any) => p.name === 'id')).toMatchObject({ in: 'path', required: true })
    expect(params.find((p: any) => p.name === 'q')).toMatchObject({ in: 'query', required: false })
    expect(params.find((p: any) => p.name === 'page')).toMatchObject({ in: 'query', required: true })
  })

  it('defaults to a 200 response and adds bearer security only for meta.auth routes', () => {
    const doc = generateOpenApi(
      [
        { method: 'GET', url: '/open' },
        { method: 'GET', url: '/secure', meta: { auth: true } },
      ],
      { title: 'API', version: '1.0.0' },
    ) as any
    expect(doc.paths['/open'].get.responses['200']).toBeDefined()
    expect(doc.paths['/open'].get.security).toBeUndefined()
    expect(doc.paths['/secure'].get.security).toEqual([{ bearerAuth: [] }])
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer')
  })

  it('carries summary/description/tags/operationId from meta and human status descriptions', () => {
    const doc = generateOpenApi(
      [
        {
          method: 'POST',
          url: '/clientes',
          meta: { summary: 'Create a cliente', tags: ['Cliente'], operationId: 'createCliente', description: 'Adds a client.' },
          body: z.object({ nome: z.string() }),
          response: { 201: z.object({ id: z.string() }) },
        },
        {
          method: 'DELETE',
          url: '/clientes/:id',
          params: z.object({ id: z.string() }),
          response: { 204: z.object({}) },
        },
      ],
      { title: 'API', version: '1' },
    ) as any
    const post = doc.paths['/clientes'].post
    expect(post.summary).toBe('Create a cliente')
    expect(post.description).toBe('Adds a client.')
    expect(post.tags).toEqual(['Cliente'])
    expect(post.operationId).toBe('createCliente')
    expect(post.responses['201'].description).toBe('Created')
    expect(doc.paths['/clientes/{id}'].delete.responses['204'].description).toBe('No Content')
  })

  it('emits a top-level tags[] — described groups first, then discovered ones', () => {
    const doc = generateOpenApi(
      [
        { method: 'GET', url: '/clientes', meta: { tags: ['Clientes'] } },
        { method: 'GET', url: '/faturas', meta: { tags: ['Faturas'] } }, // used but not described
      ],
      { title: 'API', version: '1' },
      [
        { name: 'Clientes', description: 'Gestão de clientes' },
        { name: 'Vazio', description: 'Descrito mas sem rotas' }, // provided even if unused
      ],
    ) as any
    expect(doc.tags).toEqual([
      { name: 'Clientes', description: 'Gestão de clientes' },
      { name: 'Vazio', description: 'Descrito mas sem rotas' },
      { name: 'Faturas' }, // discovered, name only
    ])
  })

  it('omits top-level tags[] when nothing is tagged', () => {
    const doc = generateOpenApi([{ method: 'GET', url: '/open' }], { title: 'API', version: '1' }) as any
    expect(doc.tags).toBeUndefined()
  })

  it('has no securitySchemes when no route needs auth', () => {
    const doc = generateOpenApi([{ method: 'GET', url: '/open' }], { title: 'API', version: '1' }) as any
    expect(doc.components).toBeUndefined()
  })

  it('merges multiple methods on the same path and carries the request body', () => {
    const doc = generateOpenApi(
      [
        { method: 'GET', url: '/things' },
        { method: 'POST', url: '/things', body: z.object({ label: z.string() }) },
      ],
      { title: 'API', version: '1' },
    ) as any
    expect(Object.keys(doc.paths['/things'])).toEqual(['get', 'post'])
    expect(doc.paths['/things'].post.requestBody.content['application/json'].schema.properties.label.type).toBe('string')
  })
})

describe('openapiPlugin (neutral, via collector)', () => {
  it('registers GET /openapi.json and serves the generated document', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [openapiPlugin({ info: { title: 'My API', version: '2.0.0' }, routes: [{ method: 'GET', url: '/health' }] })])

    const route = c.extraRoutes.find((r) => r.url === '/openapi.json')
    expect(route).toMatchObject({ method: 'GET' })

    const doc = (await route!.handler({ request: makeRequest(), reply: new FakeReply() })) as any
    expect(doc.info).toMatchObject({ title: 'My API', version: '2.0.0' })
    expect(doc.paths['/health']).toBeDefined()
  })

  it('honors a custom path', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [openapiPlugin({ info: { title: 'API', version: '1' }, path: '/docs.json', routes: [] })])
    expect(c.extraRoutes.some((r) => r.url === '/docs.json')).toBe(true)
  })
})
