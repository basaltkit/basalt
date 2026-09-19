import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from '@basaltkit/core'
import {
  FASTIFY,
  fastifyPlugin,
  type IdempotencyRecord,
  type IdempotencyStore,
  idempotencyPlugin,
  MemoryIdempotencyStore,
  route,
} from '../src/index.js'

/** Records every key the plugin hands to the store. */
class RecordingStore implements IdempotencyStore {
  readonly keys: string[] = []
  private readonly inner = new MemoryIdempotencyStore()
  get(key: string) {
    return this.inner.get(key)
  }
  setPending(key: string) {
    this.keys.push(key)
    return this.inner.setPending(key)
  }
  complete(key: string, record: IdempotencyRecord) {
    this.inner.complete(key, record)
  }
  release(key: string) {
    this.inner.release(key)
  }
}

let issued = 0
const routes = [
  // Stand-in for an endpoint that returns a secret to its (authenticated) caller.
  route({
    method: 'POST',
    url: '/apikeys',
    body: z.object({ name: z.string() }).optional(),
    async handler({ request, reply }) {
      const who = String(request.headers['cookie'] ?? request.headers['x-api-key'] ?? '')
      if (!who) return reply.code(401).send({ error: 'unauthenticated' })
      issued += 1
      return reply.code(201).send({ key: `mk_live_secret_${issued}` })
    },
  }),
]

async function boot(options: Parameters<typeof idempotencyPlugin>[0] = {}) {
  issued = 0
  const app = await createApp({ plugins: [fastifyPlugin({ routes }), idempotencyPlugin(options)] }).boot()
  return { app, server: app.container.get(FASTIFY) }
}

describe('idempotencyPlugin security: replays never cross principals', () => {
  it('does not replay a cookie-session response to an unauthenticated caller', async () => {
    const { app, server } = await boot()
    const victim = await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { cookie: 'sid=victim-session', 'idempotency-key': 'k1' },
    })
    expect(victim.statusCode).toBe(201)

    const attacker = await server.inject({ method: 'POST', url: '/apikeys', headers: { 'idempotency-key': 'k1' } })
    expect(attacker.statusCode).toBe(401)
    expect(attacker.body).not.toContain('mk_live')
    expect(attacker.headers['idempotent-replayed']).toBeUndefined()
    await app.shutdown()
  })

  it('does not replay one cookie session response to another cookie session', async () => {
    const { app, server } = await boot()
    await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { cookie: 'sid=victim', 'idempotency-key': 'k2' },
    })
    const other = await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { cookie: 'sid=attacker', 'idempotency-key': 'k2' },
    })
    expect(other.headers['idempotent-replayed']).toBeUndefined()
    expect(JSON.parse(other.body).key).toBe('mk_live_secret_2')
    await app.shutdown()
  })

  it('does not replay an x-api-key response to a caller with a different or no API key', async () => {
    const { app, server } = await boot()
    await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { 'x-api-key': 'victim-key', 'idempotency-key': 'k3' },
    })
    const other = await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { 'x-api-key': 'attacker-key', 'idempotency-key': 'k3' },
    })
    expect(other.headers['idempotent-replayed']).toBeUndefined()
    const anon = await server.inject({ method: 'POST', url: '/apikeys', headers: { 'idempotency-key': 'k3' } })
    expect(anon.statusCode).toBe(401)
    await app.shutdown()
  })

  it('honours a custom credential header', async () => {
    const store = new RecordingStore()
    const { app, server } = await boot({ store, credentialHeaders: ['x-custom-token'] })
    await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { cookie: 'x', 'x-custom-token': 'a', 'idempotency-key': 'k4' },
    })
    await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { cookie: 'x', 'x-custom-token': 'b', 'idempotency-key': 'k4' },
    })
    expect(store.keys).toHaveLength(2)
    expect(store.keys[0]).not.toBe(store.keys[1])
    await app.shutdown()
  })

  it('scopes replays by tenant (x-tenant-id and host)', async () => {
    const { app, server } = await boot()
    const base = { cookie: 'sid=same', 'idempotency-key': 'k5' }
    await server.inject({ method: 'POST', url: '/apikeys', headers: { ...base, 'x-tenant-id': 't1' } })
    const t2 = await server.inject({ method: 'POST', url: '/apikeys', headers: { ...base, 'x-tenant-id': 't2' } })
    expect(t2.headers['idempotent-replayed']).toBeUndefined()
    const otherHost = await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { ...base, 'x-tenant-id': 't1', host: 'other.example.com' },
    })
    expect(otherHost.headers['idempotent-replayed']).toBeUndefined()
    await app.shutdown()
  })

  it('does not cache or replay anonymous requests by default', async () => {
    const store = new RecordingStore()
    const { app, server } = await boot({ store })
    await server.inject({ method: 'POST', url: '/apikeys', headers: { 'idempotency-key': 'anon-1' } })
    await server.inject({ method: 'POST', url: '/apikeys', headers: { 'idempotency-key': 'anon-1' } })
    expect(store.keys).toHaveLength(0)
    await app.shutdown()
  })

  it('caches anonymous requests only with the explicit allowAnonymous opt-in', async () => {
    const store = new RecordingStore()
    const { app, server } = await boot({ store, allowAnonymous: true })
    await server.inject({ method: 'POST', url: '/apikeys', headers: { 'idempotency-key': 'anon-2' } })
    const second = await server.inject({ method: 'POST', url: '/apikeys', headers: { 'idempotency-key': 'anon-2' } })
    expect(store.keys).toHaveLength(2)
    expect(second.headers['idempotent-replayed']).toBe('true')
    await app.shutdown()
  })
})

describe('idempotencyPlugin security: bounded key material', () => {
  it('rejects an Idempotency-Key longer than 255 characters with 400', async () => {
    const { app, server } = await boot()
    const res = await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { cookie: 'sid=a', 'idempotency-key': 'x'.repeat(256) },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error.code).toBe('IDEMPOTENCY_KEY_INVALID')
    expect(issued).toBe(0)
    await app.shutdown()
  })

  it('hands the store a fixed-size hash, never the raw key or credential', async () => {
    const store = new RecordingStore()
    const { app, server } = await boot({ store })
    await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { cookie: 'sid=secret-cookie', 'idempotency-key': 'y'.repeat(255) },
    })
    expect(store.keys).toHaveLength(1)
    expect(store.keys[0]).toMatch(/^[0-9a-f]{64}$/)
    await app.shutdown()
  })
})

describe('idempotencyPlugin security: only the reservation owner records an outcome', () => {
  it('a 409 conflict response does not overwrite the in-flight reservation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let runs = 0
    const slowRoutes = [
      route({
        method: 'POST',
        url: '/charge',
        async handler({ reply }) {
          runs += 1
          await gate
          return reply.code(201).send({ charged: runs })
        },
      }),
    ]
    const store = new MemoryIdempotencyStore()
    const app = await createApp({
      plugins: [fastifyPlugin({ routes: slowRoutes }), idempotencyPlugin({ store })],
    }).boot()
    const server = app.container.get(FASTIFY)
    const headers = { authorization: 'Bearer user-a', 'idempotency-key': 'c1' }

    const first = server.inject({ method: 'POST', url: '/charge', headers })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const conflict = await server.inject({ method: 'POST', url: '/charge', headers })
    expect(conflict.statusCode).toBe(409)

    // The original is still in flight: a retry must see a live conflict, not a
    // cached 409 that the loser wrote over the owner's reservation.
    const retry = await server.inject({ method: 'POST', url: '/charge', headers })
    expect(retry.statusCode).toBe(409)
    expect(retry.headers['idempotent-replayed']).toBeUndefined()

    release()
    expect((await first).statusCode).toBe(201)
    const after = await server.inject({ method: 'POST', url: '/charge', headers })
    expect(after.statusCode).toBe(201)
    expect(after.headers['idempotent-replayed']).toBe('true')
    expect(runs).toBe(1)
    await app.shutdown()
  })
})

describe('MemoryIdempotencyStore: bounded memory', () => {
  it('sweeps expired entries instead of retaining them forever', () => {
    let now = 0
    const store = new MemoryIdempotencyStore(1000, () => now)
    for (let i = 0; i < 2000; i++) store.setPending(`k${i}`)
    now = 5000
    store.setPending('fresh')
    expect(store.size).toBe(1)
  })

  it('caps the number of entries (maxEntries), evicting the oldest', () => {
    const store = new MemoryIdempotencyStore(60_000, () => 0, { maxEntries: 100 })
    for (let i = 0; i < 500; i++) store.setPending(`k${i}`)
    expect(store.size).toBeLessThanOrEqual(100)
    expect(store.get('k499')).toBe('pending')
    expect(store.get('k0')).toBeUndefined()
  })
})
