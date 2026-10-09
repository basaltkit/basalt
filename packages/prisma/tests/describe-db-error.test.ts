import { describe, expect, it, vi } from 'vitest'
import { assertMigrated, DatabaseNotMigratedError, describeDbError } from '../src/index.js'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const prismaError = (code: string, message: string, meta?: Record<string, unknown>) =>
  Object.assign(new Error(message), { code, ...(meta ? { meta } : {}) })

describe('describeDbError (BK-041)', () => {
  const cases: [string, unknown, string | undefined, RegExp | undefined][] = [
    [
      'pg driver 42501 on a schema',
      Object.assign(new Error('permission denied for schema public'), { code: '42501' }),
      'DB_PERMISSION_DENIED',
      /GRANT USAGE ON SCHEMA public TO app_user/,
    ],
    [
      'Prisma P2010 wrapping 42501 on a table',
      prismaError('P2010', 'Raw query failed. Code: `42501`. Message: `permission denied for table audit_log`', {
        code: '42501',
      }),
      'DB_PERMISSION_DENIED',
      /ON ALL TABLES IN SCHEMA public TO app_user/,
    ],
    ['Prisma P1010', prismaError('P1010', 'User `bob` was denied access on the database `x`'), 'DB_PERMISSION_DENIED', /GRANT/],
    [
      'P3005 from the CLI stderr',
      'Error: P3005\n\nThe database schema is not empty. Read more about how to baseline',
      'DB_NOT_EMPTY_BASELINE',
      /prisma migrate resolve --applied/,
    ],
    ['P1001', prismaError('P1001', "Can't reach database server at `db:5432`"), 'DB_UNREACHABLE', /DATABASE_URL/],
    [
      'ECONNREFUSED in an AggregateError',
      Object.assign(new AggregateError([Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })], 'boom')),
      'DB_UNREACHABLE',
      /running/,
    ],
    ['P1000', prismaError('P1000', 'Authentication failed against database server'), 'DB_UNREACHABLE', /password/],
    ['P1003', prismaError('P1003', 'Database `nope` does not exist'), 'DB_UNREACHABLE', /database name/],
    ['P2021', prismaError('P2021', 'The table `public.Project` does not exist in the current database.'), 'DB_NOT_MIGRATED', /tenant:migrate/],
    ['42P01 via meta', prismaError('P2010', 'relation "x" does not exist', { code: '42P01' }), 'DB_NOT_MIGRATED', /migrate deploy/],
    ['an unrelated error', new Error('Unique constraint failed'), undefined, undefined],
    ['nothing at all', undefined, undefined, undefined],
  ]

  for (const [name, error, code, fix] of cases) {
    it(name, () => {
      const diagnosis = describeDbError(error, { url: 'postgres://app_user:s3cret@db:5432/app' }) // trufflehog:ignore — fake test credentials
      expect(diagnosis?.code).toBe(code)
      if (fix) expect(diagnosis?.fix).toMatch(fix)
      if (diagnosis) expect(JSON.stringify(diagnosis)).not.toContain('s3cret')
    })
  }

  it('falls back to a placeholder role, and redacts credentials quoted in the cause', () => {
    const diagnosis = describeDbError(new Error('permission denied for schema public'))
    expect(diagnosis?.fix).toContain('<app_role>')
    const unreachable = describeDbError(
      new Error("Can't reach database server at postgres://admin:hunter2@db:5432/app"), // trufflehog:ignore — fake test credentials
    )
    expect(unreachable?.cause).not.toContain('hunter2')
  })
})

describe('assertMigrated reports permission denied as such, with the GRANT (BK-041)', () => {
  it('fake client: 42501 is not "could not verify"', async () => {
    const client = {
      async $queryRawUnsafe(sql: string) {
        if (/current_database\(\)/.test(sql)) return [{ database: 'app', host: null, port: null, role: 'app_user' }]
        throw Object.assign(new Error('permission denied for schema public'), { code: '42501' })
      },
    }
    const error = (await assertMigrated(client).catch((e: unknown) => e)) as DatabaseNotMigratedError
    expect(error).toBeInstanceOf(DatabaseNotMigratedError)
    expect(error.code).toBe('PRISMA_NOT_MIGRATED')
    expect(error.message).not.toMatch(/^Could not verify/)
    expect(error.message).toContain('GRANT USAGE ON SCHEMA public TO app_user')
    expect(error.details).toMatchObject({ diagnosis: { code: 'DB_PERMISSION_DENIED' } })
  })

  it('missing tables carry a DB_NOT_MIGRATED diagnosis', async () => {
    const client = {
      async $queryRawUnsafe(sql: string) {
        if (/current_database\(\)/.test(sql)) return [{ database: 'app', host: null, port: null }]
        throw Object.assign(new Error('relation "_prisma_migrations" does not exist'), { code: 'P2010', meta: { code: '42P01' } })
      },
    }
    const error = (await assertMigrated(client).catch((e: unknown) => e)) as DatabaseNotMigratedError
    expect(error.details).toMatchObject({ diagnosis: { code: 'DB_NOT_MIGRATED' } })
  })
})

// Real PostgreSQL in-process (pglite); skipped when it cannot load.
type PGliteInstance = {
  exec(sql: string): Promise<unknown>
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  close(): Promise<void>
}
let Ctor: (new () => PGliteInstance) | undefined
try {
  const mod = (await import('@electric-sql/pglite')) as { PGlite: new () => PGliteInstance }
  Ctor = mod.PGlite
} catch {
  Ctor = undefined
}

describe.skipIf(!Ctor)('assertMigrated against a role without USAGE on the schema (pglite)', () => {
  it('names the role that lacks USAGE on the schema', async () => {
    const db = new Ctor!()
    try {
      await db.exec(`
        CREATE TABLE _prisma_migrations (id text);
        CREATE ROLE app_ro;
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        SET ROLE app_ro;
      `)
      const client = {
        $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
          (await db.query<Record<string, unknown>>(sql, values)).rows,
      }
      const error = (await assertMigrated(client).catch((e: unknown) => e)) as DatabaseNotMigratedError
      expect(error).toBeInstanceOf(DatabaseNotMigratedError)
      expect(error.details).toMatchObject({ diagnosis: { code: 'DB_PERMISSION_DENIED' } })
      expect(error.message).toContain('GRANT USAGE ON SCHEMA public TO app_ro')
    } finally {
      await db.close()
    }
  })

  it('does not blame a schema outside the search_path (a tenant schema the role cannot use)', async () => {
    const db = new Ctor!()
    try {
      await db.exec(`
        CREATE SCHEMA tenant_a;
        CREATE TABLE tenant_a._prisma_migrations (id text);
        CREATE ROLE app_rw;
        GRANT USAGE ON SCHEMA public TO app_rw;
        REVOKE ALL ON SCHEMA tenant_a FROM PUBLIC;
        SET ROLE app_rw;
      `)
      const client = {
        $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
          (await db.query<Record<string, unknown>>(sql, values)).rows,
      }
      const error = (await assertMigrated(client).catch((e: unknown) => e)) as DatabaseNotMigratedError
      expect(error).toBeInstanceOf(DatabaseNotMigratedError)
      expect(error.details).toMatchObject({ diagnosis: { code: 'DB_NOT_MIGRATED' } })
      expect(error.message).not.toContain('tenant_a')
    } finally {
      await db.close()
    }
  })
})
