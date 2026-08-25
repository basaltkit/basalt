import { describe, expect, it } from 'vitest'
import {
  MemoryApiKeyStore,
  MemoryAuthTokenStore,
  MemoryMfaStore,
  MemoryRefreshTokenStore,
  MemorySessionStore,
  MemoryTokenVersionStore,
  MemoryUserSource,
  type ApiKeyRecord,
  type AuthTokenRecord,
  type MfaRecord,
  type RefreshRecord,
} from '../src/index.js'

describe('MemoryUserSource', () => {
  it('findByEmail returns the match and null when absent', async () => {
    const src = new MemoryUserSource()
    const u = await src.create({ email: 'a@x.com', passwordHash: 'h' })
    expect((await src.findByEmail('a@x.com'))?.id).toBe(u.id)
    expect(await src.findByEmail('missing@x.com')).toBeNull()
  })

  it('findById returns the match and null when absent', async () => {
    const src = new MemoryUserSource()
    const u = await src.create({ email: 'a@x.com', passwordHash: 'h' })
    expect((await src.findById(u.id))?.email).toBe('a@x.com')
    expect(await src.findById('nope')).toBeNull()
  })

  it('update patches an existing user and returns null for an unknown id', async () => {
    const src = new MemoryUserSource()
    const u = await src.create({ email: 'a@x.com', passwordHash: 'h' })
    const patched = await src.update(u.id, { emailVerified: true, passwordHash: 'h2' })
    expect(patched?.emailVerified).toBe(true)
    expect(patched?.passwordHash).toBe('h2')
    expect(await src.update('unknown', { emailVerified: true })).toBeNull()
  })
})

describe('MemoryAuthTokenStore', () => {
  const rec = (over: Partial<AuthTokenRecord> = {}): AuthTokenRecord => ({
    token: 't1',
    userId: 'u1',
    purpose: 'verify_email',
    expiresAt: Date.now() + 60_000,
    ...over,
  })

  it('find returns the record and null when absent', async () => {
    const store = new MemoryAuthTokenStore()
    await store.create(rec())
    expect((await store.find('t1'))?.userId).toBe('u1')
    expect(await store.find('missing')).toBeNull()
  })

  it('markUsed sets usedAt for a known token and is a no-op for an unknown one', async () => {
    const store = new MemoryAuthTokenStore()
    await store.create(rec())
    await store.markUsed('t1')
    expect((await store.find('t1'))?.usedAt).toBeTypeOf('number')
    await expect(store.markUsed('missing')).resolves.toBeUndefined()
  })

  it('deleteForUser removes only the matching user+purpose, keeping others', async () => {
    const store = new MemoryAuthTokenStore()
    await store.create(rec({ token: 'a', userId: 'u1', purpose: 'verify_email' }))
    await store.create(rec({ token: 'b', userId: 'u1', purpose: 'reset_password' })) // wrong purpose
    await store.create(rec({ token: 'c', userId: 'u2', purpose: 'verify_email' })) // wrong user
    await store.deleteForUser('u1', 'verify_email')
    expect(await store.find('a')).toBeNull()
    expect(await store.find('b')).not.toBeNull()
    expect(await store.find('c')).not.toBeNull()
  })
})

describe('MemoryApiKeyStore', () => {
  const rec = (over: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
    id: 'k1',
    name: 'CI',
    prefix: 'mk_live_ab',
    hash: 'hash1',
    scopes: ['read'],
    createdAt: Date.now(),
    ...over,
  })

  it('findByHash / findById return the match and null when absent', async () => {
    const store = new MemoryApiKeyStore()
    await store.create(rec())
    expect((await store.findByHash('hash1'))?.id).toBe('k1')
    expect(await store.findByHash('nope')).toBeNull()
    expect((await store.findById('k1'))?.hash).toBe('hash1')
    expect(await store.findById('nope')).toBeNull()
  })

  it('list skips revoked keys and honours the tenant/user filters', async () => {
    const store = new MemoryApiKeyStore()
    await store.create(rec({ id: 'active', tenantId: 't1', userId: 'u1' }))
    await store.create(rec({ id: 'revoked', tenantId: 't1', userId: 'u1', revokedAt: Date.now() }))
    await store.create(rec({ id: 'otherTenant', tenantId: 't2', userId: 'u1' }))
    await store.create(rec({ id: 'otherUser', tenantId: 't1', userId: 'u2' }))

    const scoped = await store.list({ tenantId: 't1', userId: 'u1' })
    expect(scoped.map((k) => k.id)).toEqual(['active'])

    // An empty filter returns every non-revoked key.
    const all = await store.list({})
    expect(all.map((k) => k.id).sort()).toEqual(['active', 'otherTenant', 'otherUser'])
  })

  it('touch and revoke mutate known keys and are no-ops otherwise', async () => {
    const store = new MemoryApiKeyStore()
    await store.create(rec())
    await store.touch('k1', 123)
    expect((await store.findById('k1'))?.lastUsedAt).toBe(123)
    await store.revoke('k1', 456)
    expect((await store.findById('k1'))?.revokedAt).toBe(456)
    await expect(store.touch('missing', 1)).resolves.toBeUndefined()
    await expect(store.revoke('missing', 1)).resolves.toBeUndefined()
  })
})

describe('MemoryMfaStore', () => {
  const rec: MfaRecord = { secret: 's', enabled: true, recoveryCodes: [] }

  it('get returns the record and null when absent; set then delete', async () => {
    const store = new MemoryMfaStore()
    expect(await store.get('u1')).toBeNull()
    await store.set('u1', rec)
    expect((await store.get('u1'))?.secret).toBe('s')
    await store.delete('u1')
    expect(await store.get('u1')).toBeNull()
  })
})

describe('MemoryTokenVersionStore', () => {
  it('get defaults to 0 and increment bumps from 0 then from the stored value', async () => {
    const store = new MemoryTokenVersionStore()
    expect(await store.get('u1')).toBe(0)
    expect(await store.increment('u1')).toBe(1)
    expect(await store.increment('u1')).toBe(2)
    expect(await store.get('u1')).toBe(2)
    // A different, never-seen user still starts from 0.
    expect(await store.get('u2')).toBe(0)
  })
})

describe('MemorySessionStore', () => {
  it('find returns null for unknown and expired sessions, and the live record otherwise', async () => {
    const store = new MemorySessionStore()
    expect(await store.find('nope')).toBeNull()

    const live = await store.create('u1', 60_000)
    const found = await store.find(live.id)
    expect(found?.userId).toBe('u1')
    expect(found?.id).toBe(live.id) // echoes the raw id, never the stored hash

    // A already-expired session is evicted on lookup.
    const expired = await store.create('u2', -1)
    expect(await store.find(expired.id)).toBeNull()
  })

  it('delete reports whether a session existed', async () => {
    const store = new MemorySessionStore()
    const s = await store.create('u1', 60_000)
    expect(await store.delete(s.id)).toBe(true)
    expect(await store.delete(s.id)).toBe(false)
  })

  it('deleteAllForUser removes only that user’s sessions', async () => {
    const store = new MemorySessionStore()
    const a = await store.create('u1', 60_000)
    const b = await store.create('u1', 60_000)
    const c = await store.create('u2', 60_000)
    await store.deleteAllForUser('u1')
    expect(await store.find(a.id)).toBeNull()
    expect(await store.find(b.id)).toBeNull()
    expect(await store.find(c.id)).not.toBeNull()
  })
})

describe('MemoryRefreshTokenStore', () => {
  const rec = (over: Partial<RefreshRecord> = {}): RefreshRecord => ({
    token: 'r1',
    familyId: 'f1',
    userId: 'u1',
    expiresAt: Date.now() + 60_000,
    ...over,
  })

  it('find returns the record and null when absent', async () => {
    const store = new MemoryRefreshTokenStore()
    await store.create(rec())
    expect((await store.find('r1'))?.userId).toBe('u1')
    expect(await store.find('missing')).toBeNull()
  })

  it('markUsed sets usedAt for a known token and is a no-op for an unknown one', async () => {
    const store = new MemoryRefreshTokenStore()
    await store.create(rec())
    await store.markUsed('r1')
    expect((await store.find('r1'))?.usedAt).toBeTypeOf('number')
    await expect(store.markUsed('missing')).resolves.toBeUndefined()
  })

  it('revokeFamily removes only the named family', async () => {
    const store = new MemoryRefreshTokenStore()
    await store.create(rec({ token: 'a', familyId: 'f1' }))
    await store.create(rec({ token: 'b', familyId: 'f2' }))
    await store.revokeFamily('f1')
    expect(await store.find('a')).toBeNull()
    expect(await store.find('b')).not.toBeNull()
  })

  it('revokeAllForUser removes only that user’s tokens', async () => {
    const store = new MemoryRefreshTokenStore()
    await store.create(rec({ token: 'a', userId: 'u1' }))
    await store.create(rec({ token: 'b', userId: 'u2' }))
    await store.revokeAllForUser('u1')
    expect(await store.find('a')).toBeNull()
    expect(await store.find('b')).not.toBeNull()
  })
})
