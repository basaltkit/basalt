/**
 * Cross-tenant sweeps — finding stuck work across EVERY tenant, safely.
 *
 * A reconciler (`defineReconciler` in @basaltkit/scheduler) has to answer a
 * question no tenant-scoped query can answer: "which rows, anywhere, are still
 * PROCESSING?". Under Postgres RLS the application role only ever sees one
 * tenant at a time, and {@link tenancyExtension} refuses unscoped queries — so
 * the sweep cannot run as an ordinary query at all.
 *
 * The safe answer is a narrow, audited hole in the wall:
 *
 *  1. {@link crossTenantScanSql} generates a `SECURITY DEFINER` function, owned
 *     by a privileged role, that returns **identifier columns only** — the
 *     tenant id and the row id. It is a deliberate RLS bypass, so it must never
 *     be allowed to return tenant data.
 *  2. {@link crossTenantScan} calls that function from central code and hands
 *     back typed `{ tenantId, id }` rows.
 *  3. {@link crossTenantSweep} pages through it and processes each row inside
 *     its own tenant's context (`tenancy.run(tenantId, …)`), where the ordinary
 *     scoped client — and RLS — apply again.
 *
 * Without RLS none of this is needed: a central client (`onMissingTenant:
 * 'bypass'`, or one without the extension) can select the identifiers directly.
 * Pass that query as {@link CrossTenantSweepOptions.scan} and the rest of the
 * machinery — paging, grouping, per-tenant execution — still applies.
 */

import { BasaltError, runWithContext, tryCtx } from '@basaltkit/core'
import { quoteIdentifier } from './rls.js'

/**
 * A cross-tenant scan was attempted while a tenant was in scope. It is a
 * deliberate RLS bypass and must only ever run as central code.
 */
export class CrossTenantScanInTenantError extends BasaltError {
  constructor(name: string) {
    super(
      'PRISMA_CROSS_TENANT_IN_TENANT',
      `The cross-tenant scan "${name}" was called inside a tenant context. It reads across every ` +
        'tenant on purpose (a SECURITY DEFINER function that bypasses RLS), so it must run as ' +
        'central code — outside tenancy.run() / the request tenant. Process the results tenant by ' +
        'tenant instead (crossTenantSweep does that for you).',
    )
  }
}

/**
 * The deployed function returned a column the caller did not declare. Fails
 * closed: the whole guarantee of the pattern is that the scan carries
 * identifiers and nothing else, and only the caller knows which identifiers it
 * asked for. A function redefined to also select `email` or `total` is refused
 * here rather than handed to application code.
 */
export class CrossTenantScanShapeError extends BasaltError {
  constructor(name: string, detail: string, allowed: string[]) {
    super(
      'PRISMA_CROSS_TENANT_SCAN_SHAPE',
      `The cross-tenant scan "${name}" did not return what was declared: ${detail} ` +
        `(declared columns: ${allowed.map((column) => `"${column}"`).join(', ')}). A cross-tenant scan ` +
        'bypasses RLS, so it may return identifiers only — never tenant data. Recreate the function from ' +
        'crossTenantScanSql(), or declare the extra identifier columns in `columns`.',
    )
  }
}

/** Output column carrying the tenant id. Fixed, whatever the physical column is called. */
export const CROSS_TENANT_ID_COLUMN = 'tenant_id'
/** Output column carrying the row identifier. Fixed, whatever the physical column is called. */
export const CROSS_TENANT_ROW_COLUMN = 'id'

/** Most identifier columns a scan may return — a wide one is tenant data in disguise. */
const MAX_IDENTIFIER_COLUMNS = 4
/** Default (and maximum) rows one call of the generated function may return. */
const DEFAULT_MAX_ROWS = 1000
/** Default rows per page of {@link crossTenantSweep}. */
const DEFAULT_PAGE_SIZE = 500
/** Default cap on the items one sweep processes. */
const DEFAULT_MAX_ITEMS = 10_000

/**
 * A SQL type name for a returned identifier column: a plain type name such as
 * `text`, `uuid`, `bigint` or `character varying`. No parentheses, quotes or
 * punctuation — identifiers are returned as declared, and a length/precision
 * is meaningless for a return type.
 */
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_ ]{0,62}$/

/** Fragments that would let a `where` predicate escape the function body. */
const WHERE_FORBIDDEN: Array<[RegExp, string]> = [
  [/;/, 'a semicolon (it would end the statement)'],
  [/--/, 'a line comment ("--")'],
  [/\/\*|\*\//, 'a block comment ("/*")'],
  [/\$/, 'a dollar sign (it would break the dollar-quoted function body)'],
]

export interface CrossTenantScanColumn {
  /** Physical column name. */
  name: string
  /** SQL type of the returned column. Default: 'text'. */
  type?: string
}

export interface CrossTenantScanSqlOptions {
  /** Name of the generated function (unqualified). */
  name: string
  /** Table to scan (unqualified). */
  table: string
  /** Column holding the tenant id. Returned as `tenant_id`. Default: 'tenant_id'. */
  tenantColumn?: string
  /** SQL type of the tenant column. Default: 'text'. */
  tenantType?: string
  /**
   * Identifier columns to return — **identifiers only, never tenant data**.
   * The first one is the row identifier: it is returned as `id`, it orders the
   * scan and it carries the paging cursor, so it must be unique within a
   * tenant (the primary key). Any further column keeps its own name.
   */
  columns: Array<string | CrossTenantScanColumn>
  /**
   * The "stuck" predicate, e.g. `t."status" = 'PROCESSING' AND t."updatedAt" <
   * now() - interval '15 minutes'`. The table is aliased `t`.
   *
   * @security Inlined verbatim into the function body: it is migration SQL you
   * write, never a value built from user input. Statement terminators,
   * comments and dollar signs are refused.
   */
  where?: string
  /** Schema of the table and of the function. Default: 'public'. */
  schema?: string
  /** Role(s) granted EXECUTE — the application role the reconciler connects as. */
  role: string | string[]
  /**
   * Role the function is owned by, i.e. the role it RUNS as. It must not be
   * subject to the table's RLS policies (a `BYPASSRLS` role, or a superuser),
   * otherwise the scan returns nothing: `rlsPolicySql` sets FORCE ROW LEVEL
   * SECURITY, so even the table owner is filtered. Omitted: the function is
   * owned by whoever runs the migration.
   */
  owner?: string
  /** Hard cap on the rows one call may return. Default: 1000. */
  maxRows?: number
}

interface ResolvedColumn {
  /** Physical column. */
  source: string
  /** Name the function returns it under. */
  output: string
  type: string
}

const quoteType = (type: string, label: string): string => {
  if (!TYPE_NAME.test(type)) {
    throw new Error(
      `Invalid ${label} "${type}" — must be a plain SQL type name like "text", "uuid" or "bigint".`,
    )
  }
  return type
}

function resolveColumns(options: CrossTenantScanSqlOptions): ResolvedColumn[] {
  const declared = options.columns ?? []
  if (declared.length === 0) {
    throw new Error('crossTenantScanSql: `columns` must name at least the row identifier column.')
  }
  if (declared.length > MAX_IDENTIFIER_COLUMNS) {
    throw new Error(
      `crossTenantScanSql: ${declared.length} columns is more than a scan may return ` +
        `(max ${MAX_IDENTIFIER_COLUMNS}). A cross-tenant scan bypasses RLS: return identifiers only, ` +
        'and read the tenant data inside the tenant context.',
    )
  }
  const resolved = declared.map((column, index) => {
    const { name, type } = typeof column === 'string' ? { name: column, type: undefined } : column
    quoteIdentifier(name, 'identifier column')
    return {
      source: name,
      output: index === 0 ? CROSS_TENANT_ROW_COLUMN : name,
      type: quoteType(type ?? 'text', `type of identifier column "${name}"`),
    }
  })
  const outputs = [CROSS_TENANT_ID_COLUMN, ...resolved.map((c) => c.output)]
  const duplicate = outputs.find((name, index) => outputs.indexOf(name) !== index)
  if (duplicate !== undefined) {
    throw new Error(
      `crossTenantScanSql: duplicate returned column "${duplicate}". The tenant column is returned ` +
        `as "${CROSS_TENANT_ID_COLUMN}" and the first identifier column as "${CROSS_TENANT_ROW_COLUMN}".`,
    )
  }
  return resolved
}

function checkWhere(where: string): string {
  for (const [pattern, description] of WHERE_FORBIDDEN) {
    if (pattern.test(where)) {
      throw new Error(`crossTenantScanSql: \`where\` may not contain ${description}.`)
    }
  }
  return where
}

/**
 * SQL for a cross-tenant scan function: a `SECURITY DEFINER` function that
 * returns the identifiers of the rows matching `where` **across every tenant**.
 *
 *     crossTenantScanSql({
 *       name: 'stuck_jobs',
 *       table: 'jobs',
 *       tenantColumn: 'tenantId',
 *       columns: ['id'],
 *       where: `t."status" = 'PROCESSING' AND t."updatedAt" < now() - interval '15 minutes'`,
 *       role: 'app',        // the role the app connects as
 *       owner: 'app_owner', // must bypass the table's RLS (BYPASSRLS / superuser)
 *     })
 *
 * @security This function is a **deliberate RLS bypass**: inside it the tenant
 * policies do not apply. That is only safe because of what it returns —
 * identifiers, and nothing else. Never widen it to a column holding tenant
 * data (a name, an amount, an email): a caller with EXECUTE on it would read
 * every tenant's data in one call, with no policy in the way. Fetch the data
 * itself inside `tenancy.run(tenantId, …)`, through the scoped client.
 *
 * What the generated SQL does, statement by statement:
 * - drops and recreates the function (idempotent, like `rlsPolicySql`);
 * - pins `search_path` inside the function — a `SECURITY DEFINER` function
 *   without one is a privilege-escalation hole (a caller could point an
 *   unqualified name at a table of their own);
 * - marks it `STABLE` and `PARALLEL SAFE` (it only reads);
 * - caps and pages the result: `p_limit` is clamped to `maxRows`, and
 *   `(p_after_tenant, p_after_id)` is an ordered cursor, so a sweep can never
 *   pull millions of rows in one call;
 * - `REVOKE ALL … FROM PUBLIC`, then `GRANT EXECUTE` to the application role
 *   only — the default on a new function is EXECUTE for PUBLIC, which for a
 *   `SECURITY DEFINER` function means everyone.
 *
 * Every identifier is validated and quoted; nothing is interpolated raw.
 */
export function crossTenantScanSql(options: CrossTenantScanSqlOptions): string {
  const schema = quoteIdentifier(options.schema ?? 'public', 'schema')
  const fn = `${schema}.${quoteIdentifier(options.name, 'function name')}`
  const table = `${schema}.${quoteIdentifier(options.table, 'table')}`
  const tenantColumn = quoteIdentifier(options.tenantColumn ?? 'tenant_id', 'tenant column')
  const tenantType = quoteType(options.tenantType ?? 'text', 'tenant column type')
  const columns = resolveColumns(options)
  const row = columns[0] as ResolvedColumn
  const roles = (Array.isArray(options.role) ? options.role : [options.role]).map((role) =>
    quoteIdentifier(role, 'role'),
  )
  if (roles.length === 0) {
    throw new Error('crossTenantScanSql: `role` must name the role allowed to execute the function.')
  }
  const maxRows = Math.floor(options.maxRows ?? DEFAULT_MAX_ROWS)
  if (!Number.isFinite(maxRows) || maxRows < 1 || maxRows > 1_000_000) {
    throw new Error(`crossTenantScanSql: maxRows must be an integer between 1 and 1000000 (got ${options.maxRows}).`)
  }
  const where = options.where === undefined ? 'true' : checkWhere(options.where)
  // Signature used by DROP/REVOKE/GRANT — it must match the parameter list
  // exactly. The cursor parameters are always `text`: the body casts them to
  // the column types, so the comparison and the ordering stay native (and
  // index-friendly) while the client only ever binds strings.
  const signature = `${fn}(integer, text, text)`
  const select = [
    `t.${tenantColumn} AS "${CROSS_TENANT_ID_COLUMN}"`,
    ...columns.map(
      (column) => `t.${quoteIdentifier(column.source, 'identifier column')} AS "${column.output}"`,
    ),
  ]
  const returns = [
    `"${CROSS_TENANT_ID_COLUMN}" ${tenantType}`,
    ...columns.map((column) => `"${column.output}" ${column.type}`),
  ]
  const order = `t.${tenantColumn}, t.${quoteIdentifier(row.source, 'identifier column')}`

  return `-- basalt: cross-tenant scan "${options.name}" over ${table}
-- SECURITY DEFINER: this function DELIBERATELY BYPASSES row-level security.
-- It must return identifier columns only (never tenant data), and EXECUTE on it
-- must stay restricted to the application role. See crossTenantScanSql().
DROP FUNCTION IF EXISTS ${signature};

CREATE FUNCTION ${fn}(
  p_limit integer DEFAULT ${maxRows},
  p_after_tenant text DEFAULT NULL,
  p_after_id text DEFAULT NULL
)
RETURNS TABLE (${returns.join(', ')})
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, ${schema}
AS $basalt_cross_tenant_scan$
  SELECT ${select.join(', ')}
  FROM ${table} AS t
  WHERE (${where})
    AND (
      p_after_tenant IS NULL
      OR (t.${tenantColumn}, t.${quoteIdentifier(row.source, 'identifier column')})
         > (p_after_tenant::${tenantType}, p_after_id::${row.type})
    )
  ORDER BY ${order}
  LIMIT least(greatest(coalesce(p_limit, ${maxRows}), 1), ${maxRows})
$basalt_cross_tenant_scan$;
${options.owner ? `\nALTER FUNCTION ${signature} OWNER TO ${quoteIdentifier(options.owner, 'owner role')};\n` : ''}
REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;

${roles.map((role) => `GRANT EXECUTE ON FUNCTION ${signature} TO ${role};`).join('\n')}
`
}

/** The cursor of a cross-tenant scan: where the next page resumes. */
export interface CrossTenantCursor {
  tenantId: string
  id: string
}

/** One identifier row of a cross-tenant scan. Identifiers only — never tenant data. */
export interface CrossTenantScanRow {
  /** The row's tenant (the `tenant_id` output column). */
  tenantId: string
  /** The row identifier (the `id` output column). */
  id: string
  /** Any further identifier column declared in `columns`, under its own name. */
  [column: string]: unknown
}

export interface CrossTenantScanArgs {
  /** Rows to return. The function clamps it to its own `maxRows`. */
  limit?: number
  /** Resume after this row (the previous page's last row). */
  after?: CrossTenantCursor
  /** Schema of the function. Default: 'public'. */
  schema?: string
  /**
   * Identifier columns the function returns **besides** `tenant_id` and `id`,
   * i.e. `columns` minus its first entry. A returned column outside this set
   * is refused with {@link CrossTenantScanShapeError}.
   */
  columns?: string[]
}

/** The one method this module needs from a Prisma client. */
interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PromiseLike<T>
}

const tenantInScope = (): string | undefined =>
  (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id

const list = (columns: string[]): string => columns.map((column) => `"${column}"`).join(', ')

function toRow(name: string, raw: unknown, extra: string[]): CrossTenantScanRow {
  const allowed = [CROSS_TENANT_ID_COLUMN, CROSS_TENANT_ROW_COLUMN, ...extra]
  if (raw === null || typeof raw !== 'object') {
    throw new CrossTenantScanShapeError(name, 'a result row was not an object', allowed)
  }
  const record = raw as Record<string, unknown>
  // Fail closed on the shape: the deployed function may be older, or edited by
  // hand, and this is the check that keeps "identifiers only" true at runtime.
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new CrossTenantScanShapeError(name, `it also returned ${list(unexpected)}`, allowed)
  }
  const missing = allowed.filter((key) => !(key in record))
  if (missing.length > 0) {
    throw new CrossTenantScanShapeError(name, `it is missing ${list(missing)}`, allowed)
  }
  const tenantId = record[CROSS_TENANT_ID_COLUMN]
  const id = record[CROSS_TENANT_ROW_COLUMN]
  if (tenantId === null || tenantId === undefined || id === null || id === undefined) {
    throw new CrossTenantScanShapeError(name, 'a row carried a NULL identifier', allowed)
  }
  const row: CrossTenantScanRow = { tenantId: String(tenantId), id: String(id) }
  for (const column of extra) row[column] = record[column]
  return row
}

/**
 * Calls a scan function generated by {@link crossTenantScanSql} and returns its
 * identifier rows — `{ tenantId, id }`, plus any further identifier column
 * declared in `args.columns`.
 *
 *     const stuck = await crossTenantScan(db, 'stuck_jobs', { limit: 200 })
 *
 * This is a raw query, and a deliberate RLS bypass, so it is **not** exempt
 * from the `PRISMA_RAW_IN_TENANT` guard the way the internal `set_config`
 * statement is: that statement is provably harmless (it names the tenant
 * already in scope), while this one reads across every tenant. Instead it
 * refuses to run at all while a tenant is in scope
 * ({@link CrossTenantScanInTenantError}) — a sweep is central code by
 * definition. Called from central code, no tenant is in scope, so the raw
 * guard never fires.
 *
 * Any client works: the extended one (outside tenant scope the extension lets
 * raw queries through) or a plain `PrismaClient`.
 */
export async function crossTenantScan(
  client: unknown,
  name: string,
  args: CrossTenantScanArgs = {},
): Promise<CrossTenantScanRow[]> {
  if (tenantInScope() !== undefined) throw new CrossTenantScanInTenantError(name)
  const schema = quoteIdentifier(args.schema ?? 'public', 'schema')
  const fn = `${schema}.${quoteIdentifier(name, 'function name')}`
  const extra = (args.columns ?? []).map((column) => {
    quoteIdentifier(column, 'identifier column')
    return column
  })
  const limit = args.limit === undefined ? null : Math.max(1, Math.floor(args.limit))
  const after = args.after
  const rows = await (client as RawQueryClient).$queryRawUnsafe<unknown>(
    `SELECT * FROM ${fn}($1, $2, $3)`,
    limit,
    after ? String(after.tenantId) : null,
    after ? String(after.id) : null,
  )
  if (!Array.isArray(rows)) return []
  return rows.map((raw) => toRow(name, raw, extra))
}

/** One page request handed to a custom {@link CrossTenantSweepOptions.scan}. */
export interface CrossTenantPage {
  limit: number
  after?: CrossTenantCursor
}

export interface CrossTenantSweepOptions {
  /** Prisma client used for the scan. Required unless `scan` is given. */
  client?: unknown
  /** Name of the function generated by {@link crossTenantScanSql}. */
  scanFunction?: string
  /** Schema of that function. Default: 'public'. */
  schema?: string
  /** Identifier columns besides `tenant_id`/`id` (see {@link CrossTenantScanArgs.columns}). */
  columns?: string[]
  /**
   * Replaces the function call with a query of your own — what a deployment
   * **without** RLS uses: a central client can select the identifiers
   * directly, and no SQL function is needed.
   *
   *     scan: ({ limit, after }) => central.job.findMany({
   *       where: { status: 'PROCESSING', ...(after ? { OR: [...] } : {}) },
   *       select: { tenantId: true, id: true },
   *       orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
   *       take: limit,
   *     })
   *
   * Must return rows ordered by `(tenantId, id)` and resume strictly after
   * `after`, or the sweep will loop over the same page.
   */
  scan?: (page: CrossTenantPage) => CrossTenantScanRow[] | Promise<CrossTenantScanRow[]>
  /**
   * Processes one item, **inside its tenant's context** — so `db()`, the scoped
   * client and RLS all apply as they do in a request. Must be idempotent: a
   * sweep is an at-least-once safety net.
   */
  handle: (item: CrossTenantScanRow, tenantId: string) => void | Promise<void>
  /** Rows per page. Default 500. */
  limit?: number
  /** Cap on the items one sweep processes. Default 10000. */
  maxItems?: number
  /**
   * Enters a tenant's context. Default: the tenant is put in the context
   * directly (what `tenancy.run` does, minus the tenant lookup and the
   * `tenancy:switched` hook). Pass `(id, fn) => tenancy.run(id, fn)` to get
   * the real tenant record and the hook — the usual wiring in an app.
   */
  run?: (tenantId: string, fn: () => Promise<void>) => Promise<void>
  /**
   * An item's `handle` threw. Default: `console.error`. The next item still
   * runs — one poisoned row must not stop the sweep. Must not throw.
   */
  onError?: (error: unknown, item: CrossTenantScanRow) => void
}

export interface CrossTenantSweepResult {
  /** Pages fetched from the scan. */
  pages: number
  /** Identifier rows returned by the scan. */
  found: number
  /** Distinct tenants the sweep entered. */
  tenants: number
  /** Items whose `handle` resolved. */
  processed: number
  /** Items whose `handle` threw. */
  failed: number
  /** The cap was reached — more work may be waiting for the next sweep. */
  truncated: boolean
  /** Where the next sweep could resume (the last row seen), if any. */
  cursor?: CrossTenantCursor
}

/** Splits an ordered page into runs of the same tenant. */
function groupByTenant(rows: CrossTenantScanRow[]): Array<{ tenantId: string; items: CrossTenantScanRow[] }> {
  const groups: Array<{ tenantId: string; items: CrossTenantScanRow[] }> = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last && last.tenantId === row.tenantId) last.items.push(row)
    else groups.push({ tenantId: row.tenantId, items: [row] })
  }
  return groups
}

const runInTenantContext = (tenantId: string, fn: () => Promise<void>): Promise<void> =>
  runWithContext({ ...tryCtx(), tenant: { id: tenantId } }, fn)

/**
 * Pages through a cross-tenant scan and processes every row **inside its own
 * tenant's context**, grouping consecutive rows of the same tenant into one
 * `run`:
 *
 *     const result = await crossTenantSweep({
 *       client: db,
 *       scanFunction: 'stuck_jobs',
 *       run: (id, fn) => tenancy.run(id, fn),
 *       handle: (item) => RetryJob.dispatch({ jobId: item.id }),
 *     })
 *
 * The scan runs as central code (no tenant in scope); `handle` runs with the
 * tenant set, so the scoped client and the RLS policies apply again and the
 * item can be read and updated normally. A tenant whose rows straddle a page
 * boundary is simply entered once per page.
 *
 * Bounded by construction: `limit` rows per page, `maxItems` rows in total, and
 * the generated function clamps the page size to its own `maxRows`. `handle`
 * failures are isolated per item and reported to `onError`.
 *
 * Refuses to run inside a tenant context ({@link CrossTenantScanInTenantError}).
 */
export async function crossTenantSweep(options: CrossTenantSweepOptions): Promise<CrossTenantSweepResult> {
  const name = options.scanFunction ?? '(custom scan)'
  if (tenantInScope() !== undefined) throw new CrossTenantScanInTenantError(name)
  if (!options.scan && (options.scanFunction === undefined || options.client === undefined)) {
    throw new Error(
      'crossTenantSweep: give it `client` + `scanFunction` (the crossTenantScanSql function), or a `scan` ' +
        'of your own (a plain central query — what a deployment without RLS uses).',
    )
  }
  const pageSize = Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE))
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? DEFAULT_MAX_ITEMS))
  const run = options.run ?? runInTenantContext
  const onError =
    options.onError ??
    ((error: unknown, item: CrossTenantScanRow) =>
      console.error(`[basalt:cross-tenant-sweep] "${name}" failed on ${item.tenantId}/${item.id}:`, error))
  const scan =
    options.scan ??
    ((page: CrossTenantPage) =>
      crossTenantScan(options.client, options.scanFunction as string, {
        limit: page.limit,
        ...(page.after ? { after: page.after } : {}),
        ...(options.schema ? { schema: options.schema } : {}),
        ...(options.columns ? { columns: options.columns } : {}),
      }))

  const result: CrossTenantSweepResult = {
    pages: 0,
    found: 0,
    tenants: 0,
    processed: 0,
    failed: 0,
    truncated: false,
  }
  const tenants = new Set<string>()
  let after: CrossTenantCursor | undefined

  while (result.found < maxItems) {
    const limit = Math.min(pageSize, maxItems - result.found)
    const rows = await scan({ limit, ...(after ? { after } : {}) })
    if (rows.length === 0) break
    result.pages++
    result.found += rows.length
    for (const group of groupByTenant(rows)) {
      tenants.add(group.tenantId)
      await run(group.tenantId, async () => {
        for (const item of group.items) {
          try {
            await options.handle(item, group.tenantId)
            result.processed++
          } catch (error) {
            result.failed++
            try {
              onError(error, item)
            } catch {
              // a broken error handler must not stop the sweep
            }
          }
        }
      })
    }
    const last = rows[rows.length - 1] as CrossTenantScanRow
    after = { tenantId: last.tenantId, id: last.id }
    result.cursor = after
    result.tenants = tenants.size
    // A short page means the scan is exhausted (for now).
    if (rows.length < limit) break
    if (result.found >= maxItems) result.truncated = true
  }
  return result
}
