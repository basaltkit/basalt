import { describe, expect, it, vi } from 'vitest'
import { HookBus } from '@basaltkit/core'
import {
  ApiKeyConflictError,
  ApiKeyExpirationError,
  ApiKeyInputError,
  ApiKeyNotFoundError,
  ApiKeys,
  ApiKeyStoreUnsupportedError,
  API_KEY_META_LIMITS,
  MAX_API_KEY_ROTATION_GRACE_MS,
  MemoryApiKeyStore,
  type ApiKeyFilter,
  type ApiKeyInfo,
  type ApiKeyPatch,
  type ApiKeyRecord,
  type ApiKeyStore,
  type UpdateApiKeyInput,
} from '../src/index.js'
import { apiKeyStoreContract } from './helpers/apikey-store-contract.js'

/** BK-083 (c): rotation with grace, expiry changes, listing expired keys. */

apiKeyStoreContract('MemoryApiKeyStore', () => new MemoryApiKeyStore())

const HOUR = 3_600_000

function setup(store: ApiKeyStore = new MemoryApiKeyStore()) {
  const clock = { now: 1_000_000_000 }
  const hooks = new HookBus()
  const events: Array<[string, unknown]> = []
  for (const name of ['auth:apikey_rotated', 'auth:apikey_updated', 'auth:apikey_issued'] as const) {
    hooks.on(name, (payload) => {
      events.push([name, payload])
    })
  }
  const keys = new ApiKeys({ store, hooks, now: () => clock.now, touchEveryMs: 0 })
  return { keys, clock, events, store }
}

describe('ApiKeys.rotate (BK-083 c)', () => {
  it('the old secret keeps working until the grace window ends, the new one from now on', async () => {
    const { keys, clock, events } = setup()
    const { record, key: oldKey } = await keys.issue({ name: 'ci', tenantId: 't1', userId: 'u1' })
    const rotated = await keys.rotate(record.id, { graceMs: HOUR })
    expect(rotated.key).not.toBe(oldKey)
    expect(rotated.record.id).toBe(record.id)
    expect(rotated.record.prefix).toBe(rotated.key.slice(0, 14))
    expect(rotated.record.rotatedAt).toBe(clock.now)
    expect(rotated.record.previousHashExpiresAt).toBe(clock.now + HOUR)
    expect((await keys.verify(oldKey))?.id).toBe(record.id)
    expect((await keys.verify(rotated.key))?.id).toBe(record.id)
    clock.now += HOUR - 1
    expect(await keys.verify(oldKey)).not.toBeNull()
    clock.now += 1
    expect(await keys.verify(oldKey)).toBeNull()
    expect((await keys.verify(rotated.key))?.id).toBe(record.id)
    expect(events).toContainEqual([
      'auth:apikey_rotated',
      { id: record.id, tenantId: 't1', userId: 'u1', graceUntil: 1_000_000_000 + HOUR },
    ])
  })

  it('graceMs 0 (the default) kills the old secret at once', async () => {
    const { keys, events } = setup()
    const { record, key: oldKey } = await keys.issue({ name: 'ci' })
    const { key } = await keys.rotate(record.id)
    expect(await keys.verify(oldKey)).toBeNull()
    expect((await keys.verify(key))?.id).toBe(record.id)
    const rotated = events.find(([name]) => name === 'auth:apikey_rotated')![1] as Record<string, unknown>
    expect(rotated).not.toHaveProperty('graceUntil')
  })

  it('a second rotation during a grace window drops the first secret: at most two are live', async () => {
    const { keys } = setup()
    const { record, key: first } = await keys.issue({ name: 'ci' })
    const { key: second } = await keys.rotate(record.id, { graceMs: HOUR })
    const { key: third } = await keys.rotate(record.id, { graceMs: HOUR })
    expect(await keys.verify(first)).toBeNull()
    expect((await keys.verify(second))?.id).toBe(record.id)
    expect((await keys.verify(third))?.id).toBe(record.id)
  })

  it('revoking during the grace window kills both secrets', async () => {
    const { keys } = setup()
    const { record, key: oldKey } = await keys.issue({ name: 'ci' })
    const { key } = await keys.rotate(record.id, { graceMs: HOUR })
    await keys.revoke(record.id)
    expect(await keys.verify(oldKey)).toBeNull()
    expect(await keys.verify(key)).toBeNull()
  })

  it('the grace window never outlives the key itself', async () => {
    const { keys, clock } = setup()
    const { record, key: oldKey } = await keys.issue({ name: 'ci', expiresAt: clock.now + 10_000 })
    const { record: rotated, key } = await keys.rotate(record.id, { graceMs: HOUR })
    expect(rotated.previousHashExpiresAt).toBe(record.expiresAt)
    clock.now += 10_000
    expect(await keys.verify(oldKey)).toBeNull()
    expect(await keys.verify(key)).toBeNull()
  })

  it('refuses a graceMs out of range or not an integer (400)', async () => {
    const { keys } = setup()
    const { record } = await keys.issue({ name: 'ci' })
    for (const graceMs of [-1, 1.5, MAX_API_KEY_ROTATION_GRACE_MS + 1, Number.NaN]) {
      await expect(keys.rotate(record.id, { graceMs })).rejects.toBeInstanceOf(ApiKeyInputError)
    }
    await expect(keys.rotate(record.id, { graceMs: MAX_API_KEY_ROTATION_GRACE_MS })).resolves.toBeDefined()
    expect(MAX_API_KEY_ROTATION_GRACE_MS).toBe(30 * 24 * HOUR)
  })

  it('two concurrent rotations: exactly one wins, the other gets 409', async () => {
    const { keys } = setup()
    const { record } = await keys.issue({ name: 'ci' })
    const results = await Promise.allSettled([keys.rotate(record.id), keys.rotate(record.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(ApiKeyConflictError)
    expect((rejected.reason as ApiKeyConflictError).status).toBe(409)
    // The winner's key is the one that works.
    const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ key: string }>).value
    expect((await keys.verify(winner.key))?.id).toBe(record.id)
  })
})

describe('an expired or revoked key is dead for every lifecycle operation', () => {
  const operations: Array<[string, (keys: ApiKeys, id: string, now: number) => Promise<unknown>]> = [
    ['rotate', (keys, id) => keys.rotate(id)],
    ['update', (keys, id) => keys.update(id, { name: 'x' })],
    ['setExpiry', (keys, id, now) => keys.setExpiry(id, now + HOUR)],
  ]

  it.each(operations)('%s on a revoked key is 404', async (_, op) => {
    const { keys, clock } = setup()
    const { record } = await keys.issue({ name: 'ci' })
    await keys.revoke(record.id)
    await expect(op(keys, record.id, clock.now)).rejects.toBeInstanceOf(ApiKeyNotFoundError)
  })

  it.each(operations)('%s on an expired key is 404 (it cannot be resurrected)', async (_, op) => {
    const { keys, clock } = setup()
    const { record } = await keys.issue({ name: 'ci', expiresAt: clock.now + 1_000 })
    clock.now += 1_000
    await expect(op(keys, record.id, clock.now)).rejects.toBeInstanceOf(ApiKeyNotFoundError)
  })

  it.each(operations)('%s on an unknown key is 404', async (_, op) => {
    const { keys, clock } = setup()
    await expect(op(keys, 'nope', clock.now)).rejects.toBeInstanceOf(ApiKeyNotFoundError)
  })
})

describe('ApiKeys.setExpiry / update (BK-083 c)', () => {
  it('setExpiry refuses a past or non-integer time; null clears it', async () => {
    const { keys, clock } = setup()
    const { record } = await keys.issue({ name: 'ci', expiresAt: clock.now + HOUR })
    await expect(keys.setExpiry(record.id, clock.now)).rejects.toBeInstanceOf(ApiKeyExpirationError)
    await expect(keys.setExpiry(record.id, clock.now + 1.5)).rejects.toBeInstanceOf(ApiKeyExpirationError)
    expect((await keys.setExpiry(record.id, clock.now + 2 * HOUR)).expiresAt).toBe(clock.now + 2 * HOUR)
    const never = await keys.setExpiry(record.id, null)
    expect(never.expiresAt).toBeUndefined()
    clock.now += 10 * HOUR
    expect(await keys.list({})).toHaveLength(1)
  })

  it('update is ONE store write and reports changed field names, never values', async () => {
    const { keys, store, events } = setup()
    const { record } = await keys.issue({ name: 'ci', tenantId: 't1' })
    const spy = vi.spyOn(store as MemoryApiKeyStore, 'update')
    const info = await keys.update(record.id, {
      name: 'renamed',
      scopes: ['orders:read'],
      expiresAt: 2_000_000_000,
      allowedIps: ['10.0.0.0/8'],
      meta: { ticket: 'OPS-7' },
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(info).toMatchObject({
      name: 'renamed',
      scopes: ['orders:read'],
      expiresAt: 2_000_000_000,
      allowedIps: ['10.0.0.0/8'],
      meta: { ticket: 'OPS-7' },
    })
    const updated = events.find(([name]) => name === 'auth:apikey_updated')![1]
    expect(updated).toEqual({ id: record.id, tenantId: 't1', changes: ['name', 'scopes', 'expiresAt', 'allowedIps', 'meta'] })
    expect(JSON.stringify(updated)).not.toContain('OPS-7')
  })

  it('validates every field before writing anything', async () => {
    const { keys, store } = setup()
    const { record } = await keys.issue({ name: 'ci' })
    const spy = vi.spyOn(store as MemoryApiKeyStore, 'update')
    await expect(keys.update(record.id, { name: 'ok', allowedIps: ['10.0.0.5/8'] })).rejects.toBeInstanceOf(ApiKeyInputError)
    await expect(keys.update(record.id, { name: 'ok', scopes: [''] })).rejects.toBeInstanceOf(ApiKeyInputError)
    await expect(keys.update(record.id, { name: '' })).rejects.toBeInstanceOf(ApiKeyInputError)
    expect(spy).not.toHaveBeenCalled()
    expect((await keys.get(record.id))?.name).toBe('ci')
  })

  it('an empty update writes nothing and returns the key', async () => {
    const { keys, store } = setup()
    const { record } = await keys.issue({ name: 'ci' })
    const spy = vi.spyOn(store as MemoryApiKeyStore, 'update')
    expect((await keys.update(record.id, {})).id).toBe(record.id)
    expect(spy).not.toHaveBeenCalled()
  })

  it('identity fields are not part of the input type and are ignored at runtime', async () => {
    const { keys } = setup()
    const { record } = await keys.issue({ name: 'ci', tenantId: 't1', userId: 'u1' })
    // @ts-expect-error — tenantId is immutable
    const typed: UpdateApiKeyInput = { tenantId: 't2' }
    // @ts-expect-error — the store patch has no identity fields either
    const patch: ApiKeyPatch = { userId: 'u2' }
    void typed
    void patch
    const smuggled = { name: 'x', tenantId: 't2', userId: 'u2', serviceId: 's', id: 'other' } as UpdateApiKeyInput
    const info = await keys.update(record.id, smuggled)
    expect(info).toMatchObject({ id: record.id, tenantId: 't1', userId: 'u1', name: 'x' })
    expect(info.serviceId).toBeUndefined()
  })

  it('a store without update answers 501 for update, setExpiry and rotate', async () => {
    const memory = new MemoryApiKeyStore()
    const legacy: ApiKeyStore = {
      create: (r) => memory.create(r),
      findByHash: (h) => memory.findByHash(h),
      findById: (id) => memory.findById(id),
      list: (f) => memory.list(f),
      touch: (id, at) => memory.touch(id, at),
      revoke: (id, at) => memory.revoke(id, at),
    }
    const { keys } = setup(legacy)
    const { record, key } = await keys.issue({ name: 'ci' })
    for (const op of [() => keys.update(record.id, { name: 'x' }), () => keys.setExpiry(record.id, null), () => keys.rotate(record.id)]) {
      const err = await op().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiKeyStoreUnsupportedError)
      expect((err as ApiKeyStoreUnsupportedError).status).toBe(501)
      expect((err as ApiKeyStoreUnsupportedError).code).toBe('AUTH_APIKEY_STORE_UNSUPPORTED')
    }
    // Everything else keeps working.
    expect((await keys.verify(key))?.id).toBe(record.id)
  })
})

describe('ApiKeys.list (BK-083 c)', () => {
  it('lists an expired key only with includeExpired; a revoked one never', async () => {
    const { keys, clock } = setup()
    const { record: expiring } = await keys.issue({ name: 'expiring', expiresAt: clock.now + 1_000 })
    const { record: revoked } = await keys.issue({ name: 'revoked' })
    await keys.revoke(revoked.id)
    await keys.issue({ name: 'live' })
    clock.now += 1_000
    expect((await keys.list({})).map((k) => k.name)).toEqual(['live'])
    expect((await keys.list({ includeExpired: true })).map((k) => k.name).sort()).toEqual(['expiring', 'live'])
    expect((await keys.list({ includeExpired: true })).find((k) => k.id === expiring.id)?.expiresAt).toBe(clock.now)
  })

  it('never exposes a hash, current or previous', async () => {
    const { keys } = setup()
    const { record } = await keys.issue({ name: 'ci' })
    const rotated = await keys.rotate(record.id, { graceMs: HOUR })
    const views: ApiKeyInfo[] = [record, rotated.record, ...(await keys.list({})), (await keys.get(record.id))!]
    for (const view of views) {
      expect(Object.keys(view)).not.toContain('hash')
      expect(Object.keys(view)).not.toContain('previousHash')
    }
  })

  it('re-applies the filter: a store that ignores it never widens the result', async () => {
    const memory = new MemoryApiKeyStore()
    const sloppy: ApiKeyStore = {
      create: (r) => memory.create(r),
      findByHash: (h) => memory.findByHash(h),
      findById: (id) => memory.findById(id),
      // Ignores the filter entirely (and even returns revoked rows).
      list: async (_filter: ApiKeyFilter): Promise<ApiKeyRecord[]> => {
        const all: ApiKeyRecord[] = []
        for (const id of ids) {
          const r = await memory.findById(id)
          if (r) all.push(r)
        }
        return all
      },
      touch: (id, at) => memory.touch(id, at),
      revoke: (id, at) => memory.revoke(id, at),
    }
    const ids: string[] = []
    const { keys } = setup(sloppy)
    const issue = async (input: Parameters<ApiKeys['issue']>[0]) => ids.push((await keys.issue(input)).record.id)
    await issue({ name: 'a', tenantId: 't1', userId: 'u1' })
    await issue({ name: 'b', tenantId: 't1', userId: 'u2' })
    await issue({ name: 'c', tenantId: 't2', userId: 'u1' })
    await issue({ name: 'd', tenantId: 't1', serviceId: 'erp' })
    await issue({ name: 'e', tenantId: 't1', serviceId: 'erp' })
    await keys.revoke(ids[4]!)
    expect((await keys.list({ tenantId: 't1', userId: 'u1' })).map((k) => k.name)).toEqual(['a'])
    expect((await keys.list({ serviceId: 'erp' })).map((k) => k.name)).toEqual(['d'])
    expect((await keys.list({ tenantId: 't2' })).map((k) => k.name)).toEqual(['c'])
  })
})

describe('ApiKeys.issue input (BK-083 e/f)', () => {
  it('refuses userId together with serviceId, and a malformed serviceId', async () => {
    const { keys } = setup()
    await expect(keys.issue({ name: 'x', userId: 'u1', serviceId: 'erp' })).rejects.toBeInstanceOf(ApiKeyInputError)
    for (const serviceId of ['', 'has space', 'x'.repeat(129), 'tab\t']) {
      await expect(keys.issue({ name: 'x', serviceId })).rejects.toBeInstanceOf(ApiKeyInputError)
    }
    expect((await keys.issue({ name: 'x', serviceId: 'svc:erp-sync' })).record.serviceId).toBe('svc:erp-sync')
  })

  it('enforces the meta limits and refuses prototype keys', async () => {
    const { keys } = setup()
    const tooMany = Object.fromEntries(Array.from({ length: API_KEY_META_LIMITS.keys + 1 }, (_, i) => [`k${i}`, 'v']))
    const bad: unknown[] = [
      tooMany,
      { ['k'.repeat(API_KEY_META_LIMITS.keyLength + 1)]: 'v' },
      { ok: 'v'.repeat(API_KEY_META_LIMITS.valueLength + 1) },
      { 'bad key': 'v' },
      { n: 1 },
      JSON.parse('{"__proto__": "x"}'),
      { constructor: 'x' },
      { prototype: 'x' },
      ['a'],
      null,
    ]
    for (const meta of bad) {
      await expect(keys.issue({ name: 'x', meta: meta as Record<string, string> })).rejects.toBeInstanceOf(ApiKeyInputError)
    }
    const ok = await keys.issue({ name: 'x', meta: { 'owner.team': 'ops', ticket_id: 'OPS-1' } })
    expect(ok.record.meta).toEqual({ 'owner.team': 'ops', ticket_id: 'OPS-1' })
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
  })

  it('an empty allowlist or meta is stored as absent', async () => {
    const { keys } = setup()
    const { record } = await keys.issue({ name: 'x', allowedIps: [], meta: {} })
    expect(record.allowedIps).toBeUndefined()
    expect(record.meta).toBeUndefined()
  })
})
