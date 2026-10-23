import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import postgres from '@prisma/orm-postgres/runtime'
import { contractFromJson } from '@prisma/orm-postgres/static'
import type { Contract } from '../prisma/contract.js'
import contractJson from '../prisma/contract.json' with { type: 'json' }
import { databaseUrl, planSql, prisma, serverUrl } from './support/db.js'
import { contractForSchema, writeTenantContract } from './support/tenants.js'

// Schema-per-tenant on Prisma 8 (release candidate), against real PostgreSQL.
// What a Basalt Prisma 8 integration will rest on: one typed client per tenant
// schema, and per-tenant migrations through `prisma db update`. A failure here
// after a new RC means Prisma changed something this design depends on.
// Gated on TEST_DATABASE_URL — skips when unset.

const TENANTS = ['tenant_acme', 'tenant_globex'] as const
const typed = (json: unknown) => contractFromJson<Contract>(json as never)

describe.skipIf(!serverUrl)('Prisma 8 RC: schema per tenant', () => {
  let admin: pg.Client
  const count = async (schema: string) =>
    Number((await admin.query(`SELECT count(*)::int AS n FROM "${schema}"."Project"`)).rows[0].n)
  const columns = async (schema: string) =>
    (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Project' ORDER BY 1`, [schema]))
      .rows.map((r: { column_name: string }) => r.column_name)

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl() })
    await admin.connect()
  })
  afterAll(async () => {
    await admin?.end()
  })

  it('provisions each tenant schema with `db update` on a generated namespace contract', async () => {
    for (const schema of TENANTS) {
      const config = await writeTenantContract(schema)
      expect((await prisma(['contract', 'emit'], { config })).ok).toBe(true)
      const dry = await prisma(['db', 'update', '--dry-run'], { config })
      const sql = planSql(dry).join('\n')
      expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      expect(sql).toContain(`CREATE TABLE "${schema}"."Project"`)
      expect(sql).not.toContain('"public"')
      expect((await prisma(['db', 'update', '--yes'], { config })).ok).toBe(true)
      expect(await columns(schema)).toEqual(['createdAt', 'id', 'name', 'tenantId'])
    }
  })

  it('routes one typed client per tenant to its own schema, and nothing to public', async () => {
    for (const schema of TENANTS) {
      const db = postgres({ contract: typed(contractForSchema(contractJson, schema)), url: databaseUrl(), verifyMarker: false })
      try {
        await db.orm.public.Project.create({ id: `${schema}-1`, tenantId: schema, name: `first of ${schema}` })
        const rows = await db.orm.public.Project.all()
        expect(rows.map((r) => r.id)).toEqual([`${schema}-1`])
      } finally {
        await db.close()
      }
    }
    expect(await count('tenant_acme')).toBe(1)
    expect(await count('tenant_globex')).toBe(1)
    expect(await count('public')).toBe(0)
  })

  it('records the RC behaviour: the ORM qualifies its SQL, so a connection search_path does not choose the schema', async () => {
    // If this starts failing, Prisma began honouring search_path: good news, and
    // pgSchemaClient's approach would apply to Prisma 8 queries too.
    const pool = new pg.Pool({ connectionString: databaseUrl(), options: '-c search_path=tenant_acme,public' })
    const db = postgres({ contract: typed(contractJson), pg: pool, verifyMarker: false })
    try {
      await db.orm.public.Project.create({ id: 'search-path-probe', tenantId: 'probe', name: 'probe' })
    } finally {
      await db.close()
      await pool.end()
    }
    expect(await count('public')).toBe(1)
    expect(await count('tenant_acme')).toBe(1)
    await admin.query(`DELETE FROM public."Project" WHERE id = 'search-path-probe'`)
  })

  it('evolves one tenant schema without touching the others', async () => {
    const config = await writeTenantContract('tenant_acme', ['status String?'])
    expect((await prisma(['contract', 'emit'], { config })).ok).toBe(true)
    const dry = await prisma(['db', 'update', '--dry-run'], { config })
    expect(planSql(dry)).toEqual([`ALTER TABLE "tenant_acme"."Project" ADD COLUMN "status" text`])
    expect((await prisma(['db', 'update', '--yes'], { config })).ok).toBe(true)
    expect(await columns('tenant_acme')).toContain('status')
    expect(await columns('tenant_globex')).not.toContain('status')
    expect(await count('tenant_acme')).toBe(1)
  })

  it('restores the central marker: updating the central plane last plans nothing and keeps every tenant', async () => {
    const before = (await admin.query(`SELECT core_hash FROM prisma_contract.marker WHERE space = 'app'`)).rows[0]?.core_hash
    const dry = await prisma(['db', 'update', '--dry-run'])
    expect(dry.result?.plan?.operations ?? []).toEqual([])
    expect((await prisma(['db', 'update', '--yes'])).ok).toBe(true)
    const after = (await admin.query(`SELECT core_hash FROM prisma_contract.marker WHERE space = 'app'`)).rows[0]?.core_hash
    expect(after).not.toBe(before) // the last tenant update had left its own hash there
    expect(await count('tenant_acme')).toBe(1)
    expect(await count('tenant_globex')).toBe(1)
    // the central client verifies the marker again
    const central = postgres({ contract: typed(contractJson), url: databaseUrl() })
    try {
      expect(await central.orm.public.Project.all()).toEqual([])
    } finally {
      await central.close()
    }
  })
})
