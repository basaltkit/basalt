import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaPg } from '@prisma/adapter-pg'
import { pgSchemaClient, provisionTenantSchema, schemaUrl, tenantSchema } from '@basaltkit/prisma'

// Schema-per-tenant through a Prisma 7 driver adapter, against real PostgreSQL.
// The adapter ignores `?schema=`; pgSchemaClient must put each tenant's rows in
// its own schema anyway — for model queries and for raw SQL.
// Gated on TEST_DATABASE_URL — skips (keeping the default suite green) when unset.
const url = process.env['TEST_DATABASE_URL']

type Client = {
  $disconnect(): Promise<void>
  $executeRawUnsafe(sql: string): Promise<number>
  $queryRawUnsafe<T>(sql: string): Promise<T>
  project: { create(args: { data: { tenantId: string; name: string } }): Promise<unknown> }
}

describe.skipIf(!url)('pgSchemaClient: schema per tenant on Prisma 7', () => {
  let PrismaClient: new (options: unknown) => Client
  let admin: Client
  const tenants = ['acme', 'globex'] as const
  const clients = new Map<string, Client>()

  beforeAll(async () => {
    // Typed as string so tsc treats it as a dynamic specifier — the generated
    // client need not exist for typecheck (it's produced by `prisma generate`).
    const clientModule: string = '../generated/client/index.js'
    ;({ PrismaClient } = (await import(clientModule)) as { PrismaClient: typeof PrismaClient })
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
    for (const id of tenants) {
      const schema = tenantSchema(id)
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await provisionTenantSchema(admin, schema)
      await admin.$executeRawUnsafe(`CREATE TABLE "${schema}"."Project" (LIKE public."Project" INCLUDING ALL)`)
    }
    const createClient = pgSchemaClient(({ connectionString, schema }) =>
      new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) }))
    for (const id of tenants) clients.set(id, await createClient(schemaUrl(url!, tenantSchema(id))))
  })

  afterAll(async () => {
    for (const client of clients.values()) await client.$disconnect()
    for (const id of tenants) await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${tenantSchema(id)}" CASCADE`)
    await admin?.$disconnect()
  })

  it('writes each tenant\'s rows to its own schema, never to public', async () => {
    const marker = `pg-schema-${process.pid}`
    await clients.get('acme')!.project.create({ data: { tenantId: 'acme', name: `${marker}-acme` } })
    await clients.get('globex')!.project.create({ data: { tenantId: 'globex', name: `${marker}-globex` } })

    const names = async (schema: string) =>
      (await admin.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM "${schema}"."Project" WHERE name LIKE '${marker}%'`)).map((r) => r.name)
    expect(await names(tenantSchema('acme'))).toEqual([`${marker}-acme`])
    expect(await names(tenantSchema('globex'))).toEqual([`${marker}-globex`])
    expect(await names('public')).toEqual([])
  })

  it('runs raw SQL in the tenant\'s schema, with public still on the path', async () => {
    const [row] = await clients.get('globex')!.$queryRawUnsafe<{ schema: string; path: string }[]>(
      'SELECT current_schema() AS schema, current_setting(\'search_path\') AS path')
    expect(row).toEqual({ schema: tenantSchema('globex'), path: `${tenantSchema('globex')},public` })
  })
})
