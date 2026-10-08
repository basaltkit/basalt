/**
 * BK-084e — the framework-neutral idempotency stage, driven through
 * `runRoute()` with no adapter. Wire behaviour on the three adapters is held
 * to the shared `idempotencyParitySuite`.
 */
import { createApp } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  HttpError,
  idempotencyPlugin,
  MemoryIdempotencyStore,
  rawBody,
  RedisIdempotencyStore,
  route,
  runRoute,
  toErrorResponse,
  type IdempotencyRecord,
  type IdempotencyStore,
  type RedisIdempotencyClient,
} from '../src/index.js'
import { IdempotencyStage } from '../src/idempotency.js'
import { FakeReply, makeRequest } from './support.js'

async function bootStage(options: Parameters<typeof idempotencyPlugin>[0] = {}) {
  const app = await createApp({ plugins: [idempotencyPlugin(options)] }).boot()
  return app.container
}

/** Runs the route like an adapter does: the handler's value is sent unless it replied itself, errors become responses. */
async function call(container: Awaited<ReturnType<typeof bootStage>>, def: ReturnType<typeof route>, headers: Record<string, string>, body: unknown) {
  const reply = new FakeReply()
  try {
    const result = await runRoute(def, makeRequest({ method: 'POST', url: def.url, headers, body }), reply, { container })
    if (!reply.sent) reply.send(result)
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(error)
    reply.code(status).send(errorBody)
  }
  return reply
}

const auth = { authorization: 'Bearer u1', 'idempotency-key': 'k' }

describe('idempotency stage', () => {
  it('a custom fingerprint function binds the key to what it returns', async () => {
    let runs = 0
    const container = await bootStage({ fingerprint: ({ request }) => String(request.headers['x-order']) })
    const def = route({ method: 'POST', url: '/o', handler: () => ({ run: ++runs }) })
    const first = await call(container, def, { ...auth, 'x-order': 'A' }, {})
    const replay = await call(container, def, { ...auth, 'x-order': 'A' }, { ignored: true })
    const reused = await call(container, def, { ...auth, 'x-order': 'B' }, {})
    expect(first.payload).toEqual({ run: 1 })
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(reused.statusCode).toBe(422)
    expect(runs).toBe(1)
  })

  it('records a thrown client error and replays it; never records a thrown 5xx', async () => {
    let runs = 0
    const container = await bootStage()
    const def = route({
      method: 'POST',
      url: '/x',
      handler: () => {
        runs += 1
        throw new HttpError(409, 'ALREADY', 'Already exists.')
      },
    })
    await call(container, def, auth, {})
    const replay = await call(container, def, auth, {})
    expect(replay.statusCode).toBe(409)
    expect(JSON.parse(replay.payload as string)).toEqual({ error: { code: 'ALREADY', message: 'Already exists.' } })
    expect(runs).toBe(1)
  })

  it('a handler that sends through reply.send() is recorded with its content type', async () => {
    const container = await bootStage()
    const def = route({
      method: 'POST',
      url: '/csv',
      handler: ({ reply }) => reply.code(202).header('Content-Type', 'text/csv').send('a,b\n1,2'),
    })
    await call(container, def, auth, {})
    const replay = await call(container, def, auth, {})
    expect(replay.statusCode).toBe(202)
    expect(replay.headers['content-type']).toBe('text/csv')
    expect(replay.payload).toBe('a,b\n1,2')
  })

  it("a store that ignores fingerprints still works: a concurrent repeat is a 409, not a 422", async () => {
    const map = new Map<string, IdempotencyRecord | 'pending'>()
    const legacy: IdempotencyStore = {
      get: (key) => map.get(key),
      setPending: (key) => (map.has(key) ? false : (map.set(key, 'pending'), true)),
      complete: (key, record) => void map.set(key, record),
      release: (key) => void map.delete(key),
    }
    let unblock!: () => void
    const container = await bootStage({ store: legacy, fingerprint: 'body' })
    const def = route({
      method: 'POST',
      url: '/slow',
      body: z.object({ n: z.number() }),
      handler: () => new Promise((resolve) => (unblock = () => resolve({ ok: true }))),
    })
    const first = call(container, def, auth, { n: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    const concurrent = await call(container, def, auth, { n: 2 })
    unblock()
    await first
    expect(concurrent.statusCode).toBe(409)
    // Once completed, the record carries the fingerprint and a different body is a 422.
    expect((await call(container, def, auth, { n: 2 })).statusCode).toBe(422)
  })

  it('releases the key when the result cannot be serialised, so a retry is not stuck on 409', async () => {
    let runs = 0
    const store = new MemoryIdempotencyStore()
    const container = await bootStage({ store })
    const def = route({
      method: 'POST',
      url: '/big',
      handler: () => {
        runs += 1
        return runs === 1 ? { n: BigInt(1) } : { n: 2 }
      },
    })
    await call(container, def, auth, {}).catch(() => undefined)
    expect(store.size).toBe(0)
    const retry = await call(container, def, auth, {})
    expect(retry.statusCode).not.toBe(409)
    expect(runs).toBe(2)
  })

  it('refuses an invalid fingerprint option', () => {
    expect(() => idempotencyPlugin({ fingerprint: 'headers' as never })).toThrow(TypeError)
  })

  it('refuses a non-boolean replayAfterGuards', () => {
    expect(() => idempotencyPlugin({ replayAfterGuards: 'false' as never })).toThrow(TypeError)
    expect(() => idempotencyPlugin({ replayAfterGuards: 0 as never })).toThrow(/must be a boolean/)
  })

  it("defaults: replay after the guards, and 'request' fingerprinting", () => {
    const keyed = makeRequest({ method: 'POST', headers: { 'idempotency-key': 'k' } })
    const json = route({ method: 'POST', url: '/j', handler: () => ({}) })
    const hook = route({ method: 'POST', url: '/h', body: rawBody({ maxBytes: 64 }), handler: () => ({}) })

    const strict = new IdempotencyStage()
    expect(strict.replayAfterGuards).toBe(true)
    expect(strict.placement(json, keyed)).toBe('beforeHandler')
    expect(strict.placement(json, makeRequest({ method: 'POST' }))).toBeUndefined()

    const legacy = new IdempotencyStage({ replayAfterGuards: false })
    expect(legacy.replayAfterGuards).toBe(false)
    expect(legacy.placement(json, keyed)).toBe('beforeGuards')
    // A rawBody() route's bytes are never read before the guards have passed.
    expect(legacy.placement(hook, keyed)).toBe('beforeHandler')
    expect(new IdempotencyStage({ replayAfterGuards: false, fingerprint: 'body' }).placement(hook, keyed)).toBe('beforeHandler')
    expect(new IdempotencyStage({ replayAfterGuards: false, fingerprint: false }).placement(hook, keyed)).toBe('beforeGuards')
  })

  it("'request' binds params and query; 'body' binds the body only", async () => {
    const def = route({ method: 'POST', url: '/a/:id', handler: ({ request }) => ({ id: request.params['id'] }) })
    const send = async (container: Awaited<ReturnType<typeof bootStage>>, params: Record<string, string>, query: unknown) => {
      const reply = new FakeReply()
      try {
        const result = await runRoute(def, makeRequest({ method: 'POST', url: '/a', headers: auth, params, query, body: { n: 1 } }), reply, { container })
        if (!reply.sent) reply.send(result)
      } catch (error) {
        reply.code(toErrorResponse(error).status).send(undefined)
      }
      return reply
    }
    const strict = await bootStage()
    expect((await send(strict, { id: '1' }, { a: '1', b: '2' })).statusCode).toBe(200)
    expect((await send(strict, { id: '1' }, { b: '2', a: '1' })).headers['idempotent-replayed']).toBe('true')
    expect((await send(strict, { id: '2' }, { a: '1', b: '2' })).statusCode).toBe(422)
    expect((await send(strict, { id: '1' }, { a: '9', b: '2' })).statusCode).toBe(422)

    const bodyOnly = await bootStage({ fingerprint: 'body' })
    await send(bodyOnly, { id: '1' }, {})
    expect((await send(bodyOnly, { id: '2' }, { a: '1' })).headers['idempotent-replayed']).toBe('true')
  })

  it('a fingerprint function returning an object is canonicalized, nested fields included', async () => {
    let runs = 0
    const container = await bootStage({
      fingerprint: ({ request }) => {
        const { sentAt: _sentAt, ...rest } = (request.body ?? {}) as Record<string, unknown>
        return { params: request.params, body: rest }
      },
    })
    const def = route({ method: 'POST', url: '/cart', handler: () => ({ run: ++runs }) })
    await call(container, def, auth, { a: 1, items: [{ sku: 'x', qty: 1 }], sentAt: 1 })
    // Key order and the volatile field do not matter…
    const replay = await call(container, def, auth, { items: [{ qty: 1, sku: 'x' }], sentAt: 2, a: 1 })
    expect(replay.headers['idempotent-replayed']).toBe('true')
    // …but a nested difference does (it once collapsed to "[object Object]").
    const otherCart = await call(container, def, auth, { a: 1, items: [{ sku: 'x', qty: 2 }], sentAt: 1 })
    expect(otherCart.statusCode).toBe(422)
    expect(runs).toBe(1)
  })

  it('a fingerprint function returning a primitive is hashed by its string form, as in 2.x (bigint included)', async () => {
    let runs = 0
    const container = await bootStage({
      fingerprint: ({ request }) => BigInt((request.body as { n: number }).n),
    })
    const def = route({ method: 'POST', url: '/big', handler: () => ({ run: ++runs }) })
    expect((await call(container, def, auth, { n: 1 })).statusCode).toBe(200)
    expect((await call(container, def, auth, { n: 1 })).headers['idempotent-replayed']).toBe('true')
    expect((await call(container, def, auth, { n: 2 })).statusCode).toBe(422)
    expect(runs).toBe(1)

    // A record fingerprinted by a 2.x string-returning function still matches.
    const store = new MemoryIdempotencyStore()
    const numeric = route({ method: 'POST', url: '/num', handler: () => ({ run: ++runs }) })
    const byNumber = await bootStage({ store, fingerprint: () => 42 })
    await call(byNumber, numeric, auth, {})
    const byString = await bootStage({ store, fingerprint: () => '42' })
    expect((await call(byString, numeric, auth, {})).headers['idempotent-replayed']).toBe('true')
  })

  it('records stored without a fingerprint keep replaying after the upgrade (no flush needed)', async () => {
    let runs = 0
    const store = new MemoryIdempotencyStore()
    const def = route({ method: 'POST', url: '/legacy', handler: () => ({ run: ++runs }) })
    const before = await bootStage({ store, fingerprint: false, replayAfterGuards: false })
    await call(before, def, auth, { amount: 10 })
    const after = await bootStage({ store })
    const replay = await call(after, def, auth, { amount: 99 })
    expect(replay.statusCode).toBe(200)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(runs).toBe(1)
  })

  it('the memory store keeps the fingerprint on the reservation', () => {
    const store = new MemoryIdempotencyStore()
    expect(store.setPending('a', { fingerprint: 'f1' })).toBe(true)
    expect(store.get('a')).toEqual({ pending: true, fingerprint: 'f1' })
    expect(store.setPending('b')).toBe(true)
    expect(store.get('b')).toBe('pending')
  })
})

describe('RedisIdempotencyStore fingerprints', () => {
  function fakeRedis() {
    const data = new Map<string, string>()
    const client: RedisIdempotencyClient = {
      async get(key) {
        return data.get(key) ?? null
      },
      async set(key, value, ...args) {
        if (args.includes('NX') && data.has(key)) return null
        data.set(key, value)
        return 'OK'
      },
      async del(...keys) {
        return keys.filter((key) => data.delete(key)).length
      },
    }
    return { client, data }
  }

  it('stores a fingerprinted reservation as pending:<fp> and reads legacy bare pending', async () => {
    const { client, data } = fakeRedis()
    const store = new RedisIdempotencyStore(client)
    expect(await store.setPending('k', { fingerprint: 'abc' })).toBe(true)
    expect(data.get('basalt:idem:k')).toBe('pending:abc')
    expect(await store.get('k')).toEqual({ pending: true, fingerprint: 'abc' })
    data.set('basalt:idem:old', 'pending')
    expect(await store.get('old')).toBe('pending')
    await store.complete('k', { status: 201, body: '{}', fingerprint: 'abc' })
    expect(await store.get('k')).toEqual({ status: 201, body: '{}', fingerprint: 'abc' })
  })
})
