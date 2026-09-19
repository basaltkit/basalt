import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { PrismaPg } from '@prisma/adapter-pg'
import { assertMigrated, DatabaseNotMigratedError, prismaPlugin } from '@basaltkit/prisma'

// prismaPlugin({ assertMigrated }) against real PostgreSQL. Gated on
// TEST_DATABASE_URL. The harness schema is applied with `prisma db push`, which
// does not create _prisma_migrations — so the suite first sees an "unmigrated"
// database, then creates the table the way `prisma migrate deploy` would.
const url = process.env['TEST_DATABASE_URL']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

describe.skipIf(!url)('assertMigrated against real PostgreSQL', () => {
  let client: Client
  let newClient: () => Client
  let createdTable = false

  beforeAll(async () => {
    const clientModule: string = '../generated/client/index.js'
    const { PrismaClient } = (await import(clientModule)) as { PrismaClient: new (opts?: unknown) => Client }
    newClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
    client = newClient()
    const [{ exists }] = await client.$queryRawUnsafe(
      `SELECT to_regclass('_prisma_migrations') IS NOT NULL AS exists`,
    )
    if (exists) throw new Error('expected a db-push database without _prisma_migrations')
  })

  afterAll(async () => {
    if (createdTable) await client.$executeRawUnsafe('DROP TABLE IF EXISTS _prisma_migrations')
    await client?.$disconnect()
  })

  it('fails the boot naming the database and host, without credentials', async () => {
    const app = createApp({ plugins: [prismaPlugin({ client: newClient(), assertMigrated: true })] })
    const error = (await app.boot().catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(DatabaseNotMigratedError)
    const database = new URL(url!).pathname.slice(1) || 'postgres'
    expect(error.message.toLowerCase()).toContain(`database "${database}" on `)
    expect(error.message).toContain('_prisma_migrations')
    // The credentials must never appear as credentials. (Checking the bare
    // password is not enough in CI, where it is also part of the database name.)
    const parsed = new URL(url!)
    if (parsed.password) {
      expect(error.message).not.toContain(`${parsed.username}:${parsed.password}@`)
      expect(error.message).not.toContain(`:${decodeURIComponent(parsed.password)}@`)
    }
  })

  it('boots once migrated, and checks the listed (case-sensitive) tables', async () => {
    // the shape `prisma migrate deploy` creates (only its existence matters)
    await client.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS _prisma_migrations (id VARCHAR(36) PRIMARY KEY, migration_name VARCHAR(255) NOT NULL)',
    )
    createdTable = true

    const app = await createApp({
      plugins: [prismaPlugin({ client: newClient(), assertMigrated: { tables: ['Project', 'auth_users'] } })],
    }).boot()
    await app.shutdown() // also disconnects the plugin's client

    await expect(assertMigrated(client, { tables: ['Project', 'no_such_table'] })).rejects.toThrow(
      /missing expected tables: no_such_table/,
    )
  })
})
