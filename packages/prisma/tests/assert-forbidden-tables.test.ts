import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@basaltkit/core'
import { assertMigrated, DatabaseNotMigratedError, DatabasePlaneMixedError, prismaPlugin } from '../src/index.js'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// BK-030: a root `prisma migrate dev` recreated the tenant tables in the
// central database. `forbiddenTables` makes the boot refuse such a database.

/** Postgres-like fake: `tables` exist, anything else is 42P01. */
const fakeDb = (tables: string[], dialect: 'postgres' | 'mysql' = 'postgres') => ({
  queries: [] as string[],
  async $queryRawUnsafe(sql: string) {
    this.queries.push(sql)
    if (/current_database\(\)/.test(sql)) {
      if (dialect !== 'postgres') throw new Error('function current_database() does not exist')
      return [{ database: 'central', host: null, port: null }]
    }
    if (/DATABASE\(\)/.test(sql)) return [{ database: 'central', host: 'db', port: 3306 }]
    const table = /FROM\s+[`"]?([A-Za-z0-9_]+)[`"]?/i.exec(sql)?.[1] ?? ''
    if (tables.includes(table)) return [{ count: 0 }]
    throw Object.assign(new Error(`relation "${table}" does not exist`), { code: 'P2010', meta: { code: dialect === 'mysql' ? '1146' : '42P01' } })
  },
})

describe('assertMigrated({ forbiddenTables }) (BK-030)', () => {
  it('passes when none of the other plane’s tables exist', async () => {
    await expect(
      assertMigrated(fakeDb(['_prisma_migrations', 'tenants']), { forbiddenTables: ['auth_users', 'team_memberships'] }),
    ).resolves.toBeUndefined()
  })

  it('refuses with PRISMA_PLANE_MIXED naming every present table', async () => {
    const error = (await assertMigrated(fakeDb(['_prisma_migrations', 'auth_users', 'team_memberships']), {
      forbiddenTables: ['auth_users', 'team_memberships', 'perm_roles'],
    }).catch((e: unknown) => e)) as DatabasePlaneMixedError
    expect(error).toBeInstanceOf(DatabasePlaneMixedError)
    expect(error.code).toBe('PRISMA_PLANE_MIXED')
    expect(error.details).toEqual({ tables: ['auth_users', 'team_memberships'] })
    expect(error.message).toContain('auth_users, team_memberships')
    expect(error.message).toContain('prisma.config.ts')
  })

  it('quotes per dialect (MySQL backticks) and rejects an invalid name', async () => {
    const db = fakeDb(['_prisma_migrations', 'auth_users'], 'mysql')
    await expect(assertMigrated(db, { forbiddenTables: ['auth_users'] })).rejects.toBeInstanceOf(DatabasePlaneMixedError)
    expect(db.queries.some((q) => q.includes('`auth_users`'))).toBe(true)
    await expect(
      assertMigrated(fakeDb(['_prisma_migrations']), { forbiddenTables: ['x; DROP TABLE y'] }),
    ).rejects.toBeInstanceOf(DatabaseNotMigratedError)
  })

  it('prismaPlugin({ assertMigrated: { forbiddenTables } }) fails the boot', async () => {
    const app = createApp({
      plugins: [
        prismaPlugin({
          client: fakeDb(['_prisma_migrations', 'auth_users']),
          assertMigrated: { forbiddenTables: ['auth_users'] },
        }),
      ],
    })
    await expect(app.boot()).rejects.toMatchObject({ code: 'PRISMA_PLANE_MIXED' })
  })
})

type PGliteInstance = {
  exec(sql: string): Promise<unknown>
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  close(): Promise<void>
}
let Ctor: (new () => PGliteInstance) | undefined
try {
  Ctor = ((await import('@electric-sql/pglite')) as { PGlite: new () => PGliteInstance }).PGlite
} catch {
  Ctor = undefined
}

describe.skipIf(!Ctor)('forbiddenTables on real PostgreSQL (pglite)', () => {
  it('refuses a central database that grew tenant tables, and accepts it once dropped', async () => {
    const db = new Ctor!()
    try {
      await db.exec('CREATE TABLE _prisma_migrations (id text); CREATE TABLE auth_users (id text);')
      const client = {
        $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
          (await db.query<Record<string, unknown>>(sql, values)).rows,
      }
      await expect(assertMigrated(client, { forbiddenTables: ['auth_users'] })).rejects.toBeInstanceOf(
        DatabasePlaneMixedError,
      )
      await db.exec('DROP TABLE auth_users')
      await expect(assertMigrated(client, { forbiddenTables: ['auth_users'] })).resolves.toBeUndefined()
    } finally {
      await db.close()
    }
  })
})
