import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createApp } from '@basaltkit/core'
import type { HttpErrorReport } from '@basaltkit/http'
import { FASTIFY, fastifyPlugin, HttpError, route } from '../src/index.js'

/**
 * Failed requests must be observable on EVERY adapter, not just this one.
 *
 * What this pins down, because all three were true before:
 *   - only 5xx were reported, so a 400 the client saw left no server record;
 *   - only ONE of this adapter's two catch sites reported anything, so an error
 *     raised inside the route pipeline vanished even when it was a 500;
 *   - express and hono reported nothing whatsoever.
 *
 * The sibling suites in @basaltkit/express and @basaltkit/hono assert the same
 * behaviour, so the three cannot drift apart again.
 */

const routes = [
  route({
    method: 'POST',
    url: '/projects',
    body: z.object({ name: z.string().min(3) }),
    async handler({ body }) {
      return { name: body.name }
    },
  }),
  route({
    method: 'GET',
    url: '/boom',
    async handler() {
      throw new Error('handler exploded')
    },
  }),
  route({
    method: 'GET',
    url: '/teapot',
    async handler() {
      throw new HttpError(418, 'IM_A_TEAPOT', 'short and stout')
    },
  }),
]

async function boot(onError?: (r: HttpErrorReport) => void) {
  const app = await createApp({
    plugins: [fastifyPlugin({ routes, ...(onError ? { onError } : {}) })],
  }).boot()
  return { app, server: app.container.get(FASTIFY) }
}

describe('HTTP error reporting on Fastify', () => {
  it('reports a 500 from a throwing handler', async () => {
    const seen: HttpErrorReport[] = []
    const { app, server } = await boot((r) => void seen.push(r))

    const response = await server.inject({ method: 'GET', url: '/boom' })
    expect(response.statusCode).toBe(500)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.status).toBe(500)
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.url).toBe('/boom')
    expect((seen[0]!.error as Error).message).toBe('handler exploded')
    // The response still says nothing about the cause.
    expect(response.json().error.message).toBe('Internal server error.')

    await app.shutdown()
  })

  it('reports a 400 from body validation — the case that used to be silent', async () => {
    const seen: HttpErrorReport[] = []
    const { app, server } = await boot((r) => void seen.push(r))

    const response = await server.inject({ method: 'POST', url: '/projects', payload: { name: 'x' } })
    expect(response.statusCode).toBe(400)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.status).toBe(400)
    expect(seen[0]!.code).toBe(response.json().error.code)

    await app.shutdown()
  })

  it('reports a deliberate 4xx thrown as HttpError', async () => {
    const seen: HttpErrorReport[] = []
    const { app, server } = await boot((r) => void seen.push(r))

    expect((await server.inject({ method: 'GET', url: '/teapot' })).statusCode).toBe(418)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.status).toBe(418)
    expect(seen[0]!.code).toBe('IM_A_TEAPOT')

    await app.shutdown()
  })

  it('says nothing about a request that succeeded', async () => {
    const seen: HttpErrorReport[] = []
    const { app, server } = await boot((r) => void seen.push(r))
    expect((await server.inject({ method: 'POST', url: '/projects', payload: { name: 'fine' } })).statusCode).toBe(200)
    expect(seen).toHaveLength(0)
    await app.shutdown()
  })

  it('uses Fastify’s own logger when one is configured, keeping records structured', async () => {
    // Captured through pino's stream rather than by spying on `server.log`:
    // reports are written to `request.log`, which is a CHILD logger, so a spy on
    // the parent never sees them.
    const lines: string[] = []
    const app = await createApp({
      plugins: [
        fastifyPlugin({ routes, fastify: { logger: { stream: { write: (s: string) => void lines.push(s) } } } }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await server.inject({ method: 'GET', url: '/boom' })).statusCode).toBe(500)
      const record = lines.map((l) => JSON.parse(l)).find((r) => r.url === '/boom')
      expect(record, 'the report should reach pino').toBeDefined()
      expect(record.level).toBe(50) // pino's "error"
      // Structured fields, not an interpolated sentence — this is why the sink
      // contract is `(fields, message)`.
      expect(record.msg).toBe('[basalt:http] request failed')
      expect(record).toMatchObject({ method: 'GET', url: '/boom', status: 500, code: 'INTERNAL_ERROR' })
      // pino's `err` serialiser renders the stack we logged the 5xx for.
      expect(record.err.message).toBe('handler exploded')
      // and NOT duplicated to the console
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      await app.shutdown()
    }
  })

  it('still reports when Fastify has NO logger — the scaffolded default', async () => {
    // `logger: false` is Fastify's default, and neither create-basalt nor the
    // playground turns it on. Fastify then installs a no-op logger, so writing
    // there would discard the report and "observable by default" would hold
    // only for apps that had already configured pino.
    const app = await createApp({
      plugins: [fastifyPlugin({ routes, fastify: { logger: false } })],
    }).boot()
    const server = app.container.get(FASTIFY)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await server.inject({ method: 'GET', url: '/boom' })).statusCode).toBe(500)
      expect(spy).toHaveBeenCalled()
      // Message first for the console, detail after — the readable order.
      expect(spy.mock.calls[0]![0]).toBe('[basalt:http] request failed')
      expect(spy.mock.calls[0]![1]).toMatchObject({ method: 'GET', url: '/boom', status: 500 })
    } finally {
      spy.mockRestore()
      await app.shutdown()
    }
  })
})
