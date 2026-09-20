/**
 * Full-text search under Row-Level Security — keeping the GIN index.
 *
 * `rlsPolicySql` and a `tsvector` column are each fine on their own. Together
 * they have a trap that no error message points at:
 *
 *     -- as the owner:            Bitmap Index Scan on <gin index>   ~1 ms
 *     -- as the RLS app role:     Seq Scan on <table>               ~60 ms+
 *
 * PostgreSQL must evaluate a row-security policy **before** any qualifier that
 * could leak the contents of a row it filtered out, and a qualifier may only be
 * evaluated first if it is `LEAKPROOF`. The text-search operator `@@` is not
 * (`ts_match_vq` is not marked leakproof: its error messages can echo the
 * indexed value). So on a table with `ENABLE ROW LEVEL SECURITY`, queried by a
 * role the policy applies to, `tsv @@ to_tsquery(…)` can never become an index
 * condition. It is demoted to a plain filter applied after the policy, and the
 * plan degrades to a (parallel) sequential scan over the whole table — every
 * tenant's rows included. Nothing warns; a development dataset never shows it;
 * it appears in production when one tenant's corpus gets big.
 *
 * The shortcut everyone finds first — `ALTER FUNCTION ts_match_vq(…) LEAKPROOF`
 * — is **not** a fix. It weakens the leakproof rule database-wide, for every
 * table and every policy, so a carefully crafted `@@` can then be used as a
 * side channel to probe rows the policy hides. Never do it.
 *
 * The safe fix is the same shape as {@link crossTenantScanSql}: a narrow
 * `SECURITY DEFINER` function, owned by a role the policies do not reach, which
 * re-applies the tenant predicate **itself**. Inside it RLS is not in the way,
 * so `@@` is an index condition again — and the rows it can ever return are
 * still exactly one tenant's, because the function reads the tenant from the
 * very same `current_setting(…)` the policy reads, and takes **no tenant
 * parameter** that a caller could point at somebody else.
 *
 *     -- unset setting → current_setting(...) IS NULL → no rows. Fail closed.
 *
 * Unlike a cross-tenant scan, this function is *not* an isolation bypass: it is
 * tenant-scoped by construction, so it may return tenant data (the document,
 * the title, the rank). The security property to protect is the opposite one —
 * that it can never be made to read a tenant other than the one in context.
 */

import { DEFAULT_TENANT_SETTING, quoteIdentifier, SETTING } from './rls.js'

/** Output column carrying the tenant id — always returned, so callers can verify it. */
export const RLS_SEARCH_TENANT_COLUMN = 'tenant_id'
/** Output column carrying the row identifier. */
export const RLS_SEARCH_ID_COLUMN = 'id'
/** Output column carrying the `ts_rank` score. */
export const RLS_SEARCH_SCORE_COLUMN = 'score'
/** Output column carrying the total number of matches before `LIMIT`/`OFFSET`. */
export const RLS_SEARCH_TOTAL_COLUMN = 'total'

/** Output names the generated function reserves for itself. */
const RESERVED = [
  RLS_SEARCH_TENANT_COLUMN,
  RLS_SEARCH_ID_COLUMN,
  RLS_SEARCH_SCORE_COLUMN,
  RLS_SEARCH_TOTAL_COLUMN,
]

/** Default (and maximum) rows one call of the generated function may return. */
const DEFAULT_MAX_ROWS = 100
/** Most payload columns a search function may return. */
const MAX_COLUMNS = 12

/** A plain SQL type name — see `crossTenantScanSql`, same rule. */
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_ ]{0,62}$/
/** A text-search configuration: `english`, or `pg_catalog.english`. */
const REGCONFIG = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/

/** The `tsquery` builders a generated function may use. */
export type RlsSearchQueryParser = 'plainto' | 'phraseto' | 'websearch' | 'raw'

const PARSERS: Record<RlsSearchQueryParser, string> = {
  plainto: 'plainto_tsquery',
  phraseto: 'phraseto_tsquery',
  websearch: 'websearch_to_tsquery',
  // `to_tsquery` takes operator syntax (`a & b`) and RAISES on malformed input.
  // Only pick it when the caller composes the expression itself.
  raw: 'to_tsquery',
}

export interface RlsSearchColumn {
  /** Physical column name. */
  name: string
  /** SQL type of the returned column. Default: 'text'. */
  type?: string
}

export interface RlsSearchFunctionSqlOptions {
  /** Name of the generated function (unqualified). */
  name: string
  /** Table to search (unqualified). */
  table: string
  /** The `tsvector` column carrying the indexed text. Must have a GIN index. */
  vectorColumn: string
  /** Primary-key column, returned as `id` and used to break rank ties. Default: 'id'. */
  idColumn?: string
  /** SQL type of the id column. Default: 'text'. */
  idType?: string
  /** Column holding the tenant id. Returned as `tenant_id`. Default: 'tenant_id'. */
  tenantColumn?: string
  /** SQL type of the tenant column. Default: 'text'. */
  tenantType?: string
  /**
   * Payload columns to return besides `tenant_id`/`id`/`score`/`total` — the
   * document, a title, a snippet. Unlike a cross-tenant scan this function is
   * tenant-scoped, so tenant data is exactly what it is for.
   */
  columns?: Array<string | RlsSearchColumn>
  /**
   * An optional extra equality filter, exposed as the `p_partition` parameter:
   * the index name in a shared search table, a document type, a locale. `NULL`
   * means "every partition".
   */
  partitionColumn?: string
  /**
   * A `jsonb` column the `p_filters` parameter filters on, with
   * `@basaltkit/search` semantics: `{"folder":"inbox"}` means
   * `col->>'folder' = 'inbox'`, and an array means `= ANY(...)`.
   *
   * Omitted, the function refuses a non-NULL `p_filters` by returning no rows —
   * filters are never silently dropped.
   */
  filterColumn?: string
  /**
   * Postgres setting (GUC) read for the active tenant. **Must be the same one
   * `rlsPolicySql` was given**, or the function would scope to a different
   * tenant than the policy. Default: 'app.tenant_id'.
   */
  setting?: string
  /** Text-search configuration used to parse the query. Default: 'english'. */
  language?: string
  /** How `p_query` becomes a `tsquery`. Default: 'plainto' (what the search driver sends). */
  parser?: RlsSearchQueryParser
  /** Schema of the table and of the function. Default: 'public'. */
  schema?: string
  /** Role(s) granted EXECUTE — the application role the app connects as. */
  role: string | string[]
  /**
   * Role the function is owned by, i.e. the role it RUNS as. It must **not** be
   * subject to the table's RLS policies (a `BYPASSRLS` role, or a superuser):
   * `rlsPolicySql` sets FORCE ROW LEVEL SECURITY, so even the table owner is
   * filtered — and a filtered owner puts the policy back in front of `@@`,
   * which is the whole problem. Omitted: owned by whoever runs the migration.
   */
  owner?: string
  /** Hard cap on the rows one call may return. Default: 100. */
  maxRows?: number
}

interface ResolvedColumn {
  source: string
  type: string
}

const quoteType = (type: string, label: string): string => {
  if (!TYPE_NAME.test(type)) {
    throw new Error(
      `Invalid ${label} "${type}" — must be a plain SQL type name like "text", "uuid" or "jsonb".`,
    )
  }
  return type
}

function resolveColumns(columns: RlsSearchFunctionSqlOptions['columns']): ResolvedColumn[] {
  const declared = columns ?? []
  if (declared.length > MAX_COLUMNS) {
    throw new Error(
      `rlsSearchFunctionSql: ${declared.length} payload columns is more than a search function may ` +
        `return (max ${MAX_COLUMNS}).`,
    )
  }
  const resolved = declared.map((column) => {
    const { name, type } = typeof column === 'string' ? { name: column, type: undefined } : column
    quoteIdentifier(name, 'payload column')
    if (RESERVED.includes(name)) {
      throw new Error(
        `rlsSearchFunctionSql: "${name}" is reserved — the function always returns ` +
          `${RESERVED.map((r) => `"${r}"`).join(', ')}. Rename the payload column in \`columns\`.`,
      )
    }
    return { source: name, type: quoteType(type ?? 'text', `type of payload column "${name}"`) }
  })
  const names = resolved.map((column) => column.source)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate !== undefined) {
    throw new Error(`rlsSearchFunctionSql: duplicate payload column "${duplicate}".`)
  }
  return resolved
}

/**
 * SQL for a tenant-scoped full-text search function: a `SECURITY DEFINER`
 * function that searches `table` **inside the tenant currently in the session's
 * `setting`**, with the GIN index intact.
 *
 *     rlsSearchFunctionSql({
 *       name: 'basalt_search_scoped',
 *       table: 'basalt_search',
 *       vectorColumn: 'tsv',
 *       partitionColumn: 'idx',
 *       filterColumn: 'document',
 *       columns: [{ name: 'document', type: 'jsonb' }],
 *       role: 'app',        // the role the app connects as
 *       owner: 'app_owner', // must bypass the table's RLS (BYPASSRLS / superuser)
 *     })
 *
 * Call it with the tenant already set for the transaction — the same
 * `set_config` `tenancyExtension({ rls: true })` issues:
 *
 *     SELECT * FROM basalt_search_scoped('invoice overdue', 'notes', NULL, 20, 0)
 *
 * @security The function takes **no tenant parameter**. There is nothing for a
 * caller to tamper with: the tenant comes from `current_setting(<setting>,
 * true)`, byte for byte the expression in the policy `rlsPolicySql` installs.
 * An unset setting reads as NULL, `tenant = NULL` is never true, and the
 * function returns no rows — it fails closed, exactly like the policy. Keep
 * `setting` in sync with the policy's.
 *
 * What the generated SQL does, statement by statement:
 * - drops and recreates the function (idempotent, like `rlsPolicySql`);
 * - pins `search_path` inside the function — a `SECURITY DEFINER` function
 *   without one is a privilege-escalation hole;
 * - marks it `STABLE` and `PARALLEL SAFE` (it only reads);
 * - re-applies the tenant predicate itself, so the rows it can return are the
 *   rows the policy would have allowed;
 * - caps the result (`p_limit` clamped to `maxRows`) so one call can never pull
 *   the corpus, and returns the pre-`LIMIT` match count as `total`;
 * - `REVOKE ALL … FROM PUBLIC`, then `GRANT EXECUTE` to the application role
 *   only — a new function is executable by PUBLIC by default.
 *
 * Every identifier is validated and quoted; nothing is interpolated raw.
 */
export function rlsSearchFunctionSql(options: RlsSearchFunctionSqlOptions): string {
  const schema = quoteIdentifier(options.schema ?? 'public', 'schema')
  const fn = `${schema}.${quoteIdentifier(options.name, 'function name')}`
  const table = `${schema}.${quoteIdentifier(options.table, 'table')}`
  const vector = quoteIdentifier(options.vectorColumn, 'tsvector column')
  const idColumn = quoteIdentifier(options.idColumn ?? 'id', 'id column')
  const idType = quoteType(options.idType ?? 'text', 'id column type')
  const tenantColumn = quoteIdentifier(options.tenantColumn ?? 'tenant_id', 'tenant column')
  const tenantType = quoteType(options.tenantType ?? 'text', 'tenant column type')
  const columns = resolveColumns(options.columns)
  const setting = options.setting ?? DEFAULT_TENANT_SETTING
  if (!SETTING.test(setting)) {
    throw new Error(`Invalid setting "${setting}" — must be a namespaced GUC like "app.tenant_id".`)
  }
  const language = options.language ?? 'english'
  if (!REGCONFIG.test(language)) {
    throw new Error(
      `Invalid language "${language}" — must be a text-search configuration name like "english".`,
    )
  }
  const parser = options.parser ?? 'plainto'
  const tsquery = PARSERS[parser]
  if (tsquery === undefined) {
    throw new Error(
      `Invalid parser "${parser}" — one of ${Object.keys(PARSERS).map((p) => `"${p}"`).join(', ')}.`,
    )
  }
  const roles = (Array.isArray(options.role) ? options.role : [options.role]).map((role) =>
    quoteIdentifier(role, 'role'),
  )
  if (roles.length === 0) {
    throw new Error('rlsSearchFunctionSql: `role` must name the role allowed to execute the function.')
  }
  const maxRows = Math.floor(options.maxRows ?? DEFAULT_MAX_ROWS)
  if (!Number.isFinite(maxRows) || maxRows < 1 || maxRows > 10_000) {
    throw new Error(
      `rlsSearchFunctionSql: maxRows must be an integer between 1 and 10000 (got ${options.maxRows}).`,
    )
  }

  // The signature is FIXED — `(text, text, jsonb, integer, integer)` — whatever
  // the table looks like, so DROP/REVOKE/GRANT and every caller can be written
  // once. Notably absent: a tenant parameter.
  const signature = `${fn}(text, text, jsonb, integer, integer)`
  // Byte for byte the predicate `rlsPolicySql` puts in the policy.
  const tenantPredicate = `t.${tenantColumn} = current_setting('${setting}', true)`
  const partition =
    options.partitionColumn === undefined
      ? '(p_partition IS NULL)'
      : `(p_partition IS NULL OR t.${quoteIdentifier(options.partitionColumn, 'partition column')} = p_partition)`
  const filterColumn =
    options.filterColumn === undefined
      ? undefined
      : quoteIdentifier(options.filterColumn, 'filter column')
  // No filter column → a non-NULL `p_filters` matches nothing. A filter that
  // cannot be applied must never be silently dropped: that would widen the
  // result set past what the caller asked for.
  const filters =
    filterColumn === undefined
      ? '(p_filters IS NULL)'
      : `(p_filters IS NULL OR coalesce((
      SELECT bool_and(coalesce(
        CASE WHEN jsonb_typeof(f."value") = 'array'
             THEN t.${filterColumn}->>f."key" = ANY (ARRAY(SELECT jsonb_array_elements_text(f."value")))
             ELSE t.${filterColumn}->>f."key" = (f."value" #>> '{}')
        END, false))
      FROM jsonb_each(p_filters) AS f("key", "value")
    ), true))`

  const select = [
    `t.${tenantColumn} AS "${RLS_SEARCH_TENANT_COLUMN}"`,
    `t.${idColumn} AS "${RLS_SEARCH_ID_COLUMN}"`,
    ...columns.map(
      (column) => `t.${quoteIdentifier(column.source, 'payload column')} AS "${column.source}"`,
    ),
    `ts_rank(t.${vector}, (SELECT "q" FROM "basalt_tsquery"))::real AS "${RLS_SEARCH_SCORE_COLUMN}"`,
    `count(*) OVER () AS "${RLS_SEARCH_TOTAL_COLUMN}"`,
  ]
  const returns = [
    `"${RLS_SEARCH_TENANT_COLUMN}" ${tenantType}`,
    `"${RLS_SEARCH_ID_COLUMN}" ${idType}`,
    ...columns.map((column) => `"${column.source}" ${column.type}`),
    `"${RLS_SEARCH_SCORE_COLUMN}" real`,
    `"${RLS_SEARCH_TOTAL_COLUMN}" bigint`,
  ]

  return `-- basalt: tenant-scoped full-text search "${options.name}" over ${table}
-- SECURITY DEFINER so that row-level security does not stand between the planner
-- and the GIN index on ${vector} (the "@@" operator is not LEAKPROOF, so under RLS
-- it can never be an index condition). The function re-applies the tenant
-- predicate itself, reading the SAME setting as the policy ('${setting}') and
-- taking NO tenant parameter: unset setting -> no rows. See rlsSearchFunctionSql().
-- Do NOT "fix" the plan with ALTER FUNCTION ... LEAKPROOF: that weakens the rule
-- for every table and every policy in the database.
DROP FUNCTION IF EXISTS ${signature};

CREATE FUNCTION ${fn}(
  p_query text,
  p_partition text DEFAULT NULL,
  p_filters jsonb DEFAULT NULL,
  p_limit integer DEFAULT ${maxRows},
  p_offset integer DEFAULT 0
)
RETURNS TABLE (${returns.join(', ')})
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, ${schema}
AS $basalt_rls_search$
  WITH "basalt_tsquery" AS (SELECT ${tsquery}('${language}'::regconfig, p_query) AS "q")
  SELECT ${select.join(', ')}
  FROM ${table} AS t
  WHERE ${tenantPredicate}
    AND t.${vector} @@ (SELECT "q" FROM "basalt_tsquery")
    AND ${partition}
    AND ${filters}
  ORDER BY "${RLS_SEARCH_SCORE_COLUMN}" DESC, t.${idColumn}
  LIMIT least(greatest(coalesce(p_limit, ${maxRows}), 0), ${maxRows})
  OFFSET greatest(coalesce(p_offset, 0), 0)
$basalt_rls_search$;
${options.owner ? `\nALTER FUNCTION ${signature} OWNER TO ${quoteIdentifier(options.owner, 'owner role')};\n` : ''}
REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;

${roles.map((role) => `GRANT EXECUTE ON FUNCTION ${signature} TO ${role};`).join('\n')}
`
}
