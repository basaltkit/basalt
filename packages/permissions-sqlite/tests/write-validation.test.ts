import { describe, expect, it } from 'vitest'
import { openPermissionsDatabase, SqliteAccessStore } from '../src/index.js'

/**
 * Framework audit residual: direct store writes used to accept an empty or
 * non-string user id / role name. `''`, `null` and `undefined` all collapse to
 * one shared row key (node:sqlite binds null/undefined as NULL, and SQLite's
 * PRIMARY KEY allows duplicate NULLs), so a grant written for "nobody" leaked.
 */
const BAD = ['', null, undefined, 42, {}]

describe('SqliteAccessStore · refuses malformed ids on direct writes', () => {
  const store = () => new SqliteAccessStore(openPermissionsDatabase())

  it.each(BAD)('user id %j', async (id) => {
    const s = store()
    await expect(s.assignRole(id as never, 'admin', 't1')).rejects.toThrow(TypeError)
    await expect(s.grantToUser(id as never, ['a:b'], 't1')).rejects.toThrow(TypeError)
    await expect(s.removeRole(id as never, 'admin', 't1')).rejects.toThrow(TypeError)
  })

  it.each(BAD)('role name %j', async (role) => {
    const s = store()
    await expect(s.assignRole('u1', role as never, 't1')).rejects.toThrow(TypeError)
    await expect(s.grantToRole(role as never, ['a:b'], 't1')).rejects.toThrow(TypeError)
  })

  it.each(BAD)('scope %j', async (scope) => {
    await expect(store().assignRole('u1', 'admin', scope as never)).rejects.toThrow(TypeError)
  })

  it('permission entries must be non-empty strings; nothing is written on failure', async () => {
    const s = store()
    await expect(s.grantToUser('u1', ['a:b', ''], 't1')).rejects.toThrow(TypeError)
    await expect(s.grantToRole('admin', ['a:b', null as never], 't1')).rejects.toThrow(TypeError)
    expect(await s.getUserPermissions('u1', 't1')).toEqual([])
    expect(await s.getRolePermissions('admin', 't1')).toEqual([])
  })
})
