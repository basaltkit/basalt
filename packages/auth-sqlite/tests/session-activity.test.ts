import { DatabaseSync } from 'node:sqlite'
import { Auth } from '@basaltkit/auth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrate, openAuthDatabase, SqliteSessionStore, sqliteAuthStores } from '../src/index.js'

// BK-076: session activity (last_seen_at) for authPlugin's sessionIdleTtl.
afterEach(() => {
  vi.useRealTimers()
})

describe('SqliteSessionStore session activity (BK-076)', () => {
  it('writes lastSeenAt at creation, returns it from find, updates it on touch', async () => {
    const store = new SqliteSessionStore(openAuthDatabase())
    const s = await store.create('u1', 60_000)
    expect(typeof s.lastSeenAt).toBe('number')
    expect((await store.find(s.id))?.lastSeenAt).toBe(s.lastSeenAt)
    await store.touch(s.id, 1_234_567)
    expect((await store.find(s.id))?.lastSeenAt).toBe(1_234_567)
    await store.touch('ghost', 1) // tolerant no-op
  })

  it('migrates a legacy auth_sessions table; its rows have no lastSeenAt until touched', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)')
    const legacyStore = new SqliteSessionStore(db)
    migrate(db)
    migrate(db) // idempotent
    const columns = (db.prepare('PRAGMA table_info(auth_sessions)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toContain('last_seen_at')
    const s = await legacyStore.create('u1', 60_000)
    db.prepare('UPDATE auth_sessions SET last_seen_at = NULL').run()
    const found = await legacyStore.find(s.id)
    expect(found).not.toBeNull()
    expect(found).not.toHaveProperty('lastSeenAt')
  })

  it('Auth enforces the idle timeout over the SQLite store, and a legacy row starts its clock on use', async () => {
    vi.useFakeTimers()
    const t0 = 2_000_000_000
    vi.setSystemTime(t0)
    const stores = sqliteAuthStores()
    const auth = new Auth({ users: stores.users, secret: 'x'.repeat(32), sessions: stores.sessions, sessionIdleTtl: '10m' })
    const user = await stores.users.create({ email: 'a@b.com', passwordHash: 'h' })
    const session = await auth.createSession(user.id)
    stores.db.prepare('UPDATE auth_sessions SET last_seen_at = NULL').run()

    vi.setSystemTime(t0 + 60 * 60_000) // an hour later: a legacy row is not expired, its clock starts now
    expect(await auth.sessionUser(session.id)).not.toBeNull()
    expect((await stores.sessions.find(session.id))?.lastSeenAt).toBe(t0 + 60 * 60_000)

    vi.setSystemTime(t0 + 60 * 60_000 + 11 * 60_000)
    expect(await auth.sessionUser(session.id)).toBeNull()
    expect(await stores.sessions.find(session.id)).toBeNull()
  })
})
