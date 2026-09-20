import type { IndexDefinition, SearchDocument, SearchDriver, SearchQuery, SearchResult } from '@basaltkit/search'

/** The subset of a `pg` Pool/Client this driver uses. */
export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/**
 * Routes full-text queries through a `SECURITY DEFINER` function instead of
 * querying the table directly — the fix for the row-level-security plan trap.
 *
 * On a search table protected by Postgres RLS, `tsv @@ to_tsquery(…)` can never
 * become an index condition for a role the policy applies to: `@@` is not
 * `LEAKPROOF`, so it must be evaluated *after* the policy, and the GIN index
 * silently drops out of the plan (sequential scan over every tenant's rows).
 * Generate the function with `rlsSearchFunctionSql()` from `@basaltkit/prisma`
 * and name it here; the driver then calls it, and the index is used again.
 *
 * The function takes no tenant parameter: it reads the tenant from the same
 * `current_setting(…)` the policy reads, so it can only ever return rows of the
 * tenant already set on the connection. The driver still checks every returned
 * row against the query's `tenantId` and refuses a mismatch.
 */
export interface PostgresSearchFunctionOptions {
  /** Unqualified name of the function (`rlsSearchFunctionSql`'s `name`). */
  name: string
  /** Schema it lives in. Default `public`. */
  schema?: string
}

export interface PostgresSearchOptions {
  /** A connected `pg` Pool or Client. */
  client: PgClientLike
  /** Table that holds every index (created by `register`). Default `basalt_search`. */
  table?: string
  /** Text-search configuration (stemming/stop-words). Default `english`. */
  language?: string
  /**
   * Name of a `SECURITY DEFINER` search function to route text queries through
   * — required when the search table is under Postgres RLS, otherwise the GIN
   * index is not used. See {@link PostgresSearchFunctionOptions}.
   */
  searchFunction?: string | PostgresSearchFunctionOptions
}

/** A single unquoted SQL identifier: starts with a letter/underscore, then word chars. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate a dotted SQL name (`table`, `schema.table`) before it is
 * string-interpolated into DDL/DML. Configuration-time identifiers are never
 * request input, but a developer wiring one from an external value would
 * otherwise have a SQL injection. Returns the (unchanged) name.
 */
function assertValidName(name: string, label: string): string {
  const parts = name.split('.')
  if (parts.length > 2 || parts.some((part) => !SAFE_IDENTIFIER.test(part))) {
    throw new Error(
      `PostgresSearchDriver: invalid ${label} ${JSON.stringify(name)} — ` +
        'must be a SQL identifier matching /^[A-Za-z_][A-Za-z0-9_]*$/ ' +
        `(optionally schema-qualified as "schema.${label === 'table name' ? 'table' : 'name'}").`,
    )
  }
  return name
}

/**
 * Validate a table name before it is string-interpolated into DDL/DML. The
 * table name is a configuration-time identifier (never request input), but a
 * developer wiring it from an external value would otherwise have a SQL
 * injection. Accepts a bare identifier or a `schema.table` pair, each part a
 * valid identifier. Returns the (unchanged) name so it can be used inline.
 */
export function assertValidTableName(table: string): string {
  return assertValidName(table, 'table name')
}

/**
 * PostgreSQL full-text search driver for `@basaltkit/search`, using
 * `tsvector`/`tsquery` and `ts_rank`. All documents live in one table keyed by
 * (index, tenant, id); every query is constrained to the caller's tenant, so
 * results never leak. Bring a `pg` client — it's injected, so the SQL is
 * unit-tested without a database.
 */
export class PostgresSearchDriver implements SearchDriver {
  private readonly client: PgClientLike
  private readonly table: string
  private readonly language: string
  private readonly searchFunction: string | undefined
  private readonly configs = new Map<string, IndexDefinition>()

  constructor(options: PostgresSearchOptions) {
    this.client = options.client
    this.table = assertValidTableName(options.table ?? 'basalt_search')
    this.language = options.language ?? 'english'
    const fn = options.searchFunction
    this.searchFunction =
      fn === undefined
        ? undefined
        : typeof fn === 'string'
          ? assertValidName(fn, 'search function name')
          : `${assertValidName(fn.schema ?? 'public', 'search function schema')}.${assertValidName(fn.name, 'search function name')}`
  }

  async register(index: IndexDefinition): Promise<void> {
    this.configs.set(index.name, index)
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (` +
        `idx text NOT NULL, tenant_id text NOT NULL, id text NOT NULL, ` +
        `document jsonb NOT NULL, tsv tsvector, PRIMARY KEY (idx, tenant_id, id))`,
    )
    // Index names are NOT schema-qualifiable in Postgres — `CREATE INDEX … app.x_idx`
    // is a syntax error. The index lands in the table's own schema automatically.
    const indexName = `${this.table.replace('.', '_')}_tsv_idx`
    await this.client.query(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${this.table} USING gin(tsv)`)
  }

  async index(indexName: string, document: SearchDocument): Promise<void> {
    const text = this.searchableFields(indexName, document)
      .map((field) => String(document[field] ?? ''))
      .join(' ')
    await this.client.query(
      `INSERT INTO ${this.table} (idx, tenant_id, id, document, tsv) ` +
        // `$5::regconfig` — not decoration. `PgClientLike` accepts any client,
        // and they do not agree on parameter typing: `pg` sends them untyped
        // and lets Postgres infer `regconfig`, while Prisma sends them as
        // `text`. `to_tsvector(text, text)` does not exist (error 42883), so
        // without the cast this driver is unusable with the very client
        // `@basaltkit/prisma` recommends. Redundant under `pg`, required here.
        `VALUES ($1, $2, $3, $4::jsonb, to_tsvector($5::regconfig, $6)) ` +
        `ON CONFLICT (idx, tenant_id, id) DO UPDATE SET document = EXCLUDED.document, tsv = EXCLUDED.tsv`,
      [indexName, document.tenantId, document.id, JSON.stringify(document), this.language, text],
    )
  }

  async bulk(indexName: string, documents: SearchDocument[]): Promise<void> {
    for (const document of documents) await this.index(indexName, document)
  }

  async remove(indexName: string, tenantId: string, id: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE idx = $1 AND tenant_id = $2 AND id = $3`, [indexName, tenantId, id])
  }

  async clear(indexName: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE idx = $1`, [indexName])
  }

  async search(indexName: string, query: SearchQuery): Promise<SearchResult> {
    const q = (query.q ?? '').trim()
    // Only a *text* query needs the function: `idx = $1 AND tenant_id = $2` is
    // plain equality, which IS leakproof, so RLS leaves the primary key alone.
    if (q && this.searchFunction !== undefined) return await this.searchViaFunction(q, indexName, query)

    const params: unknown[] = [indexName, query.tenantId]
    let score = '0'
    let where = 'idx = $1 AND tenant_id = $2'

    if (q) {
      const langIdx = params.push(this.language)
      const qIdx = params.push(q)
      // Same reason as the INSERT above: the language has to arrive as a
      // `regconfig`, not as text.
      const tsquery = `plainto_tsquery($${langIdx}::regconfig, $${qIdx})`
      score = `ts_rank(tsv, ${tsquery})`
      where += ` AND tsv @@ ${tsquery}`
    }

    for (const [field, value] of Object.entries(query.filters ?? {})) {
      const fieldIdx = params.push(field)
      if (Array.isArray(value)) {
        const valueIdx = params.push(value.map(String))
        where += ` AND document->>$${fieldIdx} = ANY($${valueIdx})`
      } else {
        const valueIdx = params.push(String(value))
        where += ` AND document->>$${fieldIdx} = $${valueIdx}`
      }
    }

    const whereParams = params.slice()
    const limitIdx = params.push(query.limit ?? 20)
    const offsetIdx = params.push(query.offset ?? 0)

    const rows = (
      await this.client.query(
        `SELECT id, document, ${score} AS score FROM ${this.table} WHERE ${where} ORDER BY score DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      )
    ).rows
    const total = (await this.client.query(`SELECT count(*)::int AS total FROM ${this.table} WHERE ${where}`, whereParams)).rows

    return {
      hits: rows.map((row) => ({
        id: String(row['id']),
        score: Number(row['score'] ?? 0),
        document: row['document'] as SearchDocument,
      })),
      total: Number(total[0]?.['total'] ?? rows.length),
    }
  }

  /**
   * The RLS fast path: one call into the `SECURITY DEFINER` function generated
   * by `rlsSearchFunctionSql()`, which re-applies the tenant predicate itself
   * and so keeps the GIN index in the plan.
   *
   * The function has **no tenant parameter** — it scopes to the tenant the
   * connection already has in `current_setting(…)`, the same value the RLS
   * policy reads, and returns nothing when that is unset. This driver does not
   * (and must not) get to choose the tenant here; what it can do is verify,
   * which it does: a row for any tenant other than the one asked for is a
   * misconfiguration (a connection left on another tenant, a function pointed
   * at a different setting than the policy) and is refused rather than
   * returned.
   */
  private async searchViaFunction(q: string, indexName: string, query: SearchQuery): Promise<SearchResult> {
    const filters = query.filters ?? {}
    const entries = Object.entries(filters)
    const payload: Record<string, string | string[]> = {}
    for (const [field, value] of entries) {
      payload[field] = Array.isArray(value) ? value.map(String) : String(value)
    }
    const rows = (
      await this.client.query(
        `SELECT tenant_id, id, document, score, total FROM ${this.searchFunction}($1, $2, $3::jsonb, $4, $5)`,
        [q, indexName, entries.length > 0 ? JSON.stringify(payload) : null, query.limit ?? 20, query.offset ?? 0],
      )
    ).rows

    for (const row of rows) {
      if (String(row['tenant_id']) !== query.tenantId) {
        throw new Error(
          `PostgresSearchDriver: ${this.searchFunction}() returned a row for tenant ` +
            `${JSON.stringify(String(row['tenant_id']))} while searching ` +
            `${JSON.stringify(query.tenantId)}. The function scopes to the tenant in the connection's ` +
            'setting (the one the RLS policy reads) — run the search inside that tenant\'s transaction, ' +
            'and make sure the function was generated with the same `setting` as rlsPolicySql().',
        )
      }
    }

    return {
      hits: rows.map((row) => ({
        id: String(row['id']),
        score: Number(row['score'] ?? 0),
        document: row['document'] as SearchDocument,
      })),
      total: Number(rows[0]?.['total'] ?? 0),
    }
  }

  private searchableFields(indexName: string, document: SearchDocument): string[] {
    const config = this.configs.get(indexName)
    if (config) return config.fields
    return Object.keys(document).filter((k) => k !== 'id' && k !== 'tenantId' && typeof document[k] === 'string')
  }
}
