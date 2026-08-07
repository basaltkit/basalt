import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  openAuthDatabase,
  SqliteApiKeyStore,
  SqliteAuthTokenStore,
  SqliteMfaStore,
  SqliteRefreshTokenStore,
  SqliteSessionStore,
  SqliteUserSource,
  sqliteAuthStores,
} from '../src/index.js'

describe('SqliteUserSource', () => {
  it('creates, finds and updates users', async () => {
    const users = new SqliteUserSource(openAuthDatabase())
    const created = await users.create({ email: 'a@b.com', passwordHash: 'h' })
    expect(created.id).toBeTruthy()
    expect(created.emailVerified).toBe(false)

    expect((await users.findByEmail('a@b.com'))?.id).toBe(created.id)
    expect((await users.findById(created.id))?.email).toBe('a@b.com')
    expect(await users.findByEmail('missing@b.com')).toBeNull()
    expect(await users.findById('nope')).toBeNull()

    const updated = await users.update(created.id, { emailVerified: true, passwordHash: 'h2' })
    expect(updated?.emailVerified).toBe(true)
    expect(updated?.passwordHash).toBe('h2')

    // empty patch is a no-op that still returns the user
    expect((await users.update(created.id, {}))?.email).toBe('a@b.com')
    expect(await users.update('ghost', { emailVerified: true })).toBeNull()
  })

  it('enforces unique emails', async () => {
    const users = new SqliteUserSource(openAuthDatabase())
    await users.create({ email: 'dup@b.com', passwordHash: 'h' })
    await expect(users.create({ email: 'dup@b.com', passwordHash: 'h' })).rejects.toThrow()
  })
})

describe('SqliteAuthTokenStore', () => {
  it('stores, marks used and clears by user/purpose', async () => {
    const store = new SqliteAuthTokenStore(openAuthDatabase())
    await store.create({ token: 't1', userId: 'u1', purpose: 'verify_email', expiresAt: Date.now() + 1000 })
    expect((await store.find('t1'))?.userId).toBe('u1')
    expect((await store.find('t1'))?.usedAt).toBeUndefined()

    await store.markUsed('t1')
    expect((await store.find('t1'))?.usedAt).toBeGreaterThan(0)

    await store.create({ token: 't2', userId: 'u1', purpose: 'reset_password', expiresAt: Date.now() + 1000 })
    await store.deleteForUser('u1', 'verify_email')
    expect(await store.find('t1')).toBeNull()
    expect(await store.find('t2')).not.toBeNull() // different purpose survives
    expect(await store.find('missing')).toBeNull()
  })
})

describe('SqliteSessionStore', () => {
  it('creates, finds and deletes', async () => {
    const store = new SqliteSessionStore(openAuthDatabase())
    const s = await store.create('u1', 60_000)
    expect(s.userId).toBe('u1')
    expect((await store.find(s.id))?.id).toBe(s.id)
    expect(await store.delete(s.id)).toBe(true)
    expect(await store.delete(s.id)).toBe(false)
    expect(await store.find(s.id)).toBeNull()
  })

  it('treats expired sessions as gone and evicts them', async () => {
    const store = new SqliteSessionStore(openAuthDatabase())
    const s = await store.create('u1', -1) // already expired
    expect(await store.find(s.id)).toBeNull()
    // second lookup confirms the row was evicted on the first miss
    expect(await store.find(s.id)).toBeNull()
  })
})

describe('SqliteRefreshTokenStore', () => {
  it('handles reuse (family revoke) and password reset (user revoke)', async () => {
    const store = new SqliteRefreshTokenStore(openAuthDatabase())
    await store.create({ token: 'r1', familyId: 'f1', userId: 'u1', expiresAt: Date.now() + 1000 })
    await store.create({ token: 'r2', familyId: 'f1', userId: 'u1', expiresAt: Date.now() + 1000 })
    await store.create({ token: 'r3', familyId: 'f2', userId: 'u2', expiresAt: Date.now() + 1000 })

    expect((await store.find('r1'))?.familyId).toBe('f1')
    await store.markUsed('r1')
    expect((await store.find('r1'))?.usedAt).toBeGreaterThan(0)

    await store.revokeFamily('f1')
    expect(await store.find('r1')).toBeNull()
    expect(await store.find('r2')).toBeNull()
    expect(await store.find('r3')).not.toBeNull()

    await store.revokeAllForUser('u2')
    expect(await store.find('r3')).toBeNull()
  })
})

describe('SqliteApiKeyStore', () => {
  it('creates, looks up, lists active, touches and revokes', async () => {
    const store = new SqliteApiKeyStore(openAuthDatabase())
    const base = { name: 'k', prefix: 'mk_ab', scopes: ['*'], createdAt: Date.now() }
    await store.create({ id: 'k1', hash: 'h1', tenantId: 't1', userId: 'u1', ...base })
    await store.create({ id: 'k2', hash: 'h2', tenantId: 't1', ...base }) // no user
    await store.create({ id: 'k3', hash: 'h3', tenantId: 't2', ...base })

    expect((await store.findByHash('h1'))?.id).toBe('k1')
    expect((await store.findByHash('h1'))?.scopes).toEqual(['*'])
    expect((await store.findById('k2'))?.userId).toBeUndefined()
    expect(await store.findByHash('nope')).toBeNull()
    expect(await store.findById('nope')).toBeNull()

    expect((await store.list({ tenantId: 't1' })).map((k) => k.id).sort()).toEqual(['k1', 'k2'])
    expect((await store.list({ tenantId: 't1', userId: 'u1' })).map((k) => k.id)).toEqual(['k1'])
    expect((await store.list({})).length).toBe(3)

    await store.touch('k1', 12345)
    expect((await store.findById('k1'))?.lastUsedAt).toBe(12345)

    await store.revoke('k1', 999)
    expect((await store.findById('k1'))?.revokedAt).toBe(999)
    expect((await store.list({ tenantId: 't1' })).map((k) => k.id)).toEqual(['k2']) // revoked hidden
  })

  it('enforces unique hashes', async () => {
    const store = new SqliteApiKeyStore(openAuthDatabase())
    const rec = { id: 'x', name: 'k', prefix: 'p', hash: 'same', scopes: [], createdAt: Date.now() }
    await store.create(rec)
    await expect(store.create({ ...rec, id: 'y' })).rejects.toThrow()
  })
})

describe('SqliteMfaStore', () => {
  it('gets, upserts and deletes', async () => {
    const store = new SqliteMfaStore(openAuthDatabase())
    expect(await store.get('u1')).toBeNull()

    await store.set('u1', { secret: 's', enabled: false, recoveryCodes: ['a', 'b'] })
    expect(await store.get('u1')).toEqual({ secret: 's', enabled: false, recoveryCodes: ['a', 'b'] })

    await store.set('u1', { secret: 's2', enabled: true, recoveryCodes: [] }) // upsert
    expect(await store.get('u1')).toEqual({ secret: 's2', enabled: true, recoveryCodes: [] })

    await store.delete('u1')
    expect(await store.get('u1')).toBeNull()
  })
})

describe('sqliteAuthStores + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'machize-auth-'))
  const file = join(dir, 'auth.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles every store named for authPlugin/apiKeysPlugin', () => {
    const s = sqliteAuthStores()
    expect(s.users).toBeInstanceOf(SqliteUserSource)
    expect(s.sessions).toBeInstanceOf(SqliteSessionStore)
    expect(s.refreshTokens).toBeInstanceOf(SqliteRefreshTokenStore)
    expect(s.tokens).toBeInstanceOf(SqliteAuthTokenStore)
    expect(s.apiKeys).toBeInstanceOf(SqliteApiKeyStore)
    expect(s.mfa).toBeInstanceOf(SqliteMfaStore)
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openAuthDatabase()
    const s = sqliteAuthStores(db)
    expect(s.db).toBe(db)
    await s.users.create({ email: 'shared@b.com', passwordHash: 'h' })
    expect(await new SqliteUserSource(db).findByEmail('shared@b.com')).not.toBeNull()
  })

  it('survives a process restart (data persists to disk)', async () => {
    const first = sqliteAuthStores(file)
    const user = await first.users.create({ email: 'persist@b.com', passwordHash: 'h' })
    const session = await first.sessions.create(user.id, 60_000)
    first.db.close()

    // reopen the same file — a fresh set of stores over the persisted db
    const second = sqliteAuthStores(file)
    expect((await second.users.findByEmail('persist@b.com'))?.id).toBe(user.id)
    expect((await second.sessions.find(session.id))?.userId).toBe(user.id)
    second.db.close()
  })
})
