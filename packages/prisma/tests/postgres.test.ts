import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { provisionTenantSchema, tenantSchema, type SchemaProvisioner } from '../src/index.js'

// pglite instantiates a Postgres in WebAssembly; a cold start on a CI runner can
// exceed the default 5s test/hook timeout (it's ~1.8s locally). Give it room so
// the suite isn't flaky under load — applies to `pnpm test` and `test:coverage`.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// Real PostgreSQL, in-process via pglite (WASM) — no server, runs anywhere.
// The suite skips gracefully if pglite cannot load/instantiate.
type PGliteInstance = {
  exec(sql: string): Promise<unknown>
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  close(): Promise<void>
}
type PGliteCtor = new () => PGliteInstance

let Ctor: PGliteCtor | undefined
try {
  const mod = (await import('@electric-sql/pglite')) as { PGlite: PGliteCtor }
  const probe = new mod.PGlite()
  await probe.query('select 1')
  await probe.close()
  Ctor = mod.PGlite
} catch {
  Ctor = undefined
}

describe.skipIf(!Ctor)('PostgreSQL integration (pglite)', () => {
  let db: PGliteInstance

  beforeEach(() => {
    db = new (Ctor as PGliteCtor)()
  })
  afterEach(async () => {
    await db.close()
  })

  /** Adapts pglite to the SchemaProvisioner surface (Prisma's $executeRawUnsafe). */
  const provisioner = (): SchemaProvisioner => ({
    async $executeRawUnsafe(query: string) {
      await db.exec(query)
      return 0
    },
  })

  const count = async (sql: string, params?: unknown[]): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(sql, params)
    return Number(rows[0]?.n ?? 0)
  }

  describe('provisionTenantSchema', () => {
    it('creates the schema on a real server and is idempotent', async () => {
      const schema = tenantSchema('acme')
      await provisionTenantSchema(provisioner(), schema)
      await provisionTenantSchema(provisioner(), schema) // CREATE ... IF NOT EXISTS

      const found = await count(
        'SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = $1',
        [schema],
      )
      expect(found).toBe(1)
    })
  })

  describe('schema-per-tenant isolation via search_path', () => {
    it('the same unqualified table resolves to a different schema per tenant', async () => {
      for (const id of ['acme', 'globex']) {
        const schema = tenantSchema(id)
        await provisionTenantSchema(provisioner(), schema)
        await db.exec(`CREATE TABLE "${schema}".project (id text primary key, name text)`)
      }

      // acme writes through its search_path (what ?schema=tenant_acme sets)
      await db.exec(`SET search_path TO "${tenantSchema('acme')}"`)
      await db.query("INSERT INTO project (id, name) VALUES ('p1', 'Acme Project')")

      // globex, same table name, sees nothing
      await db.exec(`SET search_path TO "${tenantSchema('globex')}"`)
      expect(await count('SELECT count(*)::int AS n FROM project')).toBe(0)

      // acme still has its row
      await db.exec(`SET search_path TO "${tenantSchema('acme')}"`)
      const { rows } = await db.query<{ name: string }>('SELECT name FROM project')
      expect(rows).toEqual([{ name: 'Acme Project' }])
    })
  })

  describe('shared-database tenant filter', () => {
    it('a tenant_id WHERE isolates rows — the foundation tenancyExtension builds on', async () => {
      await db.exec('CREATE TABLE project (id text primary key, tenant_id text, name text)')
      await db.query(
        "INSERT INTO project (id, tenant_id, name) VALUES ('a','acme','A'), ('b','globex','B'), ('c','acme','C')",
      )

      // the scoped read applyTenantScope produces: WHERE tenant_id = $1
      const { rows } = await db.query<{ name: string }>(
        'SELECT name FROM project WHERE tenant_id = $1 ORDER BY name',
        ['acme'],
      )
      expect(rows.map((r) => r.name)).toEqual(['A', 'C'])

      // a create stamped with tenant_id lands in the right tenant's set
      await db.query("INSERT INTO project (id, tenant_id, name) VALUES ('d','globex','D')")
      expect(await count('SELECT count(*)::int AS n FROM project WHERE tenant_id = $1', ['globex'])).toBe(2)
    })
  })
})
