import { describe, expect, it } from 'vitest'
import {
  assertSchemaPerTenantSupported,
  providerOf,
  SchemaPerTenantUnsupportedError,
} from '../src/index.js'
import { migrateTenants } from '../src/migrate.js'

/**
 * Schema-per-tenant is a PostgreSQL feature and is deliberately NOT abstracted:
 * in MySQL a "schema" IS a database, so translating it would silently do
 * database-per-tenant under a name that says otherwise — different backups,
 * different connection limits, different migration cost.
 *
 * What we owe the user instead is to say so at the moment the configuration is
 * read, rather than letting a raw `CREATE SCHEMA` syntax error surface at
 * tenant-creation time, far from its cause.
 */

describe('providerOf', () => {
  it('reads the provider off the URL scheme', () => {
    expect(providerOf('postgresql://localhost:5432/app')).toBe('postgresql')
    expect(providerOf('postgres://localhost:5432/app')).toBe('postgresql')
    expect(providerOf('mysql://root@localhost:3306/app')).toBe('mysql')
    expect(providerOf('file:./dev.db')).toBe('sqlite')
    expect(providerOf('sqlserver://localhost:1433')).toBe('sqlserver')
    expect(providerOf('mongodb+srv://cluster/app')).toBe('mongodb')
  })

  it('says unknown rather than guessing', () => {
    expect(providerOf('prisma://accelerate.example.com/?api_key=x')).toBe('unknown')
    expect(providerOf('not a url')).toBe('unknown')
  })
})

describe('assertSchemaPerTenantSupported', () => {
  it('allows PostgreSQL', () => {
    expect(() => assertSchemaPerTenantSupported('postgresql://localhost/app')).not.toThrow()
  })

  it('refuses MySQL and SQLite, naming the alternative', () => {
    for (const url of ['mysql://root@localhost/app', 'file:./dev.db']) {
      expect(() => assertSchemaPerTenantSupported(url)).toThrow(SchemaPerTenantUnsupportedError)
      expect(() => assertSchemaPerTenantSupported(url)).toThrow(/database-per-tenant/)
    }
  })

  it('lets an unknown scheme through — a proxy URL is not refused on a guess', () => {
    // @basaltkit/prisma cannot know what sits behind prisma:// or a custom
    // pooler, and failing closed there would block a valid setup.
    expect(() => assertSchemaPerTenantSupported('prisma://accelerate.example.com')).not.toThrow()
  })
})

describe('migrateTenants refuses the wrong database before shelling out', () => {
  it('aborts the whole run rather than failing every tenant identically', async () => {
    // The one thing that legitimately aborts migrateTenants. Every tenant shares
    // the base URL in schema mode, so this is a configuration error for the run —
    // collecting N copies of it as per-tenant failures would bury the cause.
    let migrateCalled = false
    await expect(
      migrateTenants({
        tenants: ['acme', 'globex'],
        target: { mode: 'schema', url: 'mysql://root@localhost/app' },
        migrate: async () => void (migrateCalled = true),
      }),
    ).rejects.toThrow(/PostgreSQL/)

    expect(migrateCalled, 'no migration should have been attempted').toBe(false)
  })

  it('still runs schema mode on PostgreSQL', async () => {
    const seen: string[] = []
    const results = await migrateTenants({
      tenants: ['acme'],
      target: { mode: 'schema', url: 'postgresql://localhost:5432/app' },
      migrate: async ({ schema }) => void seen.push(schema!),
    })
    expect(results[0]!.ok).toBe(true)
    expect(seen).toEqual(['tenant_acme'])
  })

  it('leaves database-per-tenant alone whatever the provider', async () => {
    const seen: string[] = []
    const results = await migrateTenants({
      tenants: ['acme', 'globex'],
      target: { mode: 'database', urlFor: (id) => `mysql://root@localhost/${id}` },
      migrate: async ({ url }) => void seen.push(url),
    })
    expect(results.every((r) => r.ok)).toBe(true)
    expect(seen).toEqual(['mysql://root@localhost/acme', 'mysql://root@localhost/globex'])
  })
})
