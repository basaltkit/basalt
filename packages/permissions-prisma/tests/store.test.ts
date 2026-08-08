import { beforeEach, describe, expect, it } from 'vitest'
import { PrismaAccessStore, type PrismaPermissionsClient, prismaAccessStore } from '../src/index.js'

// In-memory fake of the Prisma delegate surface — the injectable-client pattern.
// Each "table" is a list of composite rows with createMany(skipDuplicates) dedup.
function makeFakeClient(): PrismaPermissionsClient {
  const userRoles: { scope: string; userId: string; role: string }[] = []
  const userPerms: { scope: string; userId: string; permission: string }[] = []
  const rolePerms: { scope: string; role: string; permission: string }[] = []
  const has = (list: Record<string, string>[], row: Record<string, string>): boolean =>
    list.some((r) => Object.keys(row).every((k) => r[k] === row[k]))
  const insert = (list: Record<string, string>[], data: Record<string, string>[]): { count: number } => {
    let count = 0
    for (const row of data) if (!has(list, row)) { list.push(row); count++ }
    return { count }
  }
  const match = (list: Record<string, string>[], where: Record<string, string>): Record<string, string>[] =>
    list.filter((r) => Object.keys(where).every((k) => r[k] === where[k]))

  return {
    permUserRole: {
      async findMany({ where }) {
        return match(userRoles, where) as { role: string }[]
      },
      async createMany({ data }) {
        return insert(userRoles, data)
      },
      async deleteMany({ where }) {
        const keep = userRoles.filter((r) => !Object.keys(where).every((k) => r[k as keyof typeof r] === where[k]))
        const count = userRoles.length - keep.length
        userRoles.length = 0
        userRoles.push(...keep)
        return { count }
      },
    },
    permUserPermission: {
      async findMany({ where }) {
        return match(userPerms, where) as { permission: string }[]
      },
      async createMany({ data }) {
        return insert(userPerms, data)
      },
    },
    permRolePermission: {
      async findMany({ where }) {
        return match(rolePerms, where) as { permission: string }[]
      },
      async createMany({ data }) {
        return insert(rolePerms, data)
      },
    },
  }
}

let client: PrismaPermissionsClient
beforeEach(() => {
  client = makeFakeClient()
})

describe('PrismaAccessStore', () => {
  it('assigns roles (as a set), scoped, and removes them', async () => {
    const store = new PrismaAccessStore(client)
    await store.assignRole('u1', 'admin', 't1')
    await store.assignRole('u1', 'editor', 't1')
    await store.assignRole('u1', 'admin', 't1') // no-op
    await store.assignRole('u1', 'viewer', 't2')

    expect(await store.getUserRoles('u1', 't1')).toEqual(['admin', 'editor'])
    expect(await store.getUserRoles('u1', 't2')).toEqual(['viewer'])
    expect(await store.getUserRoles('u2', 't1')).toEqual([])

    await store.removeRole('u1', 'admin', 't1')
    expect(await store.getUserRoles('u1', 't1')).toEqual(['editor'])
    await store.removeRole('u1', 'ghost', 't1') // no-op
    expect(await store.getUserRoles('u1', 't1')).toEqual(['editor'])
  })

  it('grants permissions to roles and users (deduped, scoped)', async () => {
    const store = new PrismaAccessStore(client)
    await store.grantToRole('admin', ['projects:read', 'projects:write'], 't1')
    await store.grantToRole('admin', ['projects:write', 'projects:delete'], 't1')
    expect(await store.getRolePermissions('admin', 't1')).toEqual(['projects:read', 'projects:write', 'projects:delete'])
    expect(await store.getRolePermissions('admin', 't2')).toEqual([])

    await store.grantToUser('u1', ['billing:read'], 't1')
    await store.grantToUser('u1', ['billing:read'], 't1')
    expect(await store.getUserPermissions('u1', 't1')).toEqual(['billing:read'])
    expect(await store.getUserPermissions('u1', 't2')).toEqual([])
  })
})

describe('prismaAccessStore', () => {
  it('bundles the store named for permissionsPlugin', () => {
    expect(prismaAccessStore(client).store).toBeInstanceOf(PrismaAccessStore)
  })
})
