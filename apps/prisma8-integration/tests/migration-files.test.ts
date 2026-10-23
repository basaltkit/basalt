import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { appDir, databaseUrl, planSql, prisma, serverUrl } from './support/db.js'
import { writeTenantContract } from './support/tenants.js'

// Migration FILES per tenant schema on Prisma 8 RC.
//   1. The official path refuses: `db migrate` checks the database's single marker
//      (prisma_contract.marker, one row per space) against each tenant's migration graph.
//   2. What Basalt would own instead: plan the files with Prisma, take each package's SQL
//      from `migration show --json`, apply it in one transaction per tenant schema, and
//      record it in that schema's own ledger. Prisma's marker is never touched.
// Gated on TEST_DATABASE_URL.

const A = 'tenant_mf_a'
const B = 'tenant_mf_b'
const migrationsOf = (config: string) => join(dirname(config), 'migrations', 'app')

/** Plans the next migration file from the last one on disk (Prisma asks for the origin explicitly). */
async function planNext(config: string, name: string) {
  const existing = (await readdir(migrationsOf(config)).catch(() => [] as string[])).sort()
  const from = existing.at(-1)
  return prisma(['migration', 'plan', '--name', name, ...(from ? ['--from', from] : [])], { config })
}

/** Basalt-side runner prototype: applies the planned packages a tenant schema has not run yet. */
async function migrateTenantSchema(admin: pg.Client, schema: string, config: string): Promise<string[]> {
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await admin.query(`CREATE TABLE IF NOT EXISTS "${schema}"."_basalt_migrations" (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`)
  const done = new Set((await admin.query(`SELECT name FROM "${schema}"."_basalt_migrations"`)).rows.map((r: { name: string }) => r.name))
  const applied: string[] = []
  for (const name of (await readdir(migrationsOf(config))).sort()) {
    if (done.has(name)) continue
    const shown = await prisma(['migration', 'show', name], { config })
    const migration = (shown.result as { migration?: { hash: string } } | undefined)?.migration
    if (!shown.ok || !migration) throw new Error(`migration show ${name} failed: ${JSON.stringify(shown)}`)
    await admin.query('BEGIN')
    try {
      for (const statement of planSql({ ...shown, result: { ok: true, plan: (shown.result as any).migration } } as never)) await admin.query(statement)
      await admin.query(`INSERT INTO "${schema}"."_basalt_migrations" (name, hash) VALUES ($1, $2)`, [name, migration.hash])
      await admin.query('COMMIT')
    } catch (error) {
      await admin.query('ROLLBACK')
      throw error
    }
    applied.push(name)
  }
  return applied
}

describe.skipIf(!serverUrl)('Prisma 8 RC: migration files per tenant schema', () => {
  let admin: pg.Client
  const marker = async () => (await admin.query(`SELECT core_hash FROM prisma_contract.marker WHERE space = 'app'`)).rows[0]?.core_hash as string
  const columns = async (schema: string) =>
    (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Project' ORDER BY 1`, [schema])).rows.map((r: { column_name: string }) => r.column_name)

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl() })
    await admin.connect()
    for (const schema of [A, B]) await rm(join(appDir, '.tenants', schema), { recursive: true, force: true })
  })
  afterAll(async () => {
    await admin?.end()
  })

  it('refuses `db migrate` for a tenant: one marker per database (MIGRATION.MARKER_MISMATCH)', async () => {
    const config = await writeTenantContract(A)
    expect((await prisma(['contract', 'emit'], { config })).ok).toBe(true)
    expect((await prisma(['migration', 'plan', '--name', 'init'], { config })).ok).toBe(true)
    const before = await marker()
    const migrate = await prisma(['db', 'migrate', '--yes'], { config })
    expect(migrate.ok).toBe(false)
    expect(JSON.stringify(migrate)).toContain('MIGRATION.MARKER_MISMATCH')
    expect(await marker()).toBe(before)
    expect(await columns(A)).toEqual([])
  })

  it('applies the planned files per tenant with a Basalt-owned ledger, leaving the marker alone', async () => {
    const before = await marker()
    const configB = await writeTenantContract(B)
    expect((await prisma(['contract', 'emit'], { config: configB })).ok).toBe(true)
    expect((await prisma(['migration', 'plan', '--name', 'init'], { config: configB })).ok).toBe(true)
    const configA = join(appDir, '.tenants', A, 'prisma.config.ts')

    expect(await migrateTenantSchema(admin, A, configA)).toHaveLength(1)
    expect(await migrateTenantSchema(admin, B, configB)).toHaveLength(1)
    expect(await columns(A)).toEqual(['createdAt', 'id', 'name', 'tenantId'])
    expect(await columns(B)).toEqual(['createdAt', 'id', 'name', 'tenantId'])
    // idempotent: a second run applies nothing
    expect(await migrateTenantSchema(admin, A, configA)).toEqual([])
    expect(await marker()).toBe(before)
  })

  it('evolves one tenant with a new migration file, and only that tenant', async () => {
    const before = await marker()
    const config = await writeTenantContract(A, ['status String?'])
    expect((await prisma(['contract', 'emit'], { config })).ok).toBe(true)
    const planned = await planNext(config, 'add_status')
    expect(planned.ok).toBe(true)
    const applied = await migrateTenantSchema(admin, A, config)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatch(/add_status$/)
    expect(await columns(A)).toContain('status')
    expect(await columns(B)).not.toContain('status')
    expect(await marker()).toBe(before)
  })

  it('rolls a failing migration back as a whole: nothing half-applied, nothing recorded', async () => {
    await admin.query(`INSERT INTO "${B}"."Project" (id, "tenantId", name) VALUES ('dup', 'b', 'one')`)
    const config = await writeTenantContract(B, ['code String @unique'])
    expect((await prisma(['contract', 'emit'], { config })).ok).toBe(true)
    expect((await planNext(config, 'add_code')).ok).toBe(true)
    // A NOT NULL column without a default cannot be added to a non-empty table.
    await expect(migrateTenantSchema(admin, B, config)).rejects.toThrow()
    expect(await columns(B)).not.toContain('code')
    const ledger = (await admin.query(`SELECT name FROM "${B}"."_basalt_migrations"`)).rows.map((r: { name: string }) => r.name)
    expect(ledger.some((n) => n.endsWith('add_code'))).toBe(false)
  })
})
