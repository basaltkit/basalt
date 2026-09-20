import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { PrismaPg } from '@prisma/adapter-pg'
import {
  crossTenantScan,
  crossTenantScanSql,
  crossTenantSweep,
  rlsPolicySql,
  tenancyExtension,
  type CrossTenantScanRow,
} from '@basaltkit/prisma'

// Cross-tenant sweeps against real PostgreSQL row-level security.
// Gated on TEST_DATABASE_URL — skips (keeping the default suite green) when unset.
//
// The situation this reproduces: a reconciler must find every job left in
// PROCESSING, across all tenants, while the application role is RLS-filtered to
// one tenant at a time. crossTenantScanSql installs the one narrow door — a
// SECURITY DEFINER function returning identifiers only — and crossTenantSweep
// processes each identifier back inside its own tenant's scope.
const url = process.env['TEST_DATABASE_URL']

const APP_ROLE = 'basalt_rls_app'
const APP_PASSWORD = 'basalt_rls_app'
// A second login role, granted the table but NOT the function.
const OTHER_ROLE = 'basalt_scan_other'
const OTHER_PASSWORD = 'basalt_scan_other'
const SCAN = 'rls_stuck_jobs'
const LEAKY_SCAN = 'rls_leaky_jobs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

const asTenant = <T>(id: string, op: () => Promise<T>): Promise<T> =>
  runWithContext({ tenant: { id } }, async () => await op())

/**
 * DDL with a retry. Test files run concurrently and this one touches catalog
 * rows another file also touches (the login role, the grant on schema public);
 * PostgreSQL answers a genuine race with "tuple concurrently updated".
 */
const ddl = async (client: Client, sql: string): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.$executeRawUnsafe(sql)
      return
    } catch (error) {
      const message = String((error as Error).message)
      const racy = /tuple concurrently updated|already exists|duplicate key/i.test(message)
      if (!racy || attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

const exec = async (client: Client, sql: string): Promise<void> => {
  // Prisma sends one statement per call: run generated migrations piecewise.
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await ddl(client, statement)
  }
}

describe.skipIf(!url)('cross-tenant scan against real PostgreSQL RLS', () => {
  let admin: Client // superuser: seeding + the migration (RLS never applies to it)
  let appBase: Client // the application role: RLS applies, EXECUTE granted
  let db: Client // appBase + tenancyExtension({ rls: true })
  let other: Client // a login role WITHOUT execute on the scan function

  beforeAll(async () => {
    const clientModule: string = '../generated/client/index.js'
    const { PrismaClient } = (await import(clientModule)) as { PrismaClient: new (opts?: unknown) => Client }
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

    for (const [role, password] of [
      [APP_ROLE, APP_PASSWORD],
      [OTHER_ROLE, OTHER_PASSWORD],
    ]) {
      await ddl(admin, `
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
          END IF;
        END $$`)
      await ddl(admin, `GRANT USAGE ON SCHEMA public TO ${role}`)
      await ddl(admin, `GRANT SELECT, INSERT, UPDATE, DELETE ON rls_jobs TO ${role}`)
    }

    await exec(admin, rlsPolicySql({ tables: ['rls_jobs'], tenantColumn: 'tenantId' }))
    // The migration a real deployment ships: the scan function, owned by the
    // migration role (a superuser here, i.e. not subject to the policies), with
    // EXECUTE granted to the application role only.
    await exec(
      admin,
      crossTenantScanSql({
        name: SCAN,
        table: 'rls_jobs',
        tenantColumn: 'tenantId',
        columns: ['id'],
        where: `t."status" = 'PROCESSING'`,
        role: APP_ROLE,
        maxRows: 100,
      }),
    )
    // A hand-written function that ALSO returns tenant data — what the runtime
    // shape guard exists to catch (a function edited after the fact).
    await ddl(admin, `DROP FUNCTION IF EXISTS "${LEAKY_SCAN}"(integer, text, text)`)
    await ddl(admin, `
      CREATE FUNCTION "${LEAKY_SCAN}"(p_limit integer DEFAULT 100, p_after_tenant text DEFAULT NULL, p_after_id text DEFAULT NULL)
      RETURNS TABLE ("tenant_id" text, "id" text, "payload" text)
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $leaky$
        SELECT t."tenantId", t."id", t."payload" FROM public."rls_jobs" AS t ORDER BY t."tenantId", t."id" LIMIT p_limit
      $leaky$`)
    await ddl(admin, `GRANT EXECUTE ON FUNCTION "${LEAKY_SCAN}"(integer, text, text) TO ${APP_ROLE}`)

    const connect = (role: string, password: string): Client => {
      const roleUrl = new URL(url!)
      roleUrl.username = role
      roleUrl.password = password
      // max: 1 — one pooled connection, so a leaked tenant setting is observable.
      return new PrismaClient({ adapter: new PrismaPg({ connectionString: roleUrl.toString(), max: 1 }) })
    }
    appBase = connect(APP_ROLE, APP_PASSWORD)
    other = connect(OTHER_ROLE, OTHER_PASSWORD)
    db = appBase.$extends(tenancyExtension({ rls: true }))
  })

  afterAll(async () => {
    await other?.$disconnect()
    await appBase?.$disconnect()
    await admin?.$disconnect()
  })

  beforeEach(async () => {
    await admin.rlsJob.deleteMany()
    await admin.rlsJob.createMany({
      data: [
        { id: 'j-acme-1', tenantId: 'acme', status: 'PROCESSING', payload: 'acme secret 1' },
        { id: 'j-acme-2', tenantId: 'acme', status: 'DONE', payload: 'acme secret 2' },
        { id: 'j-globex-1', tenantId: 'globex', status: 'PROCESSING', payload: 'globex secret' },
        { id: 'j-initech-1', tenantId: 'initech', status: 'PROCESSING', payload: 'initech secret' },
      ],
    })
  })

  it('with RLS on, the application role sees nothing unscoped — the sweep is impossible as a query', async () => {
    const rows: Array<{ n: bigint }> = await appBase.$queryRawUnsafe('SELECT count(*) AS n FROM rls_jobs')
    expect(Number(rows[0]?.n ?? -1)).toBe(0)
    // and the extension refuses an unscoped model query outright
    await expect(db.rlsJob.findMany()).rejects.toMatchObject({ code: 'PRISMA_TENANT_MISSING' })
  })

  it('the SECURITY DEFINER function returns identifiers for every tenant', async () => {
    const found = await crossTenantScan(appBase, SCAN)
    expect(found).toEqual([
      { tenantId: 'acme', id: 'j-acme-1' },
      { tenantId: 'globex', id: 'j-globex-1' },
      { tenantId: 'initech', id: 'j-initech-1' },
    ])
    // identifiers ONLY: no payload, no status
    expect(Object.keys(found[0] as CrossTenantScanRow).sort()).toEqual(['id', 'tenantId'])
  })

  it('pages with the cursor and clamps the limit to the function\'s cap', async () => {
    const first = await crossTenantScan(appBase, SCAN, { limit: 2 })
    expect(first.map((r) => r.id)).toEqual(['j-acme-1', 'j-globex-1'])
    const next = await crossTenantScan(appBase, SCAN, { limit: 2, after: first[1] as CrossTenantScanRow })
    expect(next.map((r) => r.id)).toEqual(['j-initech-1'])
  })

  it('the grouped sweep processes each row under its own tenant scope and can update it', async () => {
    const tenantsEntered: string[] = []
    const result = await crossTenantSweep({
      client: appBase,
      scanFunction: SCAN,
      limit: 2,
      run: async (tenantId, fn) => {
        tenantsEntered.push(tenantId)
        await asTenant(tenantId, fn)
      },
      handle: async (item, tenantId) => {
        // Inside the tenant's scope: the ordinary scoped + RLS-filtered client.
        const job = await db.rlsJob.findUnique({ where: { id: item.id } })
        expect(job.tenantId).toBe(tenantId)
        await db.rlsJob.update({ where: { id: item.id }, data: { status: 'RETRIED' } })
      },
    })

    expect(tenantsEntered).toEqual(['acme', 'globex', 'initech'])
    expect(result).toMatchObject({ found: 3, processed: 3, failed: 0, tenants: 3, truncated: false })
    const after = await admin.rlsJob.findMany({ orderBy: { id: 'asc' } })
    expect(after.map((j: { id: string; status: string }) => [j.id, j.status])).toEqual([
      ['j-acme-1', 'RETRIED'],
      ['j-acme-2', 'DONE'],
      ['j-globex-1', 'RETRIED'],
      ['j-initech-1', 'RETRIED'],
    ])
  })

  it('the sweep cannot be started from inside a tenant context', async () => {
    await expect(
      asTenant('acme', () =>
        crossTenantSweep({ client: appBase, scanFunction: SCAN, handle: () => {} }),
      ),
    ).rejects.toMatchObject({ code: 'PRISMA_CROSS_TENANT_IN_TENANT' })
    await expect(asTenant('acme', () => crossTenantScan(appBase, SCAN))).rejects.toMatchObject({
      code: 'PRISMA_CROSS_TENANT_IN_TENANT',
    })
  })

  it('a role without the grant cannot execute the function', async () => {
    await expect(crossTenantScan(other, SCAN)).rejects.toThrow(/permission denied/i)
    // …and it is no better off going through the table: RLS still applies
    const rows: Array<{ n: bigint }> = await other.$queryRawUnsafe('SELECT count(*) AS n FROM rls_jobs')
    expect(Number(rows[0]?.n ?? -1)).toBe(0)
  })

  it('the function cannot be used to read tenant data', async () => {
    const found = await crossTenantScan(appBase, SCAN)
    const foreign = found.find((r) => r.tenantId === 'globex') as CrossTenantScanRow
    // Knowing another tenant's row id buys nothing: inside acme's scope the row
    // is not there, and outside a tenant the client is refused.
    expect(await asTenant('acme', () => db.rlsJob.findUnique({ where: { id: foreign.id } }))).toBeNull()
    await expect(asTenant('acme', () => db.$queryRawUnsafe('SELECT payload FROM rls_jobs'))).rejects.toMatchObject({
      code: 'PRISMA_RAW_IN_TENANT',
    })
  })

  it('refuses a scan function that was widened to return tenant data', async () => {
    await expect(crossTenantScan(appBase, LEAKY_SCAN)).rejects.toMatchObject({
      code: 'PRISMA_CROSS_TENANT_SCAN_SHAPE',
    })
    // …unless the caller declares that column as an identifier it expects
    const rows = await crossTenantScan(appBase, LEAKY_SCAN, { columns: ['payload'] })
    expect(rows[0]).toMatchObject({ tenantId: 'acme', payload: 'acme secret 1' })
  })

  it('without RLS the same sweep works as a plain central query — no SQL function needed', async () => {
    // `admin` is a superuser: no policy applies to it, which is what a
    // deployment without RLS looks like. Only the page source changes.
    const processed: Array<[string, string]> = []
    const result = await crossTenantSweep({
      scan: async ({ limit, after }) => {
        const rows = await admin.rlsJob.findMany({
          where: {
            status: 'PROCESSING',
            ...(after
              ? {
                  OR: [
                    { tenantId: { gt: after.tenantId } },
                    { tenantId: after.tenantId, id: { gt: after.id } },
                  ],
                }
              : {}),
          },
          select: { tenantId: true, id: true },
          orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
          take: limit,
        })
        return rows as CrossTenantScanRow[]
      },
      limit: 2,
      run: (tenantId, fn) => asTenant(tenantId, fn),
      handle: (item, tenantId) => {
        processed.push([tenantId, item.id])
      },
    })
    expect(processed).toEqual([
      ['acme', 'j-acme-1'],
      ['globex', 'j-globex-1'],
      ['initech', 'j-initech-1'],
    ])
    expect(result).toMatchObject({ found: 3, processed: 3, pages: 2, tenants: 3 })
  })
})
