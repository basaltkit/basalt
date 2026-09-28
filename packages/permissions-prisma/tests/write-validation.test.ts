import { describe, expect, it } from 'vitest'
import { PrismaAccessStore, type PrismaPermissionsClient } from '../src/index.js'

// Records every write; reads return what was written to the matching delegate.
function fakeClient(): PrismaPermissionsClient {
  const table = () => {
    const rows: Record<string, unknown>[] = []
    return {
      async findMany({ where }: { where: Record<string, unknown> }) {
        return rows.filter((r) => Object.keys(where).every((k) => r[k] === where[k])) as never[]
      },
      async createMany({ data }: { data: Record<string, unknown>[] }) {
        rows.push(...data)
        return { count: data.length }
      },
      async deleteMany() {
        return { count: 0 }
      },
    }
  }
  return { permUserRole: table(), permUserPermission: table(), permRolePermission: table() }
}

/**
 * Framework audit residual: direct store writes used to accept an empty or
 * non-string user id / role name. `''`, `null` and `undefined` all collapse to
 * one shared row key (Prisma would write them as they come, or fail late in the database with
 * an opaque error), so a grant written for "nobody" could be honoured.
 */
const BAD = ['', null, undefined, 42, {}]

describe('PrismaAccessStore · refuses malformed ids on direct writes', () => {
  const store = () => new PrismaAccessStore(fakeClient())

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
