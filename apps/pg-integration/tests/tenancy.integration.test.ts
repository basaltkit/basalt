import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { tenancyExtension } from '@basaltkit/prisma'

// Full Prisma-client-through-a-server path against real PostgreSQL.
// Gated on TEST_DATABASE_URL — skips (keeping the default suite green) when unset.
const url = process.env['TEST_DATABASE_URL']

describe.skipIf(!url)('tenancyExtension against real PostgreSQL', () => {
  let base: { $disconnect(): Promise<void>; project: { deleteMany(): Promise<unknown> } }
  let db: {
    project: {
      create(args: { data: { name: string } }): Promise<{ id: string; tenantId: string; name: string }>
      findMany(): Promise<{ name: string; tenantId: string }[]>
      count(): Promise<number>
    }
  }

  /**
   * Runs an operation inside a tenant context, awaiting it there so the ALS
   * context is active while the Prisma query actually executes (the query is
   * lazy — returning the PrismaPromise from a sync callback would run it after
   * the context closes). This mirrors what the Fastify adapter does per request.
   */
  const asTenant = <T>(id: string, op: () => Promise<T>): Promise<T> =>
    runWithContext({ tenant: { id } }, async () => await op())

  beforeAll(async () => {
    // Typed as string so tsc treats it as a dynamic specifier — the generated
    // client need not exist for typecheck (it's produced by `prisma generate`).
    const clientModule: string = '../generated/client/index.js'
    const { PrismaClient } = (await import(clientModule)) as {
      PrismaClient: new () => typeof base & { $extends(ext: unknown): typeof db }
    }
    base = new PrismaClient() as never
    db = (base as unknown as { $extends(ext: unknown): typeof db }).$extends(tenancyExtension())
  })

  afterAll(async () => {
    await base.$disconnect()
  })

  beforeEach(async () => {
    await base.project.deleteMany()
  })

  it('scopes create and findMany to the ambient tenant', async () => {
    await asTenant('acme', () => db.project.create({ data: { name: 'Acme Project' } }))
    await asTenant('globex', () => db.project.create({ data: { name: 'Globex Project' } }))
    await asTenant('globex', () => db.project.create({ data: { name: 'Globex Two' } }))

    // each tenant sees only its own rows — through a real Prisma client + Postgres
    const acme = await asTenant('acme', () => db.project.findMany())
    const globex = await asTenant('globex', () => db.project.findMany())

    expect(acme.map((p) => p.name)).toEqual(['Acme Project'])
    expect(acme[0]?.tenantId).toBe('acme') // create stamped the tenant
    expect(globex.map((p) => p.name).sort()).toEqual(['Globex Project', 'Globex Two'])
  })

  it('count is tenant-scoped too', async () => {
    await asTenant('acme', () => db.project.create({ data: { name: 'A' } }))
    await asTenant('acme', () => db.project.create({ data: { name: 'B' } }))
    await asTenant('globex', () => db.project.create({ data: { name: 'C' } }))

    expect(await asTenant('acme', () => db.project.count())).toBe(2)
    expect(await asTenant('globex', () => db.project.count())).toBe(1)
  })

  it('without a tenant context, the query is unscoped (central/admin)', async () => {
    await asTenant('acme', () => db.project.create({ data: { name: 'A' } }))
    await asTenant('globex', () => db.project.create({ data: { name: 'B' } }))

    // no runWithContext → no tenant → bypass, sees everything
    const all = await db.project.count()
    expect(all).toBe(2)
  })
})
