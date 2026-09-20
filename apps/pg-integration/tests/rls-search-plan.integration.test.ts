import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PostgresSearchDriver, type PgClientLike } from '@basaltkit/search-postgres'
import { rlsPolicySql, rlsSearchFunctionSql } from '@basaltkit/prisma'

// Full-text search under row-level security — the plan guard rail.
// Gated on TEST_DATABASE_URL — skips (keeping the default suite green) when unset.
//
// THE TRAP. `rlsPolicySql` (recommended) plus the `tsvector`/GIN table
// @basaltkit/search-postgres creates silently lose the index. PostgreSQL may
// only evaluate a qualifier before a row-security policy if that qualifier is
// LEAKPROOF; the text-search operator `@@` is not, so for a role the policy
// applies to it can never become an index condition. It is demoted to a filter
// applied after the policy and the plan collapses to a sequential scan over
// every tenant's rows. Nothing warns. A small dataset never shows it.
//
// Everything here runs through the REAL PostgresSearchDriver: it creates its own
// table and GIN index (`register`), indexes the documents that matter (`bulk`)
// and issues every query (`search`). The statements the plans are taken from are
// CAPTURED from the driver as it runs, never copied by hand — so if the driver's
// query shape ever drifts, this file explains the new shape and the assertions
// move with it.
//
// It fails if the trap regresses in either direction:
//   * the fast path (the SECURITY DEFINER function `rlsSearchFunctionSql`
//     generates, which the driver uses when `searchFunction` is set) must keep
//     the Bitmap Index Scan on the GIN index, and
//   * the trap itself is pinned, so if a future PostgreSQL makes the naked
//     query index-friendly we find out here and update the guidance.
const url = process.env['TEST_DATABASE_URL']

const APP_ROLE = 'basalt_rls_app'
const APP_PASSWORD = 'basalt_rls_app'
const TABLE = 'basalt_search'
const GIN_INDEX = 'basalt_search_tsv_idx'
const INDEX_NAME = 'notes'
const FUNCTION = 'basalt_search_scoped'
const SIGNATURE = `${FUNCTION}(text, text, jsonb, integer, integer)`
// Big enough that the planner genuinely prefers the index, cheap to generate.
const ACME_DOCS = 30_000
const GLOBEX_DOCS = 200
/** The rare term: three acme documents and every globex one carry it. */
const NEEDLE = 'zarbalux'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

interface Statement {
  text: string
  params: unknown[]
}

/**
 * A `pg` pool wearing a tap. The driver talks to this exactly as it would to
 * the pool; every statement it sends is kept, so the plan assertions below can
 * EXPLAIN what the driver really issued instead of a hand-written copy of it.
 */
class RecordingClient implements PgClientLike {
  readonly statements: Statement[] = []
  constructor(private readonly pool: Pool) {}
  async query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push({ text, params: params ?? [] })
    const result = await this.pool.query(text, params)
    return { rows: result.rows as Record<string, unknown>[] }
  }
  /** The last statement matching `re` — the driver sends more than one per search. */
  last(re: RegExp): Statement {
    const found = [...this.statements].reverse().find((statement) => re.test(statement.text))
    if (!found) throw new Error(`no statement matching ${re} was issued by the driver`)
    return found
  }
  issued(re: RegExp): boolean {
    return this.statements.some((statement) => re.test(statement.text))
  }
  reset(): void {
    this.statements.length = 0
  }
}

/** DDL with a retry — other files in this suite touch the same catalog rows. */
const ddl = async (client: Client, sql: string): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.$executeRawUnsafe(sql)
      return
    } catch (error) {
      const message = String((error as Error).message)
      if (!/tuple concurrently updated|already exists|duplicate key/i.test(message) || attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

const exec = async (client: Client, sql: string): Promise<void> => {
  // Prisma sends one statement per call: run generated migrations piecewise.
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) await ddl(client, statement)
}

/** One node of an `EXPLAIN (FORMAT JSON)` plan tree. */
interface PlanNode {
  'Node Type': string
  'Index Name'?: string
  'Relation Name'?: string
  Plans?: PlanNode[]
}

/** `EXPLAIN (FORMAT JSON)` for a statement, as whatever role `pool` connects as. */
const explain = async (pool: Pool, statement: Statement): Promise<PlanNode> => {
  const rows = (await pool.query(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.params)).rows
  const raw = (rows[0] as Record<string, unknown>)['QUERY PLAN']
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>
  return parsed[0]!.Plan
}

const walk = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(walk)]
const nodeTypes = (plan: PlanNode): string[] => walk(plan).map((node) => node['Node Type'])
const usesGinIndex = (plan: PlanNode): boolean =>
  walk(plan).some((node) => node['Node Type'] === 'Bitmap Index Scan' && node['Index Name'] === GIN_INDEX)

const millis = async (op: () => Promise<unknown>): Promise<number> => {
  await op() // warm the cache: this is about the plan, not about cold pages
  const started = performance.now()
  await op()
  return performance.now() - started
}

/** `SearchDocument`, borrowed from the driver so `@basaltkit/search` need not be a dependency here. */
type SearchDocument = Parameters<PostgresSearchDriver['index']>[1]

const doc = (id: string, tenantId: string, title: string, body: string): SearchDocument => ({
  id,
  tenantId,
  title,
  body,
})

describe.skipIf(!url)('full-text search under RLS keeps the GIN index', () => {
  let admin: Client // superuser Prisma client: the migration + the bulk seed
  let ownerPool: Pool // the same role, for the driver's DDL and for EXPLAIN
  let appPool: Pool // the application role: NOSUPERUSER NOBYPASSRLS, the policy applies
  let tap: RecordingClient // the app pool with its statements recorded
  let plain: PostgresSearchDriver // the driver as an app wires it today
  let scoped: PostgresSearchDriver // the same driver, told about the search function

  beforeAll(async () => {
    const clientModule: string = '../generated/client/index.js'
    const { PrismaClient } = (await import(clientModule)) as { PrismaClient: new (opts?: unknown) => Client }
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

    await ddl(admin, `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$`)
    await ddl(admin, `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`)
    // `prisma db push` does not know this table (the driver owns it), so start
    // from a clean slate and drop it again in afterAll.
    await ddl(admin, `DROP TABLE IF EXISTS ${TABLE}`)

    ownerPool = new Pool({ connectionString: url, max: 2 })
    // The driver creates its own table and GIN index — no hand-written DDL here.
    const seeder = new PostgresSearchDriver({ client: ownerPool })
    await seeder.register({ name: INDEX_NAME, fields: ['title', 'body'], filterable: ['folder'] })

    // The documents that matter are written by the driver itself, so the
    // tsvector under test is the one the driver produces.
    await seeder.bulk(
      INDEX_NAME,
      Array.from({ length: 3 }, (_, i) =>
        doc(`d${i + 1}`, 'acme', `Note ${i + 1}`, `${NEEDLE} acme confidential note ${i + 1}`),
      ),
    )
    // A second tenant whose documents ALL match the rare term: if the fast path
    // ever stopped scoping, these rows would show up in acme's results.
    await seeder.bulk(
      INDEX_NAME,
      Array.from({ length: GLOBEX_DOCS }, (_, i) =>
        doc(`g${i + 1}`, 'globex', `Globex ${i + 1}`, `${NEEDLE} globex confidential ${i + 1}`),
      ),
    )
    // The rest of the corpus is filler the search has to get past. Inserted
    // server-side in one statement (~1 s instead of 30 000 round trips), in
    // exactly the shape the driver writes: the document as jsonb, and
    // to_tsvector over the index's `fields` joined by a space.
    await ddl(admin, `
      INSERT INTO ${TABLE} (idx, tenant_id, id, document, tsv)
      SELECT '${INDEX_NAME}', 'acme', 'd' || g,
             jsonb_build_object('id', 'd' || g, 'tenantId', 'acme', 'title', 'Note ' || g, 'body', body),
             to_tsvector('english', 'Note ' || g || ' ' || body)
      FROM generate_series(4, ${ACME_DOCS}) AS g,
      LATERAL (SELECT 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
                      || md5(g::text) || ' ' || md5((g * 7)::text) || ' ' || md5((g * 13)::text)
                      || ' ut enim ad minim veniam quis nostrud exercitation ullamco laboris ' || g) AS s(body)`)
    await ddl(admin, `ANALYZE ${TABLE}`)

    await ddl(admin, `GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${APP_ROLE}`)
    // The migration a real deployment ships.
    await exec(admin, rlsPolicySql({ tables: [TABLE] }))
    await exec(
      admin,
      rlsSearchFunctionSql({
        name: FUNCTION,
        table: TABLE,
        vectorColumn: 'tsv',
        partitionColumn: 'idx',
        filterColumn: 'document',
        columns: [{ name: 'document', type: 'jsonb' }],
        role: APP_ROLE,
        maxRows: 100,
      }),
    )

    const appUrl = new URL(url!)
    appUrl.username = APP_ROLE
    appUrl.password = APP_PASSWORD
    // max: 1 — one pooled connection, so the session-level tenant setting stays
    // put between statements (and a leak would be observable).
    appPool = new Pool({ connectionString: appUrl.toString(), max: 1 })
    await appPool.query(`SELECT set_config('app.tenant_id', 'acme', false)`)
    tap = new RecordingClient(appPool)
    // Two drivers over the SAME tapped connection: how an app wires it today,
    // and the same thing told about the generated function.
    plain = new PostgresSearchDriver({ client: tap })
    scoped = new PostgresSearchDriver({ client: tap, searchFunction: FUNCTION })
  })

  // Every test starts on the same tenant, even if one of them failed halfway
  // through re-pointing the setting somewhere else.
  afterEach(async () => {
    await appPool?.query(`SELECT set_config('app.tenant_id', 'acme', false)`)
  })

  afterAll(async () => {
    await appPool?.end()
    await ownerPool?.end()
    await admin?.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${SIGNATURE}`)
    await admin?.$executeRawUnsafe(`DROP TABLE IF EXISTS ${TABLE}`)
    await admin?.$disconnect()
  })

  /** Runs a real search and hands back the statement the driver used for the rows. */
  const searchAndCapture = async (driver: PostgresSearchDriver, match: RegExp): Promise<Statement> => {
    tap.reset()
    await driver.search(INDEX_NAME, { tenantId: 'acme', q: NEEDLE })
    return tap.last(match)
  }

  it('the driver created its own GIN-indexed table', async () => {
    const rows = (
      await ownerPool.query(`SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`, [
        TABLE,
        GIN_INDEX,
      ])
    ).rows as Array<{ indexdef: string }>
    expect(rows[0]?.indexdef).toContain('USING gin (tsv)')
  })

  it("the owner plans the driver's own search statement with the GIN index", async () => {
    // The statement explained is the one the driver just issued, not a copy.
    const statement = await searchAndCapture(plain, /ORDER BY score DESC/)
    expect(statement.text).toContain('tsv @@ plainto_tsquery')
    const plan = await explain(ownerPool, statement)
    expect(usesGinIndex(plan)).toBe(true)
    expect(nodeTypes(plan)).not.toContain('Seq Scan')
  })

  it('THE TRAP: the same statement as the RLS role loses the index and scans the table', async () => {
    // Pinned on purpose. If this ever fails because the plan improved, it means
    // PostgreSQL changed how non-LEAKPROOF quals interact with row security —
    // re-measure and update the guidance in the security guide and in the
    // search-postgres README before relaxing anything.
    const statement = await searchAndCapture(plain, /ORDER BY score DESC/)
    const plan = await explain(appPool, statement)
    expect(usesGinIndex(plan)).toBe(false)
    expect(nodeTypes(plan)).toContain('Seq Scan')
  })

  it('THE FIX: configured with searchFunction, the driver calls the function instead', async () => {
    const statement = await searchAndCapture(scoped, new RegExp(FUNCTION))
    expect(statement.text).toContain(`FROM ${FUNCTION}(`)
    // no naked table query was issued at all…
    expect(tap.issued(/FROM basalt_search WHERE/)).toBe(false)
    // …and the tenant is not an argument: it can only come from the setting
    expect(statement.params).not.toContain('acme')
  })

  it('THE FIX: the function the driver calls plans with the GIN index again', async () => {
    // `EXPLAIN SELECT * FROM fn(...)` only ever shows a Function Scan, so the
    // body is read back from the catalog — the definition actually deployed —
    // and explained as the role the function RUNS as, which is what SECURITY
    // DEFINER executes.
    const rows = (await ownerPool.query(`SELECT prosrc FROM pg_proc WHERE oid = $1::regprocedure`, [SIGNATURE]))
      .rows as Array<{ prosrc: string }>
    const body = rows[0]!.prosrc
      .replace(/\bp_query\b/g, `'${NEEDLE}'::text`)
      .replace(/\bp_partition\b/g, `'${INDEX_NAME}'::text`)
      .replace(/\bp_filters\b/g, 'NULL::jsonb')
      .replace(/\bp_limit\b/g, '20')
      .replace(/\bp_offset\b/g, '0')

    await ownerPool.query(`SELECT set_config('app.tenant_id', 'acme', false)`)
    const plan = await explain(ownerPool, { text: body, params: [] })
    expect(usesGinIndex(plan)).toBe(true)
    expect(nodeTypes(plan)).not.toContain('Seq Scan')
  })

  it("the fast path returns the same hits as the scan it replaces, and only this tenant's", async () => {
    const viaTable = await plain.search(INDEX_NAME, { tenantId: 'acme', q: NEEDLE })
    const viaFunction = await scoped.search(INDEX_NAME, { tenantId: 'acme', q: NEEDLE })

    expect(viaFunction.hits.map((hit) => hit.id).sort()).toEqual(viaTable.hits.map((hit) => hit.id).sort())
    expect(viaFunction.hits.map((hit) => hit.id).sort()).toEqual(['d1', 'd2', 'd3'])
    // globex has GLOBEX_DOCS documents carrying the same term — none of them here
    expect(viaFunction.total).toBe(3)
    expect(viaFunction.hits.every((hit) => hit.document['tenantId'] === 'acme')).toBe(true)
    expect(viaFunction.hits[0]?.score).toBeGreaterThan(0)
  })

  it('and it is dramatically faster than the sequential scan it replaces', async () => {
    const viaTable = await millis(() => plain.search(INDEX_NAME, { tenantId: 'acme', q: NEEDLE }))
    const viaFunction = await millis(() => scoped.search(INDEX_NAME, { tenantId: 'acme', q: NEEDLE }))
    // Measured margin on 30 200 rows is ~10-25x; assert a conservative 3x so the
    // test reports a real regression rather than machine noise.
    expect(viaFunction).toBeLessThan(viaTable / 3)
  })

  it('fails closed: with no tenant in the session setting the driver gets no rows', async () => {
    await appPool.query(`SELECT set_config('app.tenant_id', '', false)`)
    expect(await scoped.search(INDEX_NAME, { tenantId: 'acme', q: NEEDLE })).toEqual({ hits: [], total: 0 })

    // …and a setting pointing elsewhere never degrades into "every tenant": the
    // function scopes to globex, and the driver refuses rows it did not ask for.
    await appPool.query(`SELECT set_config('app.tenant_id', 'globex', false)`)
    await expect(scoped.search(INDEX_NAME, { tenantId: 'acme', q: NEEDLE })).rejects.toThrow(
      /returned a row for tenant "globex" while searching "acme"/,
    )
    const globex = await scoped.search(INDEX_NAME, { tenantId: 'globex', q: NEEDLE, limit: 100 })
    expect(globex.hits).toHaveLength(100) // the function's maxRows cap, not GLOBEX_DOCS
    expect(globex.hits.every((hit) => hit.document['tenantId'] === 'globex')).toBe(true)
  })

  it("applies the driver's filters inside the function, so the cap and the total stay honest", async () => {
    const filtered = await scoped.search(INDEX_NAME, { tenantId: 'acme', q: NEEDLE, filters: { title: 'Note 2' } })
    expect(filtered.hits.map((hit) => hit.id)).toEqual(['d2'])
    expect(filtered.total).toBe(1)
    // …and the same filters through the table path agree
    const viaTable = await plain.search(INDEX_NAME, { tenantId: 'acme', q: NEEDLE, filters: { title: 'Note 2' } })
    expect(viaTable.hits.map((hit) => hit.id)).toEqual(['d2'])
  })

  it('a query with no text keeps the plain table path — equality is leakproof', async () => {
    tap.reset()
    await scoped.search(INDEX_NAME, { tenantId: 'acme', q: '   ' })
    expect(tap.issued(new RegExp(FUNCTION))).toBe(false)
    expect(tap.issued(/FROM basalt_search WHERE/)).toBe(true)
  })

  it('EXECUTE is not left open to PUBLIC', async () => {
    const rows = (
      await ownerPool.query(`SELECT has_function_privilege('public', $1, 'EXECUTE') AS granted`, [SIGNATURE])
    ).rows as Array<{ granted: boolean }>
    expect(rows[0]!.granted).toBe(false)
  })
})
