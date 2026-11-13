import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import postgres from '@prisma/orm-postgres/runtime'
import { contractFromJson } from '@prisma/orm-postgres/static'
import { appDir, databaseUrl, prisma, serverUrl } from './support/db.js'
import { tenantConnectionString } from './support/tenants.js'

// `namespace unbound { … }` is Prisma 8's own late-binding: a model whose schema the
// connection's search_path decides. It is in the PSL interpreter, not in the model docs,
// and on this RC it does not work end to end. These tests RECORD that, so the day it is
// fixed they fail and tell us — then it may replace the contract rewrite.
//   - runtime: prisma/orm#30722 (open) — loading contract.json qualifies the tables
//     with "__unbound__", so the search_path is never consulted;
//   - migrations: `db update` treats the unbound namespace as externally controlled and
//     plans no DDL for it.
// Gated on TEST_DATABASE_URL.

const DIR = join(appDir, '.tenants', '__unbound')
const PSL = `// use prisma-8

namespace unbound {
  model Item {
    id       String @id
    tenantId String
    name     String
  }
}
`

describe.skipIf(!serverUrl)('Prisma 8 RC: namespace unbound (late binding)', () => {
  let admin: pg.Client
  let contractJson: unknown

  beforeAll(async () => {
    await mkdir(DIR, { recursive: true })
    await writeFile(join(DIR, 'contract.prisma'), PSL)
    await writeFile(
      join(DIR, 'prisma.config.ts'),
      `import { definePrismaConfig } from '@prisma/cli-engine'\n` +
        `import { defineConfig as ormConfig } from '@prisma/orm-postgres/config'\n` +
        `export default definePrismaConfig({ orm: ormConfig({ contract: './contract.prisma', db: { connection: process.env['PRISMA8_DATABASE_URL']! } }) })\n`,
    )
    expect((await prisma(['contract', 'emit'], { config: join(DIR, 'prisma.config.ts') })).ok).toBe(true)
    contractJson = JSON.parse(await readFile(join(DIR, 'contract.json'), 'utf8'))
    admin = new pg.Client({ connectionString: databaseUrl() })
    await admin.connect()
    await admin.query(`CREATE SCHEMA IF NOT EXISTS tenant_unbound`)
    await admin.query(`CREATE TABLE IF NOT EXISTS tenant_unbound."Item" (id text PRIMARY KEY, "tenantId" text NOT NULL, name text NOT NULL)`)
  })
  afterAll(async () => {
    await admin?.end()
  })

  it('emits the namespace as "__unbound__"', () => {
    const c = contractJson as { roots: Record<string, { namespace: string }> }
    expect(c.roots['Item']?.namespace).toBe('__unbound__')
  })

  it('records prisma/orm#30722: the ORM qualifies the table with "__unbound__" instead of using the search_path', async () => {
    const sql: string[] = []
    const capture = { familyId: 'sql' as const, async beforeEncode(plan: { sql: string }) { sql.push(plan.sql) } }
    const db = postgres({
      contract: contractFromJson(contractJson as never),
      url: tenantConnectionString(databaseUrl(), 'tenant_unbound'),
      verifyMarker: false,
      middleware: [capture as never],
    })
    try {
      const orm = db.orm as unknown as Record<string, { Item: { all(): Promise<unknown[]> } }>
      const namespace = Object.values(orm)[0] ?? (orm as never)['__unbound__']
      await expect((namespace as { Item: { all(): Promise<unknown[]> } }).Item.all()).rejects.toMatchObject({})
    } finally {
      await db.close()
    }
    expect(sql.join('\n')).toContain('"__unbound__"."Item"')
  })

  it('records that db update plans no DDL for an unbound namespace (external control)', async () => {
    const dry = await prisma(['db', 'update', '--dry-run'], { config: join(DIR, 'prisma.config.ts') })
    expect(dry.result?.plan?.operations ?? []).toEqual([])
  })
})
