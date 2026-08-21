import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from '@basaltkit/core'
import {
  FASTIFY,
  fastifyPlugin,
  type IdempotencyRecord,
  type IdempotencyStore,
  idempotencyPlugin,
  route,
} from '../src/index.js'

/**
 * Simulates Redis' atomic `SET NX`: the check-and-set in `setPending` runs to
 * completion synchronously (no `await` before the Map is mutated), so only one
 * of any number of concurrent callers can win the reservation.
 */
class AtomicMockStore implements IdempotencyStore {
  private readonly map = new Map<string, IdempotencyRecord | 'pending'>()
  setPendingCalls = 0

  async get(key: string): Promise<IdempotencyRecord | 'pending' | undefined> {
    return this.map.get(key)
  }
  async setPending(key: string): Promise<boolean> {
    this.setPendingCalls += 1
    if (this.map.has(key)) return false // already reserved or completed → lose
    this.map.set(key, 'pending')
    return true
  }
  async complete(key: string, record: IdempotencyRecord): Promise<void> {
    this.map.set(key, record)
  }
  async release(key: string): Promise<void> {
    this.map.delete(key)
  }
}

let charges = 0
const routes = [
  route({
    method: 'POST',
    url: '/charge',
    body: z.object({ amount: z.number() }),
    async handler({ body, reply }) {
      charges += 1
      return reply.code(201).send({ id: charges, amount: body.amount })
    },
  }),
  route({
    method: 'POST',
    url: '/boom',
    async handler({ reply }) {
      return reply.code(500).send({ error: 'nope' })
    },
  }),
]

async function boot() {
  charges = 0
  const app = await createApp({ plugins: [fastifyPlugin({ routes }), idempotencyPlugin()] }).boot()
  return { app, server: app.container.get(FASTIFY) }
}

describe('idempotencyPlugin', () => {
  it('replays the first response for a repeated key and runs the handler once', async () => {
    const { app, server } = await boot()
    const headers = { 'idempotency-key': 'abc-123' }

    const first = await server.inject({ method: 'POST', url: '/charge', headers, payload: { amount: 10 } })
    const second = await server.inject({ method: 'POST', url: '/charge', headers, payload: { amount: 10 } })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.body).toBe(first.body) // same charge id replayed
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(charges).toBe(1) // handler executed only once
    await app.shutdown()
  })

  it('scopes keys by route — same key on another endpoint does not collide', async () => {
    const { app, server } = await boot()
    const headers = { 'idempotency-key': 'shared' }
    const a = await server.inject({ method: 'POST', url: '/charge', headers, payload: { amount: 1 } })
    const b = await server.inject({ method: 'POST', url: '/boom', headers })
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(500)
    await app.shutdown()
  })

  it('does not cache 5xx — the client can retry', async () => {
    const { app, server } = await boot()
    const headers = { 'idempotency-key': 'retry-me' }
    const first = await server.inject({ method: 'POST', url: '/boom', headers })
    const second = await server.inject({ method: 'POST', url: '/boom', headers })
    expect(first.statusCode).toBe(500)
    expect(second.statusCode).toBe(500)
    expect(second.headers['idempotent-replayed']).toBeUndefined()
    await app.shutdown()
  })

  it('ignores requests without a key', async () => {
    const { app, server } = await boot()
    await server.inject({ method: 'POST', url: '/charge', payload: { amount: 5 } })
    await server.inject({ method: 'POST', url: '/charge', payload: { amount: 5 } })
    expect(charges).toBe(2)
    await app.shutdown()
  })

  it('two concurrent first-time requests: only one wins, the loser gets 409 and the handler runs once', async () => {
    let runs = 0
    const slowRoutes = [
      route({
        method: 'POST',
        url: '/charge',
        body: z.object({ amount: z.number() }),
        async handler({ body, reply }) {
          runs += 1
          // Hold the reservation in-flight long enough for the racing request's
          // preHandler to observe 'pending' and take the conflict path.
          await new Promise((resolve) => setTimeout(resolve, 20))
          return reply.code(201).send({ id: runs, amount: body.amount })
        },
      }),
    ]
    const store = new AtomicMockStore()
    const app = await createApp({
      plugins: [fastifyPlugin({ routes: slowRoutes }), idempotencyPlugin({ store })],
    }).boot()
    const server = app.container.get(FASTIFY)
    const headers = { 'idempotency-key': 'race-1' }

    const [a, b] = await Promise.all([
      server.inject({ method: 'POST', url: '/charge', headers, payload: { amount: 10 } }),
      server.inject({ method: 'POST', url: '/charge', headers, payload: { amount: 10 } }),
    ])

    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes).toEqual([201, 409]) // exactly one winner, one conflict
    expect(runs).toBe(1) // handler executed only once — no double charge
    const conflict = a.statusCode === 409 ? a : b
    expect(JSON.parse(conflict.body).error.code).toBe('IDEMPOTENCY_CONFLICT')
    await app.shutdown()
  })

  it('replays a completed record when a repeat loses the reservation', async () => {
    charges = 0
    const store = new AtomicMockStore()
    const app = await createApp({
      plugins: [fastifyPlugin({ routes }), idempotencyPlugin({ store })],
    }).boot()
    const server = app.container.get(FASTIFY)
    const headers = { 'idempotency-key': 'replay-1' }

    const first = await server.inject({ method: 'POST', url: '/charge', headers, payload: { amount: 7 } })
    const second = await server.inject({ method: 'POST', url: '/charge', headers, payload: { amount: 7 } })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.body).toBe(first.body) // completed record replayed, not re-run
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(charges).toBe(1)
    await app.shutdown()
  })
})
