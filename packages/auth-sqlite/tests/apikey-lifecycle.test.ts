import { DatabaseSync } from 'node:sqlite'
import { ApiKeys } from '@basaltkit/auth'
import { describe, expect, it } from 'vitest'
import { migrate, openAuthDatabase, SqliteApiKeyStore } from '../src/index.js'
import { apiKeyStoreContract } from './apikey-store-contract.js'

// BK-083 (c)/(e)/(f): API key lifecycle columns on SQLite.
apiKeyStoreContract('SqliteApiKeyStore', () => new SqliteApiKeyStore(openAuthDatabase()))

/** The `auth_api_keys` table as @basaltkit/auth-sqlite 1.x created it. */
const LEGACY_TABLE = `CREATE TABLE auth_api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT, user_id TEXT, scopes TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
)`

describe('SqliteApiKeyStore migration (BK-083 lifecycle)', () => {
  it('migrate() adds the lifecycle columns and indexes to a 1.x table, idempotently; old keys keep working', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(LEGACY_TABLE)
    db.prepare(
      `INSERT INTO auth_api_keys (id, name, prefix, hash, tenant_id, user_id, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('legacy', 'old', 'mk_live_oldold', 'h-legacy', 't1', 'u1', '["*"]', 1)
    migrate(db)
    migrate(db)
    const columns = (db.prepare('PRAGMA table_info(auth_api_keys)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining(['service_id', 'previous_hash', 'previous_hash_expires_at', 'rotated_at', 'allowed_ips', 'meta']),
    )
    const indexes = (db.prepare('PRAGMA index_list(auth_api_keys)').all() as { name: string }[]).map((i) => i.name)
    expect(indexes).toEqual(expect.arrayContaining(['idx_api_keys_prev_hash', 'idx_api_keys_service']))

    const store = new SqliteApiKeyStore(db)
    const legacy = await store.findByHash('h-legacy')
    expect(legacy).toMatchObject({ id: 'legacy', tenantId: 't1', userId: 'u1', scopes: ['*'] })
    expect(legacy?.serviceId).toBeUndefined()
    expect(legacy?.allowedIps).toBeUndefined()
    expect(await store.update('legacy', { name: 'renamed' })).toMatchObject({ name: 'renamed' })
  })

  it('refuses two keys sharing a previous hash (unique partial index)', async () => {
    const store = new SqliteApiKeyStore(openAuthDatabase())
    const base = { name: 'k', prefix: 'mk_live_aaaaaa', scopes: ['*'], createdAt: 1 }
    await store.create({ ...base, id: 'a', hash: 'ha', previousHash: 'same' })
    await expect(store.create({ ...base, id: 'b', hash: 'hb', previousHash: 'same' })).rejects.toThrow()
  })

  it('end to end: ApiKeys.rotate on SQLite keeps the old secret only for the grace window', async () => {
    let now = 1_000_000
    const keys = new ApiKeys({ store: new SqliteApiKeyStore(openAuthDatabase()), now: () => now })
    const { record, key: oldKey } = await keys.issue({ name: 'ci', tenantId: 't1' })
    const { key: newKey } = await keys.rotate(record.id, { graceMs: 60_000 })
    expect((await keys.verify(oldKey))?.id).toBe(record.id)
    expect((await keys.verify(newKey))?.id).toBe(record.id)
    now += 60_000
    expect(await keys.verify(oldKey)).toBeNull()
    expect((await keys.verify(newKey))?.id).toBe(record.id)
  })
})
