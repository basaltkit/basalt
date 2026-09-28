import { describe, expect, it } from 'vitest'
import { ColumnLengthError, PrismaAccessStore, type PrismaPermissionsClient, prismaAccessStore } from '../src/index.js'

type Row = Record<string, unknown>

/** A MySQL-outside-strict-mode fake: every string column is VARCHAR(191) and a longer value is cut. */
function mysqlLikeClient(): { client: PrismaPermissionsClient; tables: Record<string, Row[]> } {
  const tables: Record<string, Row[]> = { userRoles: [], userPerms: [], rolePerms: [] }
  const cut = (data: Row): Row =>
    Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 191) : v]))
  const same = (a: Row, b: Row): boolean => Object.keys(a).every((k) => a[k] === b[k])
  const insert = (list: Row[], data: Row[]): { count: number } => {
    let count = 0
    for (const row of data.map(cut)) if (!list.some((r) => same(r, row))) { list.push(row); count++ }
    return { count }
  }
  const find = (list: Row[], where: Row): never =>
    list.filter((r) => Object.keys(where).every((k) => r[k] === where[k])) as never
  const client: PrismaPermissionsClient = {
    permUserRole: {
      findMany: async ({ where }) => find(tables.userRoles!, where),
      createMany: async ({ data }) => insert(tables.userRoles!, data),
      deleteMany: async () => ({ count: 0 }),
    },
    permUserPermission: {
      findMany: async ({ where }) => find(tables.userPerms!, where),
      createMany: async ({ data }) => insert(tables.userPerms!, data),
    },
    permRolePermission: {
      findMany: async ({ where }) => find(tables.rolePerms!, where),
      createMany: async ({ data }) => insert(tables.rolePerms!, data),
    },
  }
  return { client, tables }
}

const prefix = 'reports:'.padEnd(191, 'x')
const longA = `${prefix}:read`
const longB = `${prefix}:delete`

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it('without the guard two long permissions cut to one prefix collapse into a single grant', async () => {
    const { client, tables } = mysqlLikeClient()
    await new PrismaAccessStore(client).grantToRole('auditor', [longA, longB], 'global')
    expect(tables.rolePerms).toHaveLength(1)
    expect((tables.rolePerms![0]!.permission as string).length).toBe(191)
  })

  it("'mysql' refuses a permission over VARCHAR(191) and writes none of the batch", async () => {
    const { client, tables } = mysqlLikeClient()
    const { store } = prismaAccessStore(client, { columnLimits: 'mysql' })
    await expect(store.grantToRole('auditor', ['reports:read', longA], 'global')).rejects.toMatchObject({
      code: 'COLUMN_LENGTH_EXCEEDED',
      status: 422,
      column: 'PermRolePermission.permission',
      limit: 191,
    })
    await expect(store.grantToUser('u1', [longB], 'global')).rejects.toBeInstanceOf(ColumnLengthError)
    await expect(store.assignRole('u1', 'r'.repeat(192), 'global')).rejects.toThrow(/PermUserRole\.role is 192 characters/)
    await expect(store.assignRole('u'.repeat(192), 'admin', 'global')).rejects.toThrow(/PermUserRole\.userId/)
    expect(tables.rolePerms).toHaveLength(0)
    expect(tables.userPerms).toHaveLength(0)
    expect(tables.userRoles).toHaveLength(0)
  })

  it("'mysql' accepts values that fit (191 characters, counted in code points)", async () => {
    const { client, tables } = mysqlLikeClient()
    const store = new PrismaAccessStore(client, { columnLimits: 'mysql' })
    await store.grantToRole('auditor', ['p'.repeat(191), '😀'.repeat(191)], 'global')
    await store.assignRole('u1', 'admin', 'tenant:acme')
    expect(tables.rolePerms).toHaveLength(2)
    expect(await store.getUserRoles('u1', 'tenant:acme')).toEqual(['admin'])
  })

  it('custom limits apply per model and column', async () => {
    const { client } = mysqlLikeClient()
    const store = new PrismaAccessStore(client, { columnLimits: { PermUserRole: { scope: 10 } } })
    await expect(store.assignRole('u1', 'admin', 'tenant:acme-corp')).rejects.toThrow(/PermUserRole\.scope/)
    await store.grantToUser('u1', [longA], 'tenant:acme-corp') // unchecked model
  })

  it('a malformed limit fails at wiring time', () => {
    const { client } = mysqlLikeClient()
    expect(() => prismaAccessStore(client, { columnLimits: { PermUserRole: { role: 0 } } })).toThrow(TypeError)
    expect(() => new PrismaAccessStore(client, { columnLimits: 'postgres' as never })).toThrow(TypeError)
  })

  it('unset: no check (PostgreSQL / SQLite)', async () => {
    const { client, tables } = mysqlLikeClient()
    await prismaAccessStore(client).store.assignRole('u1', 'r'.repeat(500), 'global')
    expect(tables.userRoles).toHaveLength(1)
  })
})
