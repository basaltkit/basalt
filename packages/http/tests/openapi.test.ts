import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HttpServerCollector, generateOpenApi, idempotencyPlugin, openapiPlugin, zodToJsonSchema } from '../src/index.js'
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
          url: '/clients',
          meta: { summary: 'Create a client', tags: ['Cliente'], operationId: 'createCliente', description: 'Adds a client.' },
          body: z.object({ nome: z.string() }),
          response: { 201: z.object({ id: z.string() }) },
        },
        {
          method: 'DELETE',
          url: '/clients/:id',
          params: z.object({ id: z.string() }),
          response: { 204: z.object({}) },
        },
      ],
      { title: 'API', version: '1' },
    ) as any
    const post = doc.paths['/clients'].post
    expect(post.summary).toBe('Create a client')
    expect(post.description).toBe('Adds a client.')
    expect(post.tags).toEqual(['Cliente'])
    expect(post.operationId).toBe('createCliente')
    expect(post.responses['201'].description).toBe('Created')
    expect(doc.paths['/clients/{id}'].delete.responses['204'].description).toBe('No Content')
  })

  it('emits a top-level tags[] — described groups first, then discovered ones', () => {
    const doc = generateOpenApi(
      [
        { method: 'GET', url: '/clients', meta: { tags: ['Clientes'] } },
        { method: 'GET', url: '/faturas', meta: { tags: ['Faturas'] } }, // used but not described
      ],
      { title: 'API', version: '1' },
      [
        { name: 'Clientes', description: 'Gestão de clients' },
        { name: 'Vazio', description: 'Descrito mas sem routes' }, // provided even if unused
      ],
    ) as any
    expect(doc.tags).toEqual([
      { name: 'Clientes', description: 'Gestão de clients' },
      { name: 'Vazio', description: 'Descrito mas sem routes' },
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

describe('generateOpenApi — security schemes for sessions and API keys (BK-083 h)', () => {
  const routes = [
    { method: 'GET', url: '/orders', meta: { scopes: ['orders:read'] } },
    { method: 'POST', url: '/orders', meta: { scopes: ['orders:write', 'orders:read'], auth: true } },
    { method: 'GET', url: '/me', meta: { auth: true } },
    { method: 'GET', url: '/session-only', meta: { auth: true, apiKey: false } },
    { method: 'GET', url: '/public' },
  ]
  const info = { title: 'API', version: '1' }
  type Doc = { paths: Record<string, Record<string, any>>; components?: { securitySchemes: Record<string, any> } }
  const gen = (options?: Parameters<typeof generateOpenApi>[3], list: typeof routes = routes) =>
    generateOpenApi(list, info, [], options) as unknown as Doc

  it('a meta.scopes route takes the API key and lists x-required-scopes, even with meta.auth', () => {
    const doc = gen()
    expect(doc.paths['/orders']!['get'].security).toEqual([{ apiKeyAuth: [] }])
    expect(doc.paths['/orders']!['get']['x-required-scopes']).toEqual(['orders:read'])
    expect(doc.paths['/orders']!['post'].security).toEqual([{ apiKeyAuth: [] }])
    expect(doc.paths['/orders']!['post']['x-required-scopes']).toEqual(['orders:write', 'orders:read'])
  })

  it('a meta.auth route stays bearer-only by default', () => {
    const doc = gen()
    expect(doc.paths['/me']!['get'].security).toEqual([{ bearerAuth: [] }])
    expect(doc.paths['/public']!['get'].security).toBeUndefined()
  })

  it('onAuthRoutes offers the key as an alternative, except where meta.apiKey is false', () => {
    const doc = gen({ apiKey: { header: 'x-api-key', onAuthRoutes: true } })
    expect(doc.paths['/me']!['get'].security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }])
    expect(doc.paths['/session-only']!['get'].security).toEqual([{ bearerAuth: [] }])
  })

  it('declares only the schemes used, with the header and the scopes in the description', () => {
    const doc = gen({ apiKey: { header: 'X-Machine-Key' } })
    expect(Object.keys(doc.components!.securitySchemes)).toEqual(['bearerAuth', 'apiKeyAuth'])
    expect(doc.components!.securitySchemes['bearerAuth']).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    const scheme = doc.components!.securitySchemes['apiKeyAuth']
    expect(scheme).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-Machine-Key' })
    expect(scheme.description).toContain('`Authorization: Bearer <key>`')
    expect(scheme.description).toContain('Scopes used by this API: `orders:read`, `orders:write`.')

    const keysOnly = gen(undefined, [routes[0]!])
    expect(Object.keys(keysOnly.components!.securitySchemes)).toEqual(['apiKeyAuth'])
    expect(keysOnly.components!.securitySchemes['apiKeyAuth'].name).toBe('x-api-key')
  })

  it('apiKey: false hides the scheme but keeps x-required-scopes', () => {
    const doc = gen({ apiKey: false })
    expect(doc.paths['/orders']!['get'].security).toBeUndefined()
    expect(doc.paths['/orders']!['get']['x-required-scopes']).toEqual(['orders:read'])
    expect(Object.keys(doc.components!.securitySchemes)).toEqual(['bearerAuth'])
    expect(gen({ apiKey: false }, [routes[0]!]).components).toBeUndefined()
  })

  it('documents the idempotency header on the configured methods only, in its configured case', () => {
    const doc = gen({ idempotency: { header: 'X-Request-Key', methods: ['post', 'PUT'] } })
    const [param] = doc.paths['/orders']!['post'].parameters
    expect(param).toMatchObject({ name: 'X-Request-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 255 } })
    expect(param.description).toContain('idempotent-replayed')
    expect(doc.paths['/orders']!['get'].parameters).toBeUndefined()
    expect(gen({ idempotency: false }).paths['/orders']!['post'].parameters).toBeUndefined()
  })

  it('is byte-identical to the previous output when no scopes, apiKey or idempotency are in play', () => {
    const doc = generateOpenApi(
      [
        { method: 'GET', url: '/users/:id', params: z.object({ id: z.string() }), meta: { auth: true, tags: ['Users'] } },
        { method: 'POST', url: '/users', body: z.object({ name: z.string() }), meta: { summary: 'Create' } },
        { method: 'GET', url: '/health' },
      ],
      info,
    )
    expect(JSON.stringify(doc)).toMatchInlineSnapshot(`"{"openapi":"3.0.3","info":{"title":"API","version":"1"},"tags":[{"name":"Users"}],"paths":{"/users/{id}":{"get":{"responses":{"200":{"description":"OK"}},"tags":["Users"],"parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"security":[{"bearerAuth":[]}]}},"/users":{"post":{"responses":{"200":{"description":"OK"}},"summary":"Create","requestBody":{"required":true,"content":{"application/json":{"schema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}}}}},"/health":{"get":{"responses":{"200":{"description":"OK"}}}}},"components":{"securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer","bearerFormat":"JWT"}}}}"`)
  })
})

describe('openapiPlugin — API keys and idempotency', () => {
  const served = async (plugins: Parameters<typeof bootWith>[1]) => {
    const c = new HttpServerCollector()
    await bootWith(c, plugins)
    const route = c.extraRoutes.find((r) => r.url === '/openapi.json')!
    return (await route.handler({ request: makeRequest(), reply: new FakeReply() })) as any
  }
  const routes = [{ method: 'POST', url: '/orders', meta: { scopes: ['orders:write'] } }]

  it('documents the Idempotency-Key header idempotencyPlugin enforces, unless idempotency: false', async () => {
    const doc = await served([idempotencyPlugin({ methods: ['post'] }), openapiPlugin({ info: { title: 'A', version: '1' }, routes })])
    expect(doc.paths['/orders'].post.parameters[0].name).toBe('Idempotency-Key')
    const custom = await served([idempotencyPlugin({ header: 'X-Idem' }), openapiPlugin({ info: { title: 'A', version: '1' }, routes })])
    expect(custom.paths['/orders'].post.parameters[0].name).toBe('X-Idem')
    const off = await served([idempotencyPlugin(), openapiPlugin({ info: { title: 'A', version: '1' }, routes, idempotency: false })])
    expect(off.paths['/orders'].post.parameters).toBeUndefined()
  })

  it('passes the apiKey option through', async () => {
    const doc = await served([openapiPlugin({ info: { title: 'A', version: '1' }, routes, apiKey: { header: 'x-machine-key' } })])
    expect(doc.components.securitySchemes.apiKeyAuth.name).toBe('x-machine-key')
  })
})
