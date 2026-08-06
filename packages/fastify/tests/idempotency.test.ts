import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from '@machize/core'
import { FASTIFY, fastifyPlugin, idempotencyPlugin, route } from '../src/index.js'

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
})
