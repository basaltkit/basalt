import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import postgres from '@prisma/orm-postgres/runtime'
import { contractFromJson } from '@prisma/orm-postgres/static'
import type { Contract } from '../prisma/contract.js'
import contractJson from '../prisma/contract.json' with { type: 'json' }
import { databaseUrl, serverUrl } from './support/db.js'
import { contractForSchema, provisionTenants, sqlState, tenantConnectionString } from './support/tenants.js'

// Tenant isolation on Prisma 8 RC with one client per tenant schema: concurrent
// writes, model queries, raw SQL, transactions and errors. Gated on TEST_DATABASE_URL.

const A = 'tenant_iso_a'
const B = 'tenant_iso_b'
type Db = ReturnType<typeof postgres<Contract>>

/** A tenant's client: the contract routes the ORM, the connection's search_path routes raw SQL. */
const tenantDb = (schema: string): Db =>
  postgres({ contract: contractFromJson<Contract>(contractForSchema(contractJson, schema) as never), url: tenantConnectionString(databaseUrl(), schema), verifyMarker: false })

describe.skipIf(!serverUrl)('Prisma 8 RC: isolation between tenant schemas', () => {
  let admin: pg.Client
  let a: Db
  let b: Db
  const ids = async (schema: string) =>
    (await admin.query(`SELECT id FROM "${schema}"."Project" ORDER BY id`)).rows.map((r: { id: string }) => r.id)

  beforeAll(async () => {
    await provisionTenants([A, B])
    admin = new pg.Client({ connectionString: databaseUrl() })
    await admin.connect()
    a = tenantDb(A)
    b = tenantDb(B)
  })
  afterAll(async () => {
    await a?.close()
    await b?.close()
    await admin?.end()
  })

  it('keeps concurrent writes of two tenants in their own schemas', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => [
        a.orm.public.Project.create({ id: `a-${String(i).padStart(2, '0')}`, tenantId: A, name: `a ${i}` }),
        b.orm.public.Project.create({ id: `b-${String(i).padStart(2, '0')}`, tenantId: B, name: `b ${i}` }),
      ]).flat(),
    )
    expect((await ids(A)).every((id) => id.startsWith('a-'))).toBe(true)
    expect((await ids(B)).every((id) => id.startsWith('b-'))).toBe(true)
    expect(await ids(A)).toHaveLength(25)
    expect(await ids(B)).toHaveLength(25)
    expect((await admin.query(`SELECT count(*)::int AS n FROM public."Project" WHERE id LIKE 'a-%' OR id LIKE 'b-%'`)).rows[0].n).toBe(0)
  })

  it('reads only its own rows through the model API', async () => {
    const rowsA = await a.orm.public.Project.all()
    const rowsB = await b.orm.public.Project.where({ tenantId: B }).all()
    expect(rowsA.every((r) => r.tenantId === A)).toBe(true)
    expect(rowsB).toHaveLength(25)
    expect(await a.orm.public.Project.where({ id: 'b-00' }).first()).toBeNull()
  })

  it('runs raw SQL in the tenant schema only because the connection search_path says so', async () => {
    const count = (c: Db) => c.raw.sql`SELECT count(*)::int AS n, current_schema() AS s FROM "Project"`.returnsRow({ n: 'pg/int4@1', s: 'pg/text@1' }).build()
    const [rowA] = await a.query(count(a))
    expect(rowA).toEqual({ n: 25, s: A })
    // the same contract-routed client WITHOUT the search_path: raw SQL silently reads public
    const bare = postgres({ contract: contractFromJson<Contract>(contractForSchema(contractJson, A) as never), url: databaseUrl(), verifyMarker: false })
    try {
      const [row] = await bare.query(count(bare))
      expect(row!.s).toBe('public')
    } finally {
      await bare.close()
    }
  })

  it('rolls back a failed transaction in one tenant without touching the other', async () => {
    await expect(
      a.transaction(async (tx) => {
        await tx.orm.public.Project.create({ id: 'a-tx', tenantId: A, name: 'in tx' })
        await tx.execute(tx.raw.sql`UPDATE "Project" SET name = 'changed in tx' WHERE id = 'a-00'`.affectedCount().build())
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    await b.transaction(async (tx) => {
      await tx.orm.public.Project.create({ id: 'b-tx', tenantId: B, name: 'committed' })
    })
    expect(await ids(A)).not.toContain('a-tx')
    expect((await admin.query(`SELECT name FROM "${A}"."Project" WHERE id = 'a-00'`)).rows[0].name).toBe('a 0')
    expect(await ids(B)).toContain('b-tx')
  })

  it('surfaces a constraint error from one tenant as SQLSTATE 23505, and both keep working', async () => {
    let error: unknown
    try {
      await a.orm.public.Project.create({ id: 'a-00', tenantId: A, name: 'duplicate' })
    } catch (e) {
      error = e
    }
    expect(sqlState(error)).toBe('23505')
    // the same id is free in the other tenant: uniqueness is per schema
    await b.orm.public.Project.create({ id: 'a-00', tenantId: B, name: 'not a duplicate here' })
    await a.orm.public.Project.create({ id: 'a-after-error', tenantId: A, name: 'still fine' })
    expect(await ids(A)).toContain('a-after-error')
    expect(await ids(B)).toContain('a-00')
  })

  it('isolates concurrent transactions: one tenant failing does not abort the other', async () => {
    const results = await Promise.allSettled([
      a.transaction(async (tx) => {
        await tx.orm.public.Project.create({ id: 'a-conc', tenantId: A, name: 'a' })
        await new Promise((r) => setTimeout(r, 50))
        throw new Error('a fails')
      }),
      b.transaction(async (tx) => {
        await tx.orm.public.Project.create({ id: 'b-conc', tenantId: B, name: 'b' })
        await new Promise((r) => setTimeout(r, 50))
      }),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(await ids(A)).not.toContain('a-conc')
    expect(await ids(B)).toContain('b-conc')
  })
})
