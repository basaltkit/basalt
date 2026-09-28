import { afterEach, describe, expect, it, vi } from 'vitest'
import { TenantClientPool, TenantPoolExhaustedError } from '../src/index.js'

// FA-067: the pool evicted by recency alone, so a client still serving a
// request was disconnected under it (and reconnected outside the pool, where
// nothing bounds or closes it). Only idle clients may be evicted; when none is,
// a new tenant waits and then fails — the cap is never exceeded.

type Client = { id: string; $disconnect(): Promise<void> }

const makePool = (options: { max: number; idleMs?: number; acquireTimeoutMs?: number }) => {
  const disconnected: string[] = []
  let open = 0
  let peak = 0
  const pool = new TenantClientPool<Client>({
    create: async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      peak = Math.max(peak, ++open)
      return {
        id,
        $disconnect: async () => {
          open--
          disconnected.push(id)
        },
      }
    },
    ...options,
  })
  return { pool, disconnected, peak: () => peak }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TenantClientPool never evicts a client in use (FA-067)', () => {
  it('a client handed out by get() within idleMs is not disconnected for a new tenant', async () => {
    const { pool, disconnected } = makePool({ max: 1, idleMs: 60_000, acquireTimeoutMs: 20 })
    await pool.get('a') // a request is now using 'a'
    await expect(pool.get('b')).rejects.toBeInstanceOf(TenantPoolExhaustedError)
    expect(disconnected).toEqual([])
    expect(pool.has('a')).toBe(true)
    expect(pool.size).toBe(1)
  })

  it('a leased client is never evicted, however old; releasing it frees the slot for a waiter', async () => {
    const { pool, disconnected } = makePool({ max: 1, idleMs: 0, acquireTimeoutMs: 5_000 })
    const lease = await pool.acquire('a')
    let bReady = false
    const b = pool.get('b').then((client) => {
      bReady = true
      return client
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(bReady).toBe(false) // waiting, not evicting 'a' under its lease
    expect(disconnected).toEqual([])

    lease.release()
    expect((await b).id).toBe('b')
    expect(disconnected).toEqual(['a'])
    expect(pool.size).toBe(1)
  })

  it('use() holds the lease for exactly the callback', async () => {
    const { pool, disconnected } = makePool({ max: 1, idleMs: 0, acquireTimeoutMs: 20 })
    await pool.use('a', async () => {
      await expect(pool.get('b')).rejects.toBeInstanceOf(TenantPoolExhaustedError)
    })
    await expect(pool.get('b')).resolves.toMatchObject({ id: 'b' })
    expect(disconnected).toEqual(['a'])
  })

  it('a get() client becomes evictable once idleMs has passed', async () => {
    vi.useFakeTimers()
    const disconnected: string[] = []
    const pool = new TenantClientPool<Client>({
      create: (id) => ({ id, $disconnect: async () => void disconnected.push(id) }),
      max: 1,
      idleMs: 1_000,
      acquireTimeoutMs: 5_000,
    })
    await pool.get('a')
    const b = pool.get('b')
    await vi.advanceTimersByTimeAsync(999)
    expect(disconnected).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    await expect(b).resolves.toMatchObject({ id: 'b' })
    expect(disconnected).toEqual(['a'])
  })

  it('concurrent cold tenants never open more than max clients', async () => {
    const { pool, peak } = makePool({ max: 3, idleMs: 0, acquireTimeoutMs: 5_000 })
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`)
    await Promise.all(ids.map((id) => pool.get(id)))
    expect(peak()).toBeLessThanOrEqual(3)
    expect(pool.size).toBeLessThanOrEqual(3)
  })

  it('release() is idempotent and a lease survives destroyAll()', async () => {
    const { pool, disconnected } = makePool({ max: 2 })
    const lease = await pool.acquire('a')
    lease.release()
    lease.release()
    const again = await pool.acquire('a')
    await pool.destroyAll()
    again.release() // after shutdown: a no-op, not a throw
    expect(disconnected).toEqual(['a'])
  })
})
