import { afterEach, describe, expect, it } from 'vitest'
import { ctx } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { ApiKeys, MemoryApiKeyStore, MemoryUserSource, apiKeysPlugin, authPlugin } from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

/**
 * BK-083 (e): a service key acts as a non-human actor. It is authorized by its
 * scopes and tenant binding only: it never becomes `ctx().user`, so identity
 * gates (`meta.auth`, RBAC) stay closed to it.
 */

const secret = 'test-secret-test-secret-test-secret'

const routes = [
  route({
    method: 'GET',
    url: '/whoami',
    meta: { scopes: ['sync'] },
    handler: () => ({ apiKey: ctx().apiKey ?? null, user: ctx().user?.id ?? null }),
  }),
  route({ method: 'GET', url: '/me', meta: { auth: true, scopes: ['sync'] }, handler: () => ({ ok: true }) }),
]

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function setup(adapter: (typeof availableAdapters)[number]) {
  const users = new MemoryUserSource()
  const store = new MemoryApiKeyStore()
  const keys = new ApiKeys({ store })
  harness = await boot(
    adapter,
    [
      authPlugin({ users, secret, hasher: fastHasher, loginThrottle: false, ipLoginThrottle: false }),
      apiKeysPlugin({ users, store }),
    ],
    routes,
  )
  return { keys, users, h: harness }
}

describe.each(availableAdapters)('%s: service keys (BK-083 e)', (adapter) => {
  it('sets ctx().apiKey.serviceId and never ctx().user', async () => {
    const { keys, h } = await setup(adapter)
    const { record, key } = await keys.issue({ name: 'erp', scopes: ['sync'], serviceId: 'erp-sync' })
    const res = await h.call({ method: 'GET', url: '/whoami', headers: { 'x-api-key': key } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ apiKey: { id: record.id, scopes: ['sync'], serviceId: 'erp-sync' }, user: null })
  })

  it('reaches a meta.scopes route, but an identity-gated one answers 401', async () => {
    const { keys, h } = await setup(adapter)
    const { key } = await keys.issue({ name: 'erp', scopes: ['sync'], serviceId: 'erp-sync' })
    expect((await h.call({ method: 'GET', url: '/whoami', headers: { 'x-api-key': key } })).status).toBe(200)
    const gated = await h.call({ method: 'GET', url: '/me', headers: { 'x-api-key': key } })
    expect(gated.status).toBe(401)
  })

  it('keeps its id and serviceId across a rotation', async () => {
    const { keys, h } = await setup(adapter)
    const { record } = await keys.issue({ name: 'erp', scopes: ['sync'], serviceId: 'erp-sync' })
    const { key } = await keys.rotate(record.id)
    const res = await h.call({ method: 'GET', url: '/whoami', headers: { 'x-api-key': key } })
    expect(res.body.apiKey).toMatchObject({ id: record.id, serviceId: 'erp-sync' })
  })

  it('a user key still resolves its user (unchanged)', async () => {
    const { keys, users, h } = await setup(adapter)
    const user = await users.create({ email: 'ana@example.com', passwordHash: 'plain:x' })
    const { key } = await keys.issue({ name: 'cli', scopes: ['sync'], userId: user.id })
    const res = await h.call({ method: 'GET', url: '/whoami', headers: { 'x-api-key': key } })
    expect(res.body.user).toBe(user.id)
    expect(res.body.apiKey.serviceId).toBeUndefined()
  })
})
