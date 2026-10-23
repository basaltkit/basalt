import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import postgres from '@prisma/orm-postgres/runtime'
import { contractFromJson } from '@prisma/orm-postgres/static'
import type { Contract } from '../prisma/contract.js'
import contractJson from '../prisma/contract.json' with { type: 'json' }
import { databaseUrl, serverUrl } from './support/db.js'
import { sqlState } from './support/tenants.js'

// Row-Level Security on Prisma 8 RC, the pattern Prisma documents
// (contract-authoring/advanced-postgresql): the app connects as a role that is not the
// table owner, a policy compares the row's tenant with a setting, and the setting is
// set with set_config(…, true) INSIDE a transaction, so it ends with it.
// Gated on TEST_DATABASE_URL.

const ROLE = 'p8_app'
type Db = ReturnType<typeof postgres<Contract>>

function appUrl(): string {
  const url = new URL(databaseUrl())
  url.username = ROLE
  url.password = ROLE
  return url.toString()
}

/** Runs `fn` in a transaction whose tenant setting is `tenant`, the way the RLS policy expects. */
async function asTenant<T>(db: Db, tenant: string, fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(tx.raw.sql`SELECT set_config('app.tenant_id', ${tenant}, true) AS v`.returnsRow({ v: 'pg/text@1' }).build())
    return fn(tx)
  })
}

describe.skipIf(!serverUrl)('Prisma 8 RC: row-level security', () => {
  let admin: pg.Client
  let pool: pg.Pool
  let db: Db

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl() })
    await admin.connect()
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`)
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public."Note" TO ${ROLE}`)
    await admin.query(`ALTER TABLE public."Note" ENABLE ROW LEVEL SECURITY`)
    await admin.query(`ALTER TABLE public."Note" FORCE ROW LEVEL SECURITY`)
    await admin.query(`DROP POLICY IF EXISTS tenant_isolation ON public."Note"`)
    await admin.query(`CREATE POLICY tenant_isolation ON public."Note"
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true))`)
    await admin.query(`DELETE FROM public."Note"`)
    await admin.query(`INSERT INTO public."Note" (id, "tenantId", body) VALUES
      ('acme-1', 'acme', 'a1'), ('acme-2', 'acme', 'a2'), ('globex-1', 'globex', 'g1')`)
    // max: 1 — every query below reuses the SAME connection, so a leaked setting would show.
    pool = new pg.Pool({ connectionString: appUrl(), max: 1 })
    db = postgres({ contract: contractFromJson<Contract>(contractJson as never), pg: pool, verifyMarker: false })
  })
  afterAll(async () => {
    await db?.close()
    await pool?.end()
    await admin?.end()
  })

  it('sees nothing and writes nothing without a tenant', async () => {
    expect(await db.orm.public.Note.all()).toEqual([])
    let error: unknown
    try {
      await db.orm.public.Note.create({ id: 'x', tenantId: 'acme', body: 'no tenant' })
    } catch (e) {
      error = e
    }
    expect(sqlState(error)).toBe('42501') // new row violates row-level security policy
  })

  it('sees and writes only its own rows inside a transaction with the tenant set', async () => {
    const ids = await asTenant(db, 'acme', async (tx) => {
      await tx.orm.public.Note.create({ id: 'acme-3', tenantId: 'acme', body: 'a3' })
      return (await tx.orm.public.Note.all()).map((n) => n.id).sort()
    })
    expect(ids).toEqual(['acme-1', 'acme-2', 'acme-3'])
    let error: unknown
    try {
      await asTenant(db, 'acme', (tx) => tx.orm.public.Note.create({ id: 'smuggled', tenantId: 'globex', body: 'cross-tenant write' }))
    } catch (e) {
      error = e
    }
    expect(sqlState(error)).toBe('42501') // WITH CHECK refuses a row for another tenant
  })

  it('does not leak the tenant to the next query on the same connection', async () => {
    await asTenant(db, 'acme', async (tx) => tx.orm.public.Note.all())
    expect(await db.orm.public.Note.all()).toEqual([])
  })

  it('resets the tenant when a transaction fails, and the next tenant sees only its rows', async () => {
    await expect(
      asTenant(db, 'acme', async (tx) => {
        await tx.orm.public.Note.all()
        throw new Error('handler failed')
      }),
    ).rejects.toThrow('handler failed')
    expect(await db.orm.public.Note.all()).toEqual([])
    const globex = await asTenant(db, 'globex', async (tx) => (await tx.orm.public.Note.all()).map((n) => n.id))
    expect(globex).toEqual(['globex-1'])
  })

  it('keeps concurrent tenants apart on a shared pool', async () => {
    const shared = new pg.Pool({ connectionString: appUrl(), max: 2 })
    const two = postgres({ contract: contractFromJson<Contract>(contractJson as never), pg: shared, verifyMarker: false })
    try {
      const [acme, globex] = await Promise.all(
        ['acme', 'globex'].map((tenant) =>
          asTenant(two, tenant, async (tx) => {
            await new Promise((r) => setTimeout(r, 30))
            return (await tx.orm.public.Note.all()).map((n) => n.tenantId)
          }),
        ),
      )
      expect(new Set(acme)).toEqual(new Set(['acme']))
      expect(new Set(globex)).toEqual(new Set(['globex']))
    } finally {
      await two.close()
      await shared.end()
    }
  })

  it('shows the risk the pattern avoids: a SESSION-level setting outlives the request', async () => {
    // set_config(…, false) is what a per-request "SET" without a transaction amounts to.
    await db.query(db.raw.sql`SELECT set_config('app.tenant_id', ${'acme'}, false) AS v`.returnsRow({ v: 'pg/text@1' }).build())
    try {
      // a later query with NO tenant context, on the same pooled connection, sees acme's rows
      const leaked = await db.orm.public.Note.all()
      expect(leaked.length).toBeGreaterThan(0)
      expect(new Set(leaked.map((n) => n.tenantId))).toEqual(new Set(['acme']))
    } finally {
      await db.query(db.raw.sql`SELECT set_config('app.tenant_id', '', false) AS v`.returnsRow({ v: 'pg/text@1' }).build())
    }
    expect(await db.orm.public.Note.all()).toEqual([])
  })
})
