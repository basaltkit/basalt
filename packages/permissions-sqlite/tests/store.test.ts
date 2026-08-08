import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openPermissionsDatabase, SqliteAccessStore, sqliteAccessStore } from '../src/index.js'

describe('SqliteAccessStore', () => {
  it('assigns roles (as a set), scoped, and removes them', async () => {
    const store = new SqliteAccessStore(openPermissionsDatabase())
    await store.assignRole('u1', 'admin', 't1')
    await store.assignRole('u1', 'editor', 't1')
    await store.assignRole('u1', 'admin', 't1') // re-assign is a no-op
    await store.assignRole('u1', 'viewer', 't2') // different scope

    expect(await store.getUserRoles('u1', 't1')).toEqual(['admin', 'editor'])
    expect(await store.getUserRoles('u1', 't2')).toEqual(['viewer'])
    expect(await store.getUserRoles('u2', 't1')).toEqual([])

    await store.removeRole('u1', 'admin', 't1')
    expect(await store.getUserRoles('u1', 't1')).toEqual(['editor'])
    await store.removeRole('u1', 'ghost', 't1') // no-op
    expect(await store.getUserRoles('u1', 't1')).toEqual(['editor'])
  })

  it('grants permissions to roles and users (deduped, scoped)', async () => {
    const store = new SqliteAccessStore(openPermissionsDatabase())
    await store.grantToRole('admin', ['projects:read', 'projects:write'], 't1')
    await store.grantToRole('admin', ['projects:write', 'projects:delete'], 't1') // overlap deduped
    expect(await store.getRolePermissions('admin', 't1')).toEqual(['projects:read', 'projects:write', 'projects:delete'])
    expect(await store.getRolePermissions('admin', 't2')).toEqual([])

    await store.grantToUser('u1', ['billing:read'], 't1')
    await store.grantToUser('u1', ['billing:read'], 't1') // dedup
    expect(await store.getUserPermissions('u1', 't1')).toEqual(['billing:read'])
    expect(await store.getUserPermissions('u1', 't2')).toEqual([])
  })
})

describe('sqliteAccessStore + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'machize-perms-'))
  const file = join(dir, 'permissions.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles the store named for permissionsPlugin', () => {
    expect(sqliteAccessStore().store).toBeInstanceOf(SqliteAccessStore)
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openPermissionsDatabase()
    const p = sqliteAccessStore(db)
    expect(p.db).toBe(db)
    await p.store.assignRole('u1', 'admin', 't1')
    expect(await new SqliteAccessStore(db).getUserRoles('u1', 't1')).toEqual(['admin'])
  })

  it('survives a process restart', async () => {
    const first = sqliteAccessStore(file)
    await first.store.assignRole('u1', 'admin', 't1')
    await first.store.grantToRole('admin', ['projects:*'], 't1')
    first.db.close()
    const second = sqliteAccessStore(file)
    expect(await second.store.getUserRoles('u1', 't1')).toEqual(['admin'])
    expect(await second.store.getRolePermissions('admin', 't1')).toEqual(['projects:*'])
    second.db.close()
  })
})
