import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { assertMigrated, DatabaseNotMigratedError, prismaPlugin, redactCredentials } from '../src/index.js'

/**
 * A fake client answering `$queryRawUnsafe` like Postgres: `tables` exist,
 * anything else is `relation "…" does not exist` (Prisma's P2010 / 42P01).
 */
function fakeDb({
  tables = ['_prisma_migrations'],
  identity = { database: 'mukanda', host: '10.0.0.5', port: 5432 },
  failWith,
}: {
  tables?: string[]
  identity?: Record<string, unknown> | null
  failWith?: Error
} = {}) {
  const queries: string[] = []
  return {
    queries,
    async $queryRawUnsafe(sql: string) {
      queries.push(sql)
      if (failWith) throw failWith
      if (/current_database\(\)/.test(sql)) {
        if (!identity) throw new Error('function current_database() does not exist')
        return [identity]
      }
      const match = /FROM\s+"?([A-Za-z0-9_]+)"?/i.exec(sql)
      const table = match?.[1] ?? ''
      if (tables.includes(table)) return [{ count: 1n }]
      throw Object.assign(new Error(`Raw query failed. Code: \`42P01\`. Message: \`relation "${table}" does not exist\``), {
        code: 'P2010',
        meta: { code: '42P01' },
      })
    },
  }
}

describe('assertMigrated — BK-018', () => {
  it('passes when _prisma_migrations exists', async () => {
    await expect(assertMigrated(fakeDb())).resolves.toBeUndefined()
  })

  it('fails naming the database and host when _prisma_migrations is missing', async () => {
    const error = await assertMigrated(fakeDb({ tables: [] })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DatabaseNotMigratedError)
    expect((error as DatabaseNotMigratedError).code).toBe('PRISMA_NOT_MIGRATED')
    expect((error as Error).message).toContain('"mukanda" on 10.0.0.5:5432')
    expect((error as Error).message).toContain('_prisma_migrations')
    expect((error as Error).message).toMatch(/DATABASE_URL/)
  })

  it('checks the listed tables and names every missing one', async () => {
    await expect(
      assertMigrated(fakeDb({ tables: ['_prisma_migrations', 'Project'] }), { tables: ['Project'] }),
    ).resolves.toBeUndefined()
    const error = await assertMigrated(fakeDb({ tables: ['_prisma_migrations', 'Project'] }), {
      tables: ['Project', 'Invoice', 'auth_users'],
    }).catch((e: unknown) => e as Error)
    expect(error).toBeInstanceOf(DatabaseNotMigratedError)
    expect((error as Error).message).toContain('Invoice, auth_users')
    expect((error as Error).message).not.toContain('Project,')
  })

  it('quotes table names (case-sensitive Prisma tables) and refuses unsafe names', async () => {
    const db = fakeDb({ tables: ['_prisma_migrations', 'Project'] })
    await assertMigrated(db, { tables: ['Project'] })
    expect(db.queries.some((q) => q.includes('"Project"'))).toBe(true)
    await expect(assertMigrated(db, { tables: ['x"; drop table y; --'] })).rejects.toThrow(/Invalid table name/)
  })

  it('never prints credentials from a driver error', async () => {
    const error = (await assertMigrated(
      // URL built at runtime so secret scanners do not flag the fake credential.
      fakeDb({ failWith: new Error(`Can't reach ${['postgresql://app', 's3cr3t@db.internal:5432/mukanda'].join(':')}`) }),
    ).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(DatabaseNotMigratedError)
    expect(error.message).not.toContain('s3cr3t')
    expect(error.message).toContain('db.internal:5432/mukanda')
  })

  it('redacts credentials linearly, including in adversarial input', () => {
    const url = ['postgres://u', 'p@h/db'].join(':')
    expect(redactCredentials(`a ${url} b`)).toBe('a postgres://***@h/db b')
    expect(redactCredentials('no url here')).toBe('no url here')
    expect(redactCredentials('://x@y and s3://bucket/key')).toBe('://x@y and s3://bucket/key')
    const hostile = `${'a'.repeat(50_000)}://${'b'.repeat(50_000)}`
    const started = performance.now()
    expect(redactCredentials(hostile)).toBe(hostile)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('still fails clearly when the database identity cannot be read', async () => {
    const error = (await assertMigrated(fakeDb({ tables: [], identity: null })).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(DatabaseNotMigratedError)
    expect(error.message).toMatch(/the configured database/i)
  })
})

describe('prismaPlugin({ assertMigrated }) — BK-018', () => {
  it('is off by default: boots against an unmigrated database', async () => {
    const db = fakeDb({ tables: [] })
    const app = await createApp({ plugins: [prismaPlugin({ client: db })] }).boot()
    expect(db.queries).toEqual([])
    await app.shutdown()
  })

  it('assertMigrated: true fails the boot against an unmigrated database', async () => {
    const app = createApp({ plugins: [prismaPlugin({ client: fakeDb({ tables: [] }), assertMigrated: true })] })
    await expect(app.boot()).rejects.toBeInstanceOf(DatabaseNotMigratedError)
  })

  it('assertMigrated: true boots a migrated database; { tables } checks them too', async () => {
    const ok = await createApp({ plugins: [prismaPlugin({ client: fakeDb(), assertMigrated: true })] }).boot()
    await ok.shutdown()
    const app = createApp({
      plugins: [prismaPlugin({ client: fakeDb(), assertMigrated: { tables: ['Project'] } })],
    })
    await expect(app.boot()).rejects.toThrow(/Project/)
  })

  it('assertMigrated without a shared client is a configuration error', () => {
    expect(() =>
      createApp({ plugins: [prismaPlugin({ forTenant: () => ({}), assertMigrated: true })] }),
    ).not.toThrow()
    return expect(
      createApp({ plugins: [prismaPlugin({ forTenant: () => ({}), assertMigrated: true })] }).boot(),
    ).rejects.toThrow(/assertMigrated needs `client`/)
  })
})
