import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  countTenantTables,
  crossTenantScanSql,
  migrateTenants,
  provisionTenantSchema,
  rlsPolicySql,
  setTenantConfigSql,
  tenantConfigParams,
  tenantSchema,
  type SchemaProvisioner,
  type SchemaInspector,
} from '../src/index.js'

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

  /** pglite as a client that can both provision and read back, like PrismaClient. */
  const admin = (): SchemaProvisioner & SchemaInspector => ({
    async $executeRawUnsafe(query: string) {
      await db.exec(query)
      return 0
    },
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]) {
      const { rows } = await db.query<unknown>(query, values)
      return rows as T
    },
  })

  describe('countTenantTables', () => {
    it('counts the tenant\'s own tables against a real information_schema', async () => {
      const schema = tenantSchema('acme')
      await provisionTenantSchema(provisioner(), schema)
      await db.exec(`CREATE TABLE "${schema}".project (id text primary key)`)
      await db.exec(`CREATE TABLE "${schema}".invoice (id text primary key)`)

      expect(await countTenantTables(admin(), schema)).toBe(2)
    })

    it('does not count _prisma_migrations, which is what a no-op deploy leaves behind', async () => {
      const schema = tenantSchema('globex')
      await provisionTenantSchema(provisioner(), schema)
      await db.exec(`CREATE TABLE "${schema}"._prisma_migrations (id text primary key)`)

      expect(await countTenantTables(admin(), schema)).toBe(0)
    })

    it('does not count another tenant\'s tables', async () => {
      const acme = tenantSchema('acme')
      const globex = tenantSchema('globex')
      await provisionTenantSchema(provisioner(), acme)
      await provisionTenantSchema(provisioner(), globex)
      await db.exec(`CREATE TABLE "${acme}".project (id text primary key)`)

      expect(await countTenantTables(admin(), globex)).toBe(0)
    })
  })

  describe('migrateTenants verifyTables', () => {
    it('fails the tenant when a clean-exiting migration produced nothing', async () => {
      // Reproduces the real failure end to end: the migrator succeeds and
      // creates only Prisma's bookkeeping table, as `migrate deploy` does when
      // its migrations directory is empty.
      const provision = admin()
      const [result] = await migrateTenants({
        tenants: ['acme'],
        target: { mode: 'schema', url: 'postgresql://host/app', provision },
        migrate: async ({ schema }) => {
          await db.exec(`CREATE TABLE "${schema}"._prisma_migrations (id text primary key)`)
        },
      })

      expect(result?.ok).toBe(false)
      expect(result?.error).toContain('no tables')
    })

    it('passes the tenant when the migration created real tables', async () => {
      const provision = admin()
      const [result] = await migrateTenants({
        tenants: ['acme'],
        target: { mode: 'schema', url: 'postgresql://host/app', provision },
        migrate: async ({ schema }) => {
          await db.exec(`CREATE TABLE "${schema}"._prisma_migrations (id text primary key)`)
          await db.exec(`CREATE TABLE "${schema}".auth_users (id text primary key)`)
        },
      })

      expect(result?.ok).toBe(true)
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

  describe('RLS defense in depth — the database enforces isolation', () => {
    // Run as a NON-superuser: superusers bypass RLS regardless of policy.
    const asAppUser = async () => {
      await db.exec('CREATE ROLE app_user')
      await db.exec('GRANT SELECT, INSERT, UPDATE, DELETE ON project TO app_user')
      await db.exec('SET ROLE app_user')
    }

    it('a query with NO tenant predicate still only sees the active tenant, and cross-tenant writes are rejected', async () => {
      await db.exec('CREATE TABLE project (id text primary key, tenant_id text, name text)')
      await db.query("INSERT INTO project VALUES ('a','acme','A'),('b','globex','B'),('c','acme','C')")
      // Install RLS + the tenant-isolation policy exactly as a migration would.
      await db.exec(rlsPolicySql({ tables: ['project'] }))
      await asAppUser()

      // Active tenant = acme, for this transaction only (set_config is_local=true).
      await db.exec('BEGIN')
      await db.query(setTenantConfigSql(), tenantConfigParams('acme'))

      // NOTE: no WHERE tenant_id — the DB filters anyway. This is the whole point:
      // a raw query that forgets the predicate can't leak another tenant's rows.
      const seen = await db.query<{ name: string }>('SELECT name FROM project ORDER BY name')
      // A cross-tenant write is blocked by the policy's WITH CHECK.
      let writeRejected = false
      try {
        await db.query("INSERT INTO project VALUES ('x','globex','X')")
      } catch {
        writeRejected = true
      }
      await db.exec('ROLLBACK')
      await db.exec('RESET ROLE')

      expect(seen.rows.map((r) => r.name)).toEqual(['A', 'C'])
      expect(writeRejected).toBe(true)
    })

    it('fails closed: with no tenant set, the policy matches no rows', async () => {
      await db.exec('CREATE TABLE project (id text primary key, tenant_id text, name text)')
      await db.query("INSERT INTO project VALUES ('a','acme','A'),('b','globex','B')")
      await db.exec(rlsPolicySql({ tables: ['project'] }))
      await asAppUser()

      // No set_config at all → current_setting(..., true) is NULL → zero rows.
      const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM project')
      await db.exec('RESET ROLE')
      expect(Number(rows[0]?.n ?? -1)).toBe(0)
    })
  })

  describe('cross-tenant scan — sweeping every tenant under RLS', () => {
    // The reconciler's problem: with RLS the app role only ever sees one tenant,
    // so "which rows, anywhere, are stuck?" has no answer as an ordinary query.
    // crossTenantScanSql opens exactly one narrow, identifiers-only door.
    const seed = async () => {
      await db.exec(`
        CREATE TABLE jobs (
          id text primary key,
          tenant_id text,
          status text,
          payload text
        )`)
      await db.query(`INSERT INTO jobs VALUES
        ('j1','acme','PROCESSING','acme secret'),
        ('j2','acme','DONE','acme done'),
        ('j3','globex','PROCESSING','globex secret'),
        ('j4','initech','PROCESSING','initech secret')`)
      await db.exec(rlsPolicySql({ tables: ['jobs'] }))
      await db.exec('CREATE ROLE app_user')
      await db.exec('CREATE ROLE other_user')
      await db.exec('GRANT SELECT, UPDATE ON jobs TO app_user')
      await db.exec(
        crossTenantScanSql({
          name: 'stuck_jobs',
          table: 'jobs',
          columns: ['id'],
          where: `t."status" = 'PROCESSING'`,
          role: 'app_user',
          maxRows: 2,
        }),
      )
    }

    it('the generated function is accepted by PostgreSQL and returns identifiers for every tenant', async () => {
      await seed()
      await db.exec('SET ROLE app_user')

      // The app role cannot see across tenants on its own (RLS, no tenant set).
      const unscoped = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs')
      expect(Number(unscoped.rows[0]?.n ?? -1)).toBe(0)

      // …but the SECURITY DEFINER function does — identifiers only.
      const page = await db.query<Record<string, unknown>>('SELECT * FROM stuck_jobs($1, $2, $3)', [2, null, null])
      await db.exec('RESET ROLE')
      expect(page.rows.map((r) => [r['tenant_id'], r['id']])).toEqual([
        ['acme', 'j1'],
        ['globex', 'j3'],
      ])
      // no payload, no status — a caller cannot read tenant data through it
      expect(Object.keys(page.rows[0] ?? {}).sort()).toEqual(['id', 'tenant_id'])
    })

    it('caps the page size and resumes from the cursor', async () => {
      await seed()
      await db.exec('SET ROLE app_user')
      // asks for 1000, the function was generated with maxRows: 2
      const first = await db.query<Record<string, unknown>>('SELECT * FROM stuck_jobs($1, $2, $3)', [1000, null, null])
      const next = await db.query<Record<string, unknown>>('SELECT * FROM stuck_jobs($1, $2, $3)', [1000, 'globex', 'j3'])
      await db.exec('RESET ROLE')
      expect(first.rows).toHaveLength(2)
      expect(next.rows.map((r) => r['id'])).toEqual(['j4'])
    })

    it('runs with a pinned search_path, so it cannot be redirected at a table of the caller', async () => {
      await seed()
      const { rows } = await db.query<{ config: string[] | null }>(
        `SELECT proconfig AS config FROM pg_proc WHERE proname = 'stuck_jobs'`,
      )
      expect(rows[0]?.config).toEqual(['search_path=pg_catalog, public'])
      const meta = await db.query<{ definer: boolean; volatile: string; parallel: string }>(
        `SELECT prosecdef AS definer, provolatile AS volatile, proparallel AS parallel
           FROM pg_proc WHERE proname = 'stuck_jobs'`,
      )
      expect(meta.rows[0]).toMatchObject({ definer: true, volatile: 's', parallel: 's' })
    })

    it('only the granted role may execute it — EXECUTE is revoked from PUBLIC', async () => {
      await seed()
      await db.exec('SET ROLE other_user')
      let refused: string | undefined
      try {
        await db.query('SELECT * FROM stuck_jobs($1, $2, $3)', [2, null, null])
      } catch (error) {
        refused = (error as Error).message
      }
      await db.exec('RESET ROLE')
      expect(refused).toMatch(/permission denied/i)
    })

    it('the identifiers it hands back are processed under the row\'s own tenant scope', async () => {
      await seed()
      await db.exec('SET ROLE app_user')
      const { rows } = await db.query<Record<string, string>>('SELECT * FROM stuck_jobs($1, $2, $3)', [2, null, null])

      // What crossTenantSweep does per tenant: enter the tenant, then work
      // through the ordinary (RLS-filtered) path.
      for (const row of rows) {
        await db.exec('BEGIN')
        await db.query(setTenantConfigSql(), tenantConfigParams(row['tenant_id'] as string))
        await db.query(`UPDATE jobs SET status = 'RETRIED' WHERE id = $1`, [row['id']])
        await db.exec('COMMIT')
      }
      await db.exec('RESET ROLE')

      const { rows: after } = await db.query<{ id: string; status: string }>(
        'SELECT id, status FROM jobs ORDER BY id',
      )
      expect(after).toEqual([
        { id: 'j1', status: 'RETRIED' },
        { id: 'j2', status: 'DONE' },
        { id: 'j3', status: 'RETRIED' },
        { id: 'j4', status: 'PROCESSING' }, // beyond the capped page — next sweep
      ])
    })

    it('a tenant cannot use it to reach another tenant\'s data', async () => {
      await seed()
      await db.exec('SET ROLE app_user')
      await db.exec('BEGIN')
      await db.query(setTenantConfigSql(), tenantConfigParams('acme'))
      const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM stuck_jobs($1, $2, $3)', [2, null, null])
      // The identifiers of other tenants are visible (that is the point), but
      // joining them back to the table stays RLS-filtered to acme.
      const joined = await db.query<{ id: string }>(
        `SELECT j.id FROM jobs j WHERE j.id = ANY($1::text[]) ORDER BY j.id`,
        [rows.map((r) => r['id'])],
      )
      await db.exec('COMMIT')
      await db.exec('RESET ROLE')
      expect(rows.map((r) => r['tenant_id'])).toEqual(['acme', 'globex'])
      expect(joined.rows.map((r) => r.id)).toEqual(['j1'])
    })
  })
})
