import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import postgres from '@prisma/orm-postgres/runtime'
import { contractFromJson } from '@prisma/orm-postgres/static'
import { AndExpr, BinaryExpr, ColumnRef, ParamRef } from '@prisma/orm-postgres/relational-core/ast'
import type { Contract } from '../prisma/contract.js'
import contractJson from '../prisma/contract.json' with { type: 'json' }
import { databaseUrl, prisma, serverUrl } from './support/db.js'

// Prepared statements and includes on Prisma 8 RC, under a tenant-filter middleware and
// under RLS. Row-level tenancy in one shared table (public."Note" / public."NoteTag").
// Gated on TEST_DATABASE_URL.

const ROLE = 'p8_app'
type Db = ReturnType<typeof postgres<Contract>>

/** A tenant filter whose tenant is read from `current` when the query is COMPILED. */
const current = { tenant: 'acme' }
const tenantFilter = {
  familyId: 'sql' as const,
  async beforeCompile(draft: any) {
    const ast = draft.ast
    if (ast.kind !== 'select') return undefined
    const source = ast.from
    if (source?.kind !== 'table-source' || !['Note', 'NoteTag'].includes(source.name)) return undefined
    const own = BinaryExpr.eq(ColumnRef.of(source.alias ?? source.name, 'tenantId'), ParamRef.of(current.tenant, { codec: { codecId: 'pg/text@1' } }))
    return { ...draft, ast: ast.withWhere(ast.where ? AndExpr.of([ast.where, own]) : own) }
  },
}

function appUrl(): string {
  const url = new URL(databaseUrl())
  url.username = ROLE
  url.password = ROLE
  return url.toString()
}

async function asTenant<T>(db: Db, tenant: string, fn: (tx: any) => PromiseLike<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(tx.raw.sql`SELECT set_config('app.tenant_id', ${tenant}, true) AS v`.returnsRow({ v: 'pg/text@1' }).build())
    return await fn(tx)
  })
}

describe.skipIf(!serverUrl)('Prisma 8 RC: prepared statements and includes', () => {
  let admin: pg.Client

  beforeAll(async () => {
    expect((await prisma(['db', 'update', '--yes'])).ok).toBe(true) // NoteTag exists for this contract
    admin = new pg.Client({ connectionString: databaseUrl() })
    await admin.connect()
    await admin.query(`DELETE FROM public."NoteTag"`)
    await admin.query(`DELETE FROM public."Note"`)
    await admin.query(`INSERT INTO public."Note" (id, "tenantId", body) VALUES ('n-acme', 'acme', 'a'), ('n-globex', 'globex', 'g')`)
    // tg-x is globex's tag on acme's note: exactly what an include must not reveal to acme
    await admin.query(`INSERT INTO public."NoteTag" (id, "tenantId", label, "noteId") VALUES
      ('tg-a', 'acme', 'a', 'n-acme'), ('tg-x', 'globex', 'x', 'n-acme'), ('tg-g', 'globex', 'g', 'n-globex')`)
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`)
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
    for (const table of ['Note', 'NoteTag']) {
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public."${table}" TO ${ROLE}`)
      await admin.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`)
      await admin.query(`ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY`)
      await admin.query(`DROP POLICY IF EXISTS tenant_isolation ON public."${table}"`)
      await admin.query(`CREATE POLICY tenant_isolation ON public."${table}"
        USING ("tenantId" = current_setting('app.tenant_id', true))
        WITH CHECK ("tenantId" = current_setting('app.tenant_id', true))`)
    }
  })
  afterAll(async () => {
    await admin?.query(`DELETE FROM public."NoteTag"`)
    await admin?.query(`DELETE FROM public."Note"`)
    // leave both tables as the contract declares them (no undeclared policies for db update to drop)
    for (const table of ['Note', 'NoteTag']) {
      await admin?.query(`DROP POLICY IF EXISTS tenant_isolation ON public."${table}"`)
      await admin?.query(`ALTER TABLE public."${table}" NO FORCE ROW LEVEL SECURITY`)
      await admin?.query(`ALTER TABLE public."${table}" DISABLE ROW LEVEL SECURITY`)
    }
    await admin?.end()
  })

  it('include: the middleware filters the root rows but NOT the included ones (another tenant\'s tag shows)', async () => {
    current.tenant = 'acme'
    const db = postgres({ contract: contractFromJson<Contract>(contractJson as never), url: databaseUrl(), verifyMarker: false, middleware: [tenantFilter as never] })
    try {
      const notes = await db.orm.public.Note.include('tags').all()
      expect(notes.map((n) => n.id)).toEqual(['n-acme'])
      const tags = notes.flatMap((n) => (n as unknown as { tags: Array<{ id: string; tenantId: string }> }).tags)
      expect(tags.map((t) => t.tenantId).sort()).toEqual(['acme', 'globex']) // tg-x leaks
    } finally {
      await db.close()
    }
  })

  it('include: RLS filters the included rows too', async () => {
    const pool = new pg.Pool({ connectionString: appUrl(), max: 1 })
    const db = postgres({ contract: contractFromJson<Contract>(contractJson as never), pg: pool, verifyMarker: false })
    try {
      const notes = await asTenant<Array<{ id: string; tags: Array<{ id: string }> }>>(db, 'acme', (tx) => tx.orm.public.Note.include('tags').all())
      expect(notes.map((n: { id: string }) => n.id)).toEqual(['n-acme'])
      const tags = notes.flatMap((n: { tags: Array<{ id: string }> }) => n.tags.map((t) => t.id))
      expect(tags).toEqual(['tg-a'])
    } finally {
      await db.close()
      await pool.end()
    }
  })

  it('prepared statement: a middleware tenant filter is frozen when the statement is prepared', async () => {
    const db = postgres({ contract: contractFromJson<Contract>(contractJson as never), url: databaseUrl(), verifyMarker: false, middleware: [tenantFilter as never] })
    try {
      current.tenant = 'acme'
      const ps = await db.prepare({}, () => db.sql.public.Note.select('id', 'tenantId').build())
      expect((await ps.query(db.runtime(), {})).map((r) => r.id)).toEqual(['n-acme'])
      current.tenant = 'globex'
      // the request is now globex's, but the prepared statement still filters for acme
      expect((await ps.query(db.runtime(), {})).map((r) => r.id)).toEqual(['n-acme'])
      // an unprepared query compiles again and follows the current tenant
      expect((await db.query(db.sql.public.Note.select('id', 'tenantId').build())).map((r) => r.id)).toEqual(['n-globex'])
    } finally {
      await db.close()
    }
  })

  it('prepared statement: under RLS one statement serves every tenant correctly, checked at each execution', async () => {
    const pool = new pg.Pool({ connectionString: appUrl(), max: 1 })
    const db = postgres({ contract: contractFromJson<Contract>(contractJson as never), pg: pool, verifyMarker: false })
    try {
      const ps = await db.prepare({}, () => db.sql.public.Note.select('id', 'tenantId').build())
      const acme = await asTenant<Array<{ id: string }>>(db, 'acme', async (tx) => [...(await ps.query(tx, {}))])
      const globex = await asTenant<Array<{ id: string }>>(db, 'globex', async (tx) => [...(await ps.query(tx, {}))])
      expect(acme.map((r: { id: string }) => r.id)).toEqual(['n-acme'])
      expect(globex.map((r: { id: string }) => r.id)).toEqual(['n-globex'])
      expect(await ps.query(db.runtime(), {})).toEqual([]) // no tenant: nothing
    } finally {
      await db.close()
      await pool.end()
    }
  })
})
