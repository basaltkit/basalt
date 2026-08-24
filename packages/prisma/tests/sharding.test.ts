import { describe, it, expect } from 'vitest'
import { createApp, METADATA } from '@basaltkit/core'
import { ShardRouter, fnv1aShard, prismaPlugin } from '../src/index.js'

describe('ShardRouter', () => {
  it('maps a key to a shard deterministically', () => {
    const shards = [{ id: 0 }, { id: 1 }, { id: 2 }]
    const router = new ShardRouter({ shards })
    const first = router.for('acme')
    expect(router.for('acme')).toBe(first) // stable across calls
    expect(router.indexOf('acme')).toBe(shards.indexOf(first as { id: number }))
    expect(router.count).toBe(3)
  })

  it('is stable across two independently constructed routers', () => {
    const build = () => new ShardRouter({ shards: [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }] })
    for (const key of ['tenant-1', 'globex', 'a', 'a-very-long-tenant-identifier']) {
      expect(build().indexOf(key)).toBe(build().indexOf(key))
    }
  })

  it('spreads keys across all shards (rough balance)', () => {
    const router = new ShardRouter({ shards: [0, 1, 2, 3].map((id) => ({ id })) })
    const counts = [0, 0, 0, 0]
    for (let i = 0; i < 4000; i += 1) {
      const idx = router.indexOf(`tenant-${i}`)
      counts[idx] = (counts[idx] ?? 0) + 1
    }
    for (const c of counts) expect(c).toBeGreaterThan(4000 / 4 / 2) // each shard well-populated
  })

  it('all() exposes every shard for fan-out/migrations', () => {
    const shards = [{ id: 0 }, { id: 1 }]
    expect(new ShardRouter({ shards }).all()).toEqual(shards)
  })

  it('a custom hash is honoured', () => {
    const router = new ShardRouter({ shards: [{ id: 0 }, { id: 1 }], hash: () => 1 })
    expect(router.for('anything')).toEqual({ id: 1 })
  })

  it('rejects an empty shard set', () => {
    expect(() => new ShardRouter({ shards: [] })).toThrow(/at least one shard/)
  })

  it('fnv1aShard stays within range', () => {
    for (let i = 0; i < 100; i += 1) {
      const idx = fnv1aShard(`k${i}`, 5)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(5)
    }
  })
})

describe('prismaPlugin({ shards })', () => {
  it('routes each tenant to its shard client, bypassing the pool', async () => {
    const shards = new ShardRouter({ shards: [{ shard: 0 }, { shard: 1 }, { shard: 2 }] })
    const app = await createApp({ plugins: [prismaPlugin({ shards })] }).boot()
    const enricher = app.container
      .get(METADATA)
      .get<(info: { context: Record<string, unknown> }) => Promise<void>>('http:enrichers')[0]!

    const attach = async (id: string) => {
      const context: Record<string, unknown> = { tenant: { id } }
      await enricher({ context })
      return context['db']
    }
    // Same tenant → same shard; the resolved client is exactly the router's.
    expect(await attach('acme')).toBe(shards.for('acme'))
    expect(await attach('acme')).toBe(shards.for('acme'))
    expect(await attach('globex')).toBe(shards.for('globex'))
    await app.shutdown()
  })
})
