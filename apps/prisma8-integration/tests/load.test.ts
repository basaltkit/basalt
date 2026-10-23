import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import postgres from '@prisma/orm-postgres/runtime'
import { contractFromJson } from '@prisma/orm-postgres/static'
import { TenantClientPool } from '@basaltkit/prisma'
import type { Contract } from '../prisma/contract.js'
import contractJson from '../prisma/contract.json' with { type: 'json' }
import { databaseUrl, serverUrl } from './support/db.js'
import { contractForSchema, tenantConnectionString } from './support/tenants.js'

// Many tenants at once on Prisma 8 RC: 30 tenant schemas, 600 concurrent operations,
// clients handed out by Basalt's own TenantClientPool (the Prisma-agnostic pool of
// @basaltkit/prisma, unchanged) with at most 8 open clients of 2 connections each.
// Not a benchmark: it checks isolation and bounded connections under contention.
// Gated on TEST_DATABASE_URL.

const TENANTS = Array.from({ length: 30 }, (_, i) => `tenant_load_${String(i).padStart(2, '0')}`)
const OPERATIONS = 600
const CONCURRENCY = 40
const MAX_CLIENTS = 8
const CONNECTIONS_PER_CLIENT = 2

type Db = ReturnType<typeof postgres<Contract>>
interface Client { db: Db; pool: pg.Pool }

describe.skipIf(!serverUrl)('Prisma 8 RC: many tenants under load', () => {
  let admin: pg.Client
  let created = 0
  let destroyed = 0
  let pool: TenantClientPool<Client>

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl() })
    await admin.connect()
    for (const schema of TENANTS) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await admin.query(`CREATE TABLE "${schema}"."Project" (LIKE public."Project" INCLUDING ALL)`)
    }
    pool = new TenantClientPool<Client>({
      max: MAX_CLIENTS,
      idleMs: 50,
      acquireTimeoutMs: 30_000,
      create: (schema) => {
        created++
        const connections = new pg.Pool({ connectionString: tenantConnectionString(databaseUrl(), schema), max: CONNECTIONS_PER_CLIENT })
        const db = postgres({ contract: contractFromJson<Contract>(contractForSchema(contractJson, schema) as never), pg: connections, verifyMarker: false })
        return { db, pool: connections }
      },
      destroy: async (client) => {
        destroyed++
        await client.db.close()
        await client.pool.end()
      },
    })
  })
  afterAll(async () => {
    await pool?.destroyAll()
    for (const schema of TENANTS) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin?.end()
  })

  it(`keeps ${OPERATIONS} concurrent operations over ${TENANTS.length} tenants isolated, with bounded clients and connections`, async () => {
    let peakConnections = 0
    let sampling = true
    const sampler = new pg.Client({ connectionString: databaseUrl() })
    await sampler.connect()
    const sample = (async () => {
      while (sampling) {
        const { rows } = await sampler.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`)
        peakConnections = Math.max(peakConnections, rows[0].n)
        await new Promise((r) => setTimeout(r, 20))
      }
    })()

    // a deterministic interleaving: consecutive operations hit different tenants
    const work = Array.from({ length: OPERATIONS }, (_, i) => ({ i, schema: TENANTS[(i * 7) % TENANTS.length]! }))
    const started = Date.now()
    const failures: unknown[] = []
    for (let offset = 0; offset < work.length; offset += CONCURRENCY) {
      const batch = work.slice(offset, offset + CONCURRENCY)
      const settled = await Promise.allSettled(batch.map(async ({ i, schema }) => {
        const lease = await pool.acquire(schema)
        try {
          const id = `${schema}-${String(i).padStart(4, '0')}`
          await lease.client.db.orm.public.Project.create({ id, tenantId: schema, name: `op ${i}` })
          const mine = await lease.client.db.orm.public.Project.where({ id }).first()
          if (mine?.tenantId !== schema) throw new Error(`${schema} read back ${JSON.stringify(mine)}`)
          const [where] = await lease.client.db.query(
            lease.client.db.raw.sql`SELECT current_schema() AS s`.returnsRow({ s: 'pg/text@1' }).build())
          if (where?.s !== schema) throw new Error(`${schema} raw SQL ran in ${where?.s}`)
        } finally {
          lease.release()
        }
      }))
      failures.push(...settled.filter((s) => s.status === 'rejected').map((s) => (s as PromiseRejectedResult).reason))
    }
    const elapsed = Date.now() - started
    sampling = false
    await sample
    await sampler.end()

    expect(failures).toEqual([])
    // every row sits in its own tenant's schema, and the counts add up
    let total = 0
    for (const schema of TENANTS) {
      const { rows } = await admin.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE "tenantId" <> $1)::int AS foreign FROM "${schema}"."Project"`, [schema])
      expect(rows[0].foreign).toBe(0)
      total += rows[0].n
    }
    expect(total).toBe(OPERATIONS)
    expect((await admin.query(`SELECT count(*)::int AS n FROM public."Project" WHERE "tenantId" LIKE 'tenant_load_%'`)).rows[0].n).toBe(0)
    // bounded: never more than MAX_CLIENTS × CONNECTIONS_PER_CLIENT, plus the admin client
    expect(peakConnections).toBeLessThanOrEqual(MAX_CLIENTS * CONNECTIONS_PER_CLIENT + 1)
    // the pool did churn: more tenants than slots, so clients were evicted and recreated
    expect(created).toBeGreaterThan(MAX_CLIENTS)
    expect(destroyed).toBeGreaterThan(0)
    process.stderr.write(`[load] ${OPERATIONS} ops / ${TENANTS.length} tenants in ${elapsed} ms; clients created ${created}, evicted ${destroyed}; peak connections ${peakConnections}\n`)
  }, 120_000)
})
