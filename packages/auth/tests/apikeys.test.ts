import { describe, expect, it } from 'vitest'
import { createApp, ctx } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route } from '@basaltkit/fastify'
import {
  ApiKeys,
  MemoryUserSource,
  apiKeyRoutes,
  apiKeysPlugin,
  authPlugin,
  authRoutes,
  scopesSatisfy,
} from '../src/index.js'

const secret = 'test-secret-value-123456'

describe('ApiKeys service', () => {
  it('issues a key shown once, then verifies and touches it', async () => {
    const api = new ApiKeys()
    const { record, key } = await api.issue({ name: 'CI', scopes: ['read'], userId: 'u1' })
    expect(key.startsWith('mk_live_')).toBe(true)
    expect(record.prefix.startsWith('mk_live_')).toBe(true)
    expect((record as { hash?: string }).hash).toBeUndefined()
    expect(record.lastUsedAt).toBeUndefined()

    const verified = await api.verify(key)
    expect(verified?.id).toBe(record.id)
    expect(verified?.lastUsedAt).toBeTypeOf('number')
  })

  it('rejects unknown, malformed, and revoked keys', async () => {
    const api = new ApiKeys()
    expect(await api.verify('not-a-key')).toBeNull()
    expect(await api.verify('mk_live_deadbeef')).toBeNull()

    const { record, key } = await api.issue({ name: 'temp', userId: 'u1' })
    expect(await api.verify(key)).not.toBeNull()
    await api.revoke(record.id)
    expect(await api.verify(key)).toBeNull()
  })

  it('lists only active keys within the filter', async () => {
    const api = new ApiKeys()
    const a = await api.issue({ name: 'a', userId: 'u1' })
    await api.issue({ name: 'b', userId: 'u2' })
    const c = await api.issue({ name: 'c', userId: 'u1' })
    await api.revoke(c.record.id)

    const forU1 = await api.list({ userId: 'u1' })
    expect(forU1.map((k) => k.id)).toEqual([a.record.id])
  })

  it('scopesSatisfy honours wildcard and subset', () => {
    expect(scopesSatisfy(['*'], ['read', 'write'])).toBe(true)
    expect(scopesSatisfy(['read', 'write'], ['read'])).toBe(true)
    expect(scopesSatisfy(['read'], ['write'])).toBe(false)
  })
})

async function makeApp() {
  const guarded = route({
    method: 'GET',
    url: '/ping',
    meta: { scopes: ['read'] },
    handler: () => ({ ok: true, keyId: ctx().apiKey?.id }),
  })
  const app = await createApp({
    plugins: [
      authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
      apiKeysPlugin(),
      fastifyPlugin({ routes: [...authRoutes(), ...apiKeyRoutes(), guarded] }),
    ],
  }).boot()
  return { app, server: app.container.get(FASTIFY) }
}

describe('API key HTTP flow', () => {
  it('creates, uses, lists, and revokes a scoped key', async () => {
    const { app, server } = await makeApp()

    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@b.test', password: 'password123' } })
    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.test', password: 'password123' } })
    const access = login.json().accessToken as string

    // create a key (requires a logged-in user)
    const created = await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { authorization: `Bearer ${access}` },
      payload: { name: 'CI', scopes: ['read'] },
    })
    expect(created.statusCode).toBe(201)
    const { id, key } = created.json() as { id: string; key: string }
    expect(key.startsWith('mk_live_')).toBe(true)

    // guarded route: works with the key
    const ok = await server.inject({ method: 'GET', url: '/ping', headers: { authorization: `Bearer ${key}` } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().keyId).toBe(id)

    // guarded route: 403 without a key
    expect((await server.inject({ method: 'GET', url: '/ping' })).statusCode).toBe(403)

    // listing never leaks the hash or plaintext
    const list = await server.inject({ method: 'GET', url: '/apikeys', headers: { authorization: `Bearer ${access}` } })
    const rows = list.json() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!['hash']).toBeUndefined()
    expect(rows[0]!['id']).toBe(id)

    // revoke, then the key stops authorizing
    const del = await server.inject({ method: 'DELETE', url: `/apikeys/${id}`, headers: { authorization: `Bearer ${access}` } })
    expect(del.statusCode).toBe(204)
    expect((await server.inject({ method: 'GET', url: '/ping', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(403)

    await app.shutdown()
  })

  it('rejects a key that lacks the required scope', async () => {
    const { app, server } = await makeApp()
    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@b.test', password: 'password123' } })
    const access = (await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.test', password: 'password123' } })).json().accessToken

    const created = await server.inject({
      method: 'POST',
      url: '/apikeys',
      headers: { authorization: `Bearer ${access}` },
      payload: { name: 'weak', scopes: ['write'] },
    })
    const { key } = created.json() as { key: string }
    const res = await server.inject({ method: 'GET', url: '/ping', headers: { authorization: `Bearer ${key}` } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error?.code ?? res.json().code).toBe('AUTH_SCOPE_REQUIRED')

    await app.shutdown()
  })
})
