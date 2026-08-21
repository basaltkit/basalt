import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, createToken, ctx } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, HttpError, route } from '../src/index.js'

const routes = [
  route({
    method: 'POST',
    url: '/projects',
    body: z.object({ name: z.string().min(3) }),
    async handler({ body, reply }) {
      return reply.code(201).send({ id: 'p1', name: body.name })
    },
  }),
  route({
    method: 'GET',
    url: '/projects/:id',
    params: z.object({ id: z.string() }),
    query: z.object({ expand: z.coerce.boolean().default(false) }),
    async handler({ params, query }) {
      if (params.id === 'missing') {
        throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')
      }
      return { id: params.id, expand: query.expand }
    },
  }),
  route({
    method: 'GET',
    url: '/whoami',
    async handler() {
      return { requestId: ctx().requestId, viaService: await deepService() }
    },
  }),
  route({
    method: 'GET',
    url: '/boom',
    async handler() {
      throw new Error('segredo interno')
    },
  }),
]

async function deepService(): Promise<string> {
  await Promise.resolve()
  return ctx().requestId as string
}

async function bootServer() {
  const app = await createApp({ plugins: [fastifyPlugin({ routes })] }).boot()
  return { app, server: app.container.get(FASTIFY) }
}

describe('@basaltkit/fastify', () => {
  it('validates body with Zod and responds 201 with the typed handler', async () => {
    const { app, server } = await bootServer()
    const res = await server.inject({ method: 'POST', url: '/projects', payload: { name: 'Basalt' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ id: 'p1', name: 'Basalt' })
    await app.shutdown()
  })

  it('invalid body responds with a standardized 400 with issues', async () => {
    const { app, server } = await bootServer()
    const res = await server.inject({ method: 'POST', url: '/projects', payload: { name: 'ab' } })
    expect(res.statusCode).toBe(400)
    const { error } = res.json()
    expect(error.code).toBe('HTTP_VALIDATION')
    expect(error.part).toBe('body')
    expect(error.issues[0].path).toBe('name')
    await app.shutdown()
  })

  it('parses params and query with coercion and defaults', async () => {
    const { app, server } = await bootServer()
    const res = await server.inject({ method: 'GET', url: '/projects/p9?expand=true' })
    expect(res.json()).toEqual({ id: 'p9', expand: true })
    const noQuery = await server.inject({ method: 'GET', url: '/projects/p9' })
    expect(noQuery.json()).toEqual({ id: 'p9', expand: false })
    await app.shutdown()
  })

  it('HttpError becomes a response with a stable status and code', async () => {
    const { app, server } = await bootServer()
    const res = await server.inject({ method: 'GET', url: '/projects/missing' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('PROJECT_NOT_FOUND')
    await app.shutdown()
  })

  it('creates a per-request RequestContext, propagated down to deep services', async () => {
    const { app, server } = await bootServer()
    const res = await server.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-request-id': 'req-custom' },
    })
    expect(res.json()).toEqual({ requestId: 'req-custom', viaService: 'req-custom' })
    expect(res.headers['x-request-id']).toBe('req-custom')

    const generated = await server.inject({ method: 'GET', url: '/whoami' })
    expect(generated.json().requestId).toMatch(/[0-9a-f-]{36}/)
    await app.shutdown()
  })

  it('unintentional error responds 500 without leaking the internal message', async () => {
    const { app, server } = await bootServer()
    const res = await server.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error.code).toBe('INTERNAL_ERROR')
    expect(res.body).not.toContain('segredo interno')
    await app.shutdown()
  })

  it('each request gets its own DI scope in the context', async () => {
    const SEQ = createToken<{ n: number }>('seq')
    const scoped = route({
      method: 'GET',
      url: '/seq',
      async handler() {
        const scope = ctx().container!
        scope.get(SEQ).n++
        return { n: scope.get(SEQ).n }
      },
    })
    const app = await createApp({ plugins: [fastifyPlugin({ routes: [scoped] })] }).boot()
    app.container.scoped(SEQ, () => ({ n: 0 }))
    const server = app.container.get(FASTIFY)

    const first = await server.inject({ method: 'GET', url: '/seq' })
    const second = await server.inject({ method: 'GET', url: '/seq' })
    expect(first.json()).toEqual({ n: 1 })
    expect(second.json()).toEqual({ n: 1 }) // new scope → new instance
    await app.shutdown()
  })
})

describe('urlencoded body (adapter compatibility)', () => {
  it('parses application/x-www-form-urlencoded into the body', async () => {
    const formRoutes = [
      route({
        method: 'POST',
        url: '/form',
        body: z.object({ name: z.string() }),
        async handler({ body }) {
          return { got: body.name }
        },
      }),
    ]
    const app = await createApp({ plugins: [fastifyPlugin({ routes: formRoutes })] }).boot()
    const res = await app.container.get(FASTIFY).inject({
      method: 'POST',
      url: '/form',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=Ada',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ got: 'Ada' })
    await app.shutdown()
  })
})
