import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { securityPlugin, type HttpErrorReport } from '@basaltkit/http'
import { FASTIFY, fastifyPlugin, idempotencyPlugin, route } from '../src/index.js'

/**
 * Regression (FA-001): the documented route shape is a handler that RETURNS its
 * payload. The plugin used to cover only handlers that called
 * `reply.code().send()` themselves: with a returned value the adapter sent it
 * inside the async handler, Fastify sent the handler's `undefined` resolution a
 * second time while the plugin's async `onSend` hook was still running, the
 * second pass released the reservation, and every response reported a spurious
 * `ERR_HTTP_HEADERS_SENT` 500. The handler ran on every retry.
 */
const headers = { 'idempotency-key': 'k1', cookie: 'sid=1', 'content-type': 'application/json' }

async function boot(handler: Parameters<typeof route>[0]['handler']) {
  const reports: HttpErrorReport[] = []
  const routes = [route({ method: 'POST', url: '/charge', handler })]
  const app = await createApp({
    plugins: [idempotencyPlugin(), fastifyPlugin({ routes, onError: (report) => reports.push(report) })],
  }).boot()
  return { app, server: app.container.get(FASTIFY), reports }
}

describe('idempotencyPlugin with handlers that return a value', () => {
  it('runs the handler once, replays the first response and reports nothing', async () => {
    let runs = 0
    const { app, server, reports } = await boot(async () => {
      runs += 1
      return { charged: runs }
    })
    try {
      const first = await server.inject({ method: 'POST', url: '/charge', headers, payload: {} })
      const second = await server.inject({ method: 'POST', url: '/charge', headers, payload: {} })
      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(runs).toBe(1)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(second.json()).toEqual(first.json())
      expect(second.headers['content-type']).toBe(first.headers['content-type'])
      expect(reports).toEqual([])
    } finally {
      await app.shutdown()
    }
  })

  it('replays a returned value with a status set through reply.code()', async () => {
    let runs = 0
    const { app, server, reports } = await boot(async ({ reply }) => {
      runs += 1
      reply.code(201)
      return { charged: runs }
    })
    try {
      const first = await server.inject({ method: 'POST', url: '/charge', headers, payload: {} })
      const second = await server.inject({ method: 'POST', url: '/charge', headers, payload: {} })
      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(201)
      expect(runs).toBe(1)
      expect(second.body).toBe(first.body)
      expect(reports).toEqual([])
    } finally {
      await app.shutdown()
    }
  })

  it('still replays a handler that sends through reply.send() itself, without a report', async () => {
    let runs = 0
    const { app, server, reports } = await boot(async ({ reply }) => {
      runs += 1
      return reply.code(201).send({ charged: runs })
    })
    try {
      const first = await server.inject({ method: 'POST', url: '/charge', headers, payload: {} })
      const second = await server.inject({ method: 'POST', url: '/charge', headers, payload: {} })
      expect(runs).toBe(1)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(second.body).toBe(first.body)
      expect(reports).toEqual([])
    } finally {
      await app.shutdown()
    }
  })

  it('does not cache a thrown error: the retry runs the handler again', async () => {
    let runs = 0
    const { app, server, reports } = await boot(async () => {
      runs += 1
      if (runs === 1) throw new Error('transient')
      return { charged: runs }
    })
    try {
      const first = await server.inject({ method: 'POST', url: '/charge', headers, payload: {} })
      const second = await server.inject({ method: 'POST', url: '/charge', headers, payload: {} })
      expect(first.statusCode).toBe(500)
      expect(second.statusCode).toBe(200)
      expect(second.json()).toEqual({ charged: 2 })
      expect(reports).toHaveLength(1) // the genuine failure, once
    } finally {
      await app.shutdown()
    }
  })

  it('a pre-hook that answers (rate limit) stops the request even with an async onSend hook installed', async () => {
    let runs = 0
    const reports: HttpErrorReport[] = []
    const routes = [
      route({
        method: 'POST',
        url: '/charge',
        async handler() {
          runs += 1
          return { charged: runs }
        },
      }),
    ]
    const app = await createApp({
      plugins: [
        securityPlugin({ rateLimit: { limit: 1, windowMs: 60_000 } }),
        idempotencyPlugin(),
        fastifyPlugin({ routes, onError: (report) => reports.push(report) }),
      ],
    }).boot()
    try {
      const server = app.container.get(FASTIFY)
      const first = await server.inject({ method: 'POST', url: '/charge', headers: { ...headers, 'idempotency-key': 'a' }, payload: {} })
      const limited = await server.inject({ method: 'POST', url: '/charge', headers: { ...headers, 'idempotency-key': 'b' }, payload: {} })
      expect(first.statusCode).toBe(200)
      expect(limited.statusCode).toBe(429)
      expect(runs).toBe(1)
      expect(reports).toEqual([])
    } finally {
      await app.shutdown()
    }
  })
})
