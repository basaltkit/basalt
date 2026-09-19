import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { PrismaPg } from '@prisma/adapter-pg'
import {
  rlsPolicySql,
  setTenantConfigSql,
  tenancyExtension,
  tenantConfigParams,
  tenantTransaction,
} from '@basaltkit/prisma'

// tenancyExtension({ rls: true }) against real PostgreSQL row-level security.
// Gated on TEST_DATABASE_URL — skips (keeping the default suite green) when unset.
//
// RLS does not apply to superusers, and applies to a table's owner only with
// FORCE ROW LEVEL SECURITY. TEST_DATABASE_URL is usually a superuser, so the
// suite provisions a plain LOGIN role and runs the application client as it —
// the setup a real deployment should have (the app never connects as a
// superuser). The superuser client is kept for seeding and for the baseline.
const url = process.env['TEST_DATABASE_URL']

const APP_ROLE = 'basalt_rls_app'
const APP_PASSWORD = 'basalt_rls_app'
const TABLES = ['rls_projects', 'rls_tasks']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

const asTenant = (id: string, op: () => Promise<Client>): Promise<Client> =>
  runWithContext({ tenant: { id } }, async () => await op())

describe.skipIf(!url)('tenancyExtension({ rls: true }) against real PostgreSQL RLS', () => {
  let admin: Client // superuser: seeding + baseline (RLS never applies to it)
  let appBase: Client // non-superuser role: RLS applies
  let db: Client // appBase + tenancyExtension({ rls: true })

  beforeAll(async () => {
    const clientModule: string = '../generated/client/index.js'
    const { PrismaClient } = (await import(clientModule)) as { PrismaClient: new (opts?: unknown) => Client }
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

    await admin.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$`)
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`)
    await admin.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLES.join(', ')} TO ${APP_ROLE}`,
    )
    // Prisma sends one statement per call: run the generated migration piecewise.
    const migration = rlsPolicySql({ tables: TABLES, tenantColumn: 'tenantId' })
    for (const statement of migration.split(';').map((s) => s.trim()).filter(Boolean)) {
      await admin.$executeRawUnsafe(statement)
    }

    const appUrl = new URL(url!)
    appUrl.username = APP_ROLE
    appUrl.password = APP_PASSWORD
    // max: 1 — every statement reuses ONE pooled connection, so a tenant
    // setting that leaked past its transaction would be observable.
    appBase = new PrismaClient({ adapter: new PrismaPg({ connectionString: appUrl.toString(), max: 1 }) })
    db = appBase.$extends(tenancyExtension({ rls: true }))
  })

  afterAll(async () => {
    await appBase?.$disconnect()
    await admin?.$disconnect()
  })

  beforeEach(async () => {
    await admin.rlsTask.deleteMany()
    await admin.rlsProject.deleteMany()
    await admin.rlsProject.createMany({
      data: [
        { id: 'p-acme', tenantId: 'acme', name: 'Acme Project' },
        { id: 'p-globex', tenantId: 'globex', name: 'Globex Secret' },
      ],
    })
    // The F04 residual: an acme task whose plain foreign-key SCALAR points at
    // globex's project. The application-layer scoping cannot see this.
    await admin.rlsTask.create({
      data: { id: 't-acme', tenantId: 'acme', title: 'Acme task', projectId: 'p-globex' },
    })
  })

  it('baseline: without RLS, an include follows a cross-tenant foreign key', async () => {
    const scopedOnly = admin.$extends(tenancyExtension())
    const tasks = await asTenant('acme', () => scopedOnly.rlsTask.findMany({ include: { project: true } }))
    expect(tasks[0].project?.name).toBe('Globex Secret') // the leak RLS closes
  })

  it('rls: true — the same include no longer reaches the other tenant', async () => {
    const tasks = await asTenant('acme', () => db.rlsTask.findMany({ include: { project: true } }))
    expect(tasks).toHaveLength(1)
    expect(tasks[0].project).toBeNull()
  })

  it('rls: true — reads and writes work, each tenant only sees its own rows', async () => {
    await asTenant('acme', () => db.rlsProject.create({ data: { id: 'p-acme-2', name: 'Second' } }))
    await asTenant('acme', () => db.rlsProject.update({ where: { id: 'p-acme' }, data: { name: 'Renamed' } }))
    const acme = await asTenant('acme', () => db.rlsProject.findMany({ orderBy: { id: 'asc' } }))
    expect(acme.map((p: { name: string }) => p.name)).toEqual(['Renamed', 'Second'])
    expect(await asTenant('globex', () => db.rlsProject.count())).toBe(1)
    await asTenant('acme', () => db.rlsProject.delete({ where: { id: 'p-acme-2' } }))
    expect(await asTenant('acme', () => db.rlsProject.count())).toBe(1)
  })

  it('without set_config the app role sees nothing (fail closed), so RLS is really in force', async () => {
    const scopedOnly = appBase.$extends(tenancyExtension())
    expect(await asTenant('acme', () => scopedOnly.rlsProject.count())).toBe(0)
  })

  it('the tenant setting is transaction-local — it never leaks onto the pooled connection', async () => {
    await asTenant('acme', () => db.rlsProject.findMany())
    // same single pooled connection, outside any tenant context
    const [row] = await appBase.$queryRawUnsafe(`SELECT current_setting('app.tenant_id', true) AS tenant`)
    expect(row.tenant ?? '').toBe('')
  })

  it('tenantTransaction: interactive writes work and tx stays tenant-scoped', async () => {
    const tasks = await asTenant('acme', () =>
      tenantTransaction(db, async (tx: Client) => {
        await tx.rlsProject.create({ data: { id: 'p-acme-tx', name: 'From tx' } })
        await tx.rlsTask.create({ data: { id: 't-acme-tx', title: 'Tx task', projectId: 'p-acme-tx' } })
        return tx.rlsTask.findMany({ include: { project: true }, orderBy: { id: 'asc' } })
      }),
    )
    expect(tasks.map((t: { id: string; project: { name: string } | null }) => [t.id, t.project?.name ?? null])).toEqual([
      ['t-acme', null], // the cross-tenant FK is still hidden inside the transaction
      ['t-acme-tx', 'From tx'],
    ])
    const stored = await admin.rlsTask.findUnique({ where: { id: 't-acme-tx' } })
    expect(stored.tenantId).toBe('acme') // stamped by the scoping, committed
  })

  it('tenantTransaction: RLS filters even a statement that forgets the tenant predicate', async () => {
    const raw = appBase.$extends(tenancyExtension({ onRawInTenant: 'allow' }))
    await asTenant('acme', () =>
      tenantTransaction(raw, async (tx: Client) => {
        // no WHERE tenantId = … at all
        await tx.$executeRawUnsafe(`UPDATE rls_projects SET name = 'overwritten'`)
      }),
    )
    const globex = await admin.rlsProject.findUnique({ where: { id: 'p-globex' } })
    expect(globex.name).toBe('Globex Secret')
    const acme = await admin.rlsProject.findUnique({ where: { id: 'p-acme' } })
    expect(acme.name).toBe('overwritten')

    // and a row for another tenant is refused by WITH CHECK
    await expect(
      asTenant('acme', () =>
        tenantTransaction(raw, (tx: Client) =>
          tx.$executeRawUnsafe(`INSERT INTO rls_projects (id, "tenantId", name) VALUES ('x', 'globex', 'x')`),
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('an interactive $transaction that skips set_config fails closed (use tenantTransaction)', async () => {
    await expect(
      asTenant('acme', () => db.$transaction((tx: Client) => tx.rlsProject.create({ data: { id: 'p-x', name: 'x' } }))),
    ).rejects.toThrow(/row-level security/)
  })

  it('hand-written wiring: set_config for the current tenant is allowed through the raw guard', async () => {
    const created = await asTenant('acme', () =>
      db.$transaction(async (tx: Client) => {
        await tx.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams('acme'))
        return tx.rlsProject.create({ data: { id: 'p-manual', name: 'Manual' } })
      }),
    )
    expect(created.tenantId).toBe('acme')
  })

  it('a batch $transaction led by set_config is RLS-filtered', async () => {
    const [, projects] = await asTenant('acme', () =>
      db.$transaction([
        db.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams('acme')),
        db.rlsTask.findMany({ include: { project: true } }),
      ]),
    )
    expect(projects).toHaveLength(1)
    expect(projects[0].project).toBeNull()
  })

  it('user raw queries are still refused inside a tenant context', async () => {
    await expect(asTenant('acme', () => db.$queryRawUnsafe('SELECT * FROM rls_projects'))).rejects.toMatchObject({
      code: 'PRISMA_RAW_IN_TENANT',
    })
    // setting ANOTHER tenant is not the exempt statement
    await expect(
      asTenant('acme', () => db.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams('globex'))),
    ).rejects.toMatchObject({ code: 'PRISMA_RAW_IN_TENANT' })
    await expect(
      asTenant('acme', () =>
        tenantTransaction(db, (tx: Client) => tx.$queryRawUnsafe('SELECT * FROM rls_projects')),
      ),
    ).rejects.toMatchObject({ code: 'PRISMA_RAW_IN_TENANT' })
  })
})
