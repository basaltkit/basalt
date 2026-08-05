import { describe, expect, it, vi } from 'vitest'
import {
  definePlans,
  MemorySubscriptionStore,
  MemoryWebhookStore,
  RedisWebhookStore,
  Subscriptions,
  type RedisWebhookClient,
  type SubscriptionRecord,
} from '../src/index.js'

describe('MemoryWebhookStore', () => {
  it('claims an id once and releases it', async () => {
    const store = new MemoryWebhookStore()
    expect(await store.markProcessed('evt_1')).toBe(true)
    expect(await store.markProcessed('evt_1')).toBe(false)
    await store.release('evt_1')
    expect(await store.markProcessed('evt_1')).toBe(true) // reclaimable after release
  })
})

/** Emulates Redis SET NX / DEL for the webhook store. */
function fakeRedis() {
  const store = new Map<string, string>()
  const setCalls: { key: string; ttl: number }[] = []
  const client: RedisWebhookClient = {
    async set(key, value, _ex, seconds, _nx) {
      setCalls.push({ key, ttl: seconds })
      if (store.has(key)) return null // NX: already exists
      store.set(key, value)
      return 'OK'
    },
    async del(key) {
      return store.delete(key) ? 1 : 0
    },
  }
  return { client, store, setCalls }
}

describe('RedisWebhookStore', () => {
  it('markProcessed uses SET NX with a TTL; release deletes', async () => {
    const redis = fakeRedis()
    const store = new RedisWebhookStore(redis.client, { prefix: 'wh', ttlSeconds: 3600 })

    expect(await store.markProcessed('evt_1')).toBe(true)
    expect(await store.markProcessed('evt_1')).toBe(false)
    expect(redis.setCalls[0]).toEqual({ key: 'wh:evt_1', ttl: 3600 })

    await store.release('evt_1')
    expect(await store.markProcessed('evt_1')).toBe(true)
  })
})

const plans = definePlans({ pro: { price: 29, features: {} } })

describe('Subscriptions.handleWebhook durability', () => {
  it('deduplicates through the store and survives conceptually across instances', async () => {
    // two Subscriptions sharing one webhook store = two instances, one Redis
    const shared = new MemoryWebhookStore()
    const store = new MemorySubscriptionStore()
    const a = new Subscriptions({ plans, store, webhooks: shared })
    const b = new Subscriptions({ plans, store, webhooks: shared })
    await a.subscribe('acme', 'pro')

    const event = { id: 'evt_9', type: 'payment.failed' as const, billableId: 'acme' }
    expect(await a.handleWebhook(event)).toBe(true)
    // the OTHER instance sees the same event as already processed
    expect(await b.handleWebhook(event)).toBe(false)
    expect((await store.get('acme'))?.status).toBe('past_due')
  })

  it('releases the claim when persisting fails, so a retry reprocesses', async () => {
    class FlakyStore extends MemorySubscriptionStore {
      failNext = false
      override async save(record: SubscriptionRecord): Promise<void> {
        if (this.failNext) {
          this.failNext = false
          throw new Error('db down')
        }
        return super.save(record)
      }
    }

    const store = new FlakyStore()
    const webhooks = new MemoryWebhookStore()
    const releaseSpy = vi.spyOn(webhooks, 'release')
    const subscriptions = new Subscriptions({ plans, store, webhooks })
    await subscriptions.subscribe('acme', 'pro')

    const event = { id: 'evt_x', type: 'payment.failed' as const, billableId: 'acme' }
    store.failNext = true
    await expect(subscriptions.handleWebhook(event)).rejects.toThrow('db down')
    expect(releaseSpy).toHaveBeenCalledWith('evt_x')

    // the gateway retries — now it reprocesses successfully
    expect(await subscriptions.handleWebhook(event)).toBe(true)
    expect((await store.get('acme'))?.status).toBe('past_due')
  })
})
