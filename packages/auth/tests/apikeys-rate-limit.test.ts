import { afterEach, describe, expect, it } from 'vitest'
import { route, securityPlugin } from '@basaltkit/http'
import { ApiKeys, MemoryApiKeyStore, apiKeysPlugin } from '../src/index.js'
import { availableAdapters, boot, type Harness } from './helpers/adapters.js'

/**
 * BK-083 (g), end to end with the real apiKeysPlugin: `meta.rateLimit` keyed
 * by `'apiKey'` gives each verified key its own budget, and a key that fails
 * verification never becomes a bucket id.
 */

const routes = [
  route({
    method: 'GET',
    url: '/v1/orders',
    meta: { scopes: ['orders:read'], rateLimit: { limit: 1, windowMs: 60_000, key: 'apiKey' } },
    handler: () => ({ ok: true }),
  }),
  route({
    method: 'GET',
    url: '/v1/status',
    meta: { rateLimit: [{ limit: 1, windowMs: 60_000, key: 'apiKey' }] },
    handler: () => ({ ok: true }),
  }),
]

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function setup(adapter: (typeof availableAdapters)[number]) {
  const store = new MemoryApiKeyStore()
  const keys = new ApiKeys({ store })
  harness = await boot(
    adapter,
    [apiKeysPlugin({ store }), securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 }, headers: false })],
    routes,
  )
  return { keys, h: harness }
}

describe.each(availableAdapters)("%s: meta.rateLimit key 'apiKey' with apiKeysPlugin (BK-083 g)", (adapter) => {
  it('two issued keys get independent budgets', async () => {
    const { keys, h } = await setup(adapter)
    const { key: a } = await keys.issue({ name: 'erp-a', scopes: ['orders:read'] })
    const { key: b } = await keys.issue({ name: 'erp-b', scopes: ['orders:read'] })
    const get = (key: string) => h.call({ method: 'GET', url: '/v1/orders', headers: { 'x-api-key': key } }).then((r) => r.status)
    expect(await get(a)).toBe(200)
    expect(await get(a)).toBe(429)
    expect(await get(b)).toBe(200)
  })

  it('an invalid key (rejectInvalid off) is charged to the caller address, not to a bucket of its own', async () => {
    const { h } = await setup(adapter)
    const get = (key: string) => h.call({ method: 'GET', url: '/v1/status', headers: { 'x-api-key': key } }).then((r) => r.status)
    expect(await get('mk_live_deadbeefdeadbeefdeadbeefdeadbee1')).toBe(200)
    // A different made-up key from the same address shares that budget.
    expect(await get('mk_live_deadbeefdeadbeefdeadbeefdeadbee2')).toBe(429)
  })
})
