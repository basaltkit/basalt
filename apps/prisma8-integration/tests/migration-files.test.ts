import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { appDir, databaseUrl, prisma, serverUrl } from './support/db.js'
import { authorMigration, MigrationRejected, migrateTenantSchema, orderedPackages, planNext, validateOperations, type Operation } from './support/runner.js'
import { sqlState, writeTenantContract } from './support/tenants.js'

// Migration FILES per tenant schema on Prisma 8 RC.
//   - The official path refuses: `db migrate` checks the database's single marker.
//   - The Basalt-owned runner (tests/support/runner.ts) applies Prisma-planned,
//     attested packages to ONE tenant schema: integrity check, operation validation,
//     and PostgreSQL's own permissions (a role that owns only that schema).
// Gated on TEST_DATABASE_URL.

const A = 'tenant_mf_a'
const B = 'tenant_mf_b'
const configOf = (schema: string) => join(appDir, '.tenants', schema, 'prisma.config.ts')

describe.skipIf(!serverUrl)('Prisma 8 RC: migration files per tenant schema', () => {
  let admin: pg.Client
  const marker = async () => (await admin.query(`SELECT core_hash FROM prisma_contract.marker WHERE space = 'app'`)).rows[0]?.core_hash as string
  const columns = async (schema: string) =>
    (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Project' ORDER BY 1`, [schema])).rows.map((r: { column_name: string }) => r.column_name)
  const ledger = async (schema: string) =>
    (await admin.query(`SELECT name FROM "${schema}"."_basalt_migrations" ORDER BY name`)).rows.map((r: { name: string }) => r.name)
  const rejection = async (run: Promise<unknown>) => {
    try {
      await run
    } catch (error) {
      return error
    }
    throw new Error('expected the runner to refuse')
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl() })
    await admin.connect()
    for (const schema of [A, B]) {
      await rm(join(appDir, '.tenants', schema), { recursive: true, force: true })
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
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

  it('applies the planned files per tenant with its own ledger, idempotently, leaving the marker alone', async () => {
    const before = await marker()
    const configB = await writeTenantContract(B)
    expect((await prisma(['contract', 'emit'], { config: configB })).ok).toBe(true)
    expect((await prisma(['migration', 'plan', '--name', 'init'], { config: configB })).ok).toBe(true)
    expect(await migrateTenantSchema(admin, A, configOf(A))).toHaveLength(1)
    expect(await migrateTenantSchema(admin, B, configB)).toHaveLength(1)
    expect(await columns(A)).toEqual(['createdAt', 'id', 'name', 'tenantId'])
    expect(await columns(B)).toEqual(['createdAt', 'id', 'name', 'tenantId'])
    expect(await migrateTenantSchema(admin, A, configOf(A))).toEqual([])
    expect(await marker()).toBe(before)
    // the tables belong to the tenant's role, not to the migrating superuser
    expect((await admin.query(`SELECT tableowner FROM pg_tables WHERE schemaname = $1 AND tablename = 'Project'`, [A])).rows[0].tableowner).toBe(`${A}_owner`)
  })

  it('evolves one tenant with a new migration file, and only that tenant', async () => {
    const config = await writeTenantContract(A, ['status String?'])
    expect((await prisma(['contract', 'emit'], { config })).ok).toBe(true)
    expect((await planNext(config, 'add_status')).ok).toBe(true)
    const applied = await migrateTenantSchema(admin, A, config)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatch(/add_status$/)
    // graph order, not name order: both packages carry the same minute, and "add_status" sorts before "init"
    const order = await orderedPackages(join(appDir, '.tenants', A, 'migrations', 'app'))
    expect(order.map((n) => n.replace(/^\d{8}T\d{4}_/, ''))).toEqual(['init', 'add_status'])
    expect(await columns(A)).toContain('status')
    expect(await columns(B)).not.toContain('status')
  })

  it('rolls a failing migration back as a whole: nothing half-applied, nothing recorded', async () => {
    await admin.query(`INSERT INTO "${B}"."Project" (id, "tenantId", name) VALUES ('dup', 'b', 'one')`)
    const config = await writeTenantContract(B, ['code String @unique'])
    expect((await prisma(['contract', 'emit'], { config })).ok).toBe(true)
    expect((await planNext(config, 'add_code')).ok).toBe(true)
    // A NOT NULL column without a default cannot be added to a non-empty table.
    await expect(migrateTenantSchema(admin, B, config)).rejects.toThrow()
    expect(await columns(B)).not.toContain('code')
    expect((await ledger(B)).some((n) => n.endsWith('add_code'))).toBe(false)
  })

  it('refuses a TypeScript data transform (operationClass "data"), applying nothing', async () => {
    const before = await ledger(A)
    const name = await authorMigration(configOf(A), 'backfill_status',
      `[this.dataTransform(endContractObj, 'backfill-status', { run: () => db.${A}.Project.update({ status: 'active' }).where((f: any, fns: any) => fns.eq(f.status, null)) })]`)
    const error = await rejection(migrateTenantSchema(admin, A, configOf(A)))
    expect(error).toBeInstanceOf(MigrationRejected)
    expect((error as MigrationRejected).migration).toBe(name)
    expect((error as MigrationRejected).reasons.join(' ')).toMatch(/data transform/)
    expect(await ledger(A)).toEqual(before)
    await rm(join(appDir, '.tenants', A, 'migrations', 'app', name), { recursive: true, force: true })
  })

  it('refuses a hand-written operation that reaches another tenant, and the other tenant is untouched', async () => {
    const before = await ledger(A)
    const name = await authorMigration(configOf(A), 'cross_tenant', `[rawSql({
      id: 'raw.cross-tenant', label: 'reach another tenant', operationClass: 'additive', target: { id: 'postgres' },
      precheck: [], execute: [{ description: 'cross-tenant', sql: 'ALTER TABLE "${B}"."Project" ADD COLUMN "pwned" text' }], postcheck: [],
    })]`)
    const error = await rejection(migrateTenantSchema(admin, A, configOf(A)))
    expect(error).toBeInstanceOf(MigrationRejected)
    const reasons = (error as MigrationRejected).reasons.join(' ')
    expect(reasons).toMatch(/no declared schema/)
    expect(reasons).toContain(`names schema "${B}"`)
    expect(await columns(B)).not.toContain('pwned')
    expect(await ledger(A)).toEqual(before)
    await rm(join(appDir, '.tenants', A, 'migrations', 'app', name), { recursive: true, force: true })
  })

  it('refuses a package whose ops.json was changed after it was attested (MIGRATION.CHECK_HASH_MISMATCH)', async () => {
    const config = await writeTenantContract(A, ['status String?', 'note String?'])
    expect((await prisma(['contract', 'emit'], { config })).ok).toBe(true)
    expect((await planNext(config, 'add_note')).ok).toBe(true)
    const dir = join(appDir, '.tenants', A, 'migrations', 'app')
    const name = (await orderedPackages(dir)).at(-1)!
    const opsPath = join(dir, name, 'ops.json')
    const original = await readFile(opsPath, 'utf8')
    const tampered = JSON.parse(original) as Array<{ execute?: Array<{ sql: string }> }>
    const step = tampered.flatMap((op) => op.execute ?? []).find((e) => e.sql.includes('"note"'))!
    step.sql = `${step.sql}, ADD COLUMN "extra" text`
    await writeFile(opsPath, JSON.stringify(tampered, null, 2))
    try {
      const error = await rejection(migrateTenantSchema(admin, A, config))
      expect((error as MigrationRejected).reasons.join(' ')).toContain('MIGRATION.CHECK_HASH_MISMATCH')
      expect(await columns(A)).not.toContain('extra')
    } finally {
      await writeFile(opsPath, original)
    }
    expect(await migrateTenantSchema(admin, A, config)).toEqual([name])
    expect(await columns(A)).toContain('note')
  })

  it('holds even with validation skipped: the tenant role cannot reach another schema', async () => {
    const name = await authorMigration(configOf(A), 'cross_tenant_unchecked', `[rawSql({
      id: 'raw.cross-tenant', label: 'reach another tenant', operationClass: 'additive', target: { id: 'postgres', details: { schema: '${A}' } },
      precheck: [], execute: [{ description: 'cross-tenant', sql: 'ALTER TABLE "${B}"."Project" ADD COLUMN "pwned" text' }], postcheck: [],
    })]`)
    const error = await rejection(migrateTenantSchema(admin, A, configOf(A), { unsafeSkipValidation: true }))
    // Without USAGE on the other schema its tables are not even visible to the role:
    // 42P01 (undefined table) rather than 42501 (insufficient privilege).
    expect(['42P01', '42501']).toContain(sqlState(error))
    expect(await columns(B)).not.toContain('pwned')
    expect((await ledger(A)).includes(name)).toBe(false)
    await rm(join(appDir, '.tenants', A, 'migrations', 'app', name), { recursive: true, force: true })
  })

  it('validates statement by statement (no database needed)', () => {
    const op = (sql: string, extra: Partial<Operation> = {}): Operation => ({
      id: 'x', operationClass: 'additive', target: { id: 'postgres', details: { schema: A } }, execute: [{ sql }], ...extra,
    })
    expect(validateOperations(A, [op(`ALTER TABLE "${A}"."Project" ADD COLUMN "x" text`)])).toEqual([])
    const reasons = (sql: string) => validateOperations(A, [op(sql)], [A, B, 'public']).join(' ')
    expect(reasons(`ALTER TABLE "${A}"."Project" ADD COLUMN "x" text; DROP TABLE "${B}"."Project"`)).toMatch(/more than one statement/)
    expect(reasons(`GRANT ALL ON ALL TABLES IN SCHEMA "${A}" TO PUBLIC`)).toMatch(/not allowed|forbidden/)
    expect(reasons(`CREATE POLICY p ON "${A}"."Project" USING (true)`)).toMatch(/not allowed|forbidden/)
    expect(reasons(`CREATE TABLE "public"."Leak" (id text)`)).toContain('names schema "public"')
    expect(reasons(`CREATE FUNCTION "${A}".f() RETURNS int LANGUAGE sql AS 'select 1'`)).toMatch(/not allowed|forbidden/)
    expect(validateOperations(A, [op(`ALTER TABLE "${A}"."Project" ADD COLUMN "x" text`, { target: { id: 'postgres' } })]).join(' ')).toMatch(/no declared schema/)
    expect(validateOperations(A, [{ ...op(`ALTER TABLE "${A}"."Project" ADD COLUMN "x" text`), execute: [{ sql: `ALTER TABLE "${A}"."Project" ADD COLUMN "x" text`, params: [B] }] }], [A, B]).join(' '))
      .toContain(`parameter names another schema "${B}"`)
  })
})
