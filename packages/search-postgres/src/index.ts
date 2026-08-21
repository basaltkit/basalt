import type { IndexDefinition, SearchDocument, SearchDriver, SearchQuery, SearchResult } from '@basaltkit/search'

/** The subset of a `pg` Pool/Client this driver uses. */
export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export interface PostgresSearchOptions {
  /** A connected `pg` Pool or Client. */
  client: PgClientLike
  /** Table that holds every index (created by `register`). Default `basalt_search`. */
  table?: string
  /** Text-search configuration (stemming/stop-words). Default `english`. */
  language?: string
}

/** A single unquoted SQL identifier: starts with a letter/underscore, then word chars. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate a table name before it is string-interpolated into DDL/DML. The
 * table name is a configuration-time identifier (never request input), but a
 * developer wiring it from an external value would otherwise have a SQL
 * injection. Accepts a bare identifier or a `schema.table` pair, each part a
 * valid identifier. Returns the (unchanged) name so it can be used inline.
 */
export function assertValidTableName(table: string): string {
  const parts = table.split('.')
  if (parts.length > 2 || parts.some((part) => !SAFE_IDENTIFIER.test(part))) {
    throw new Error(
      `PostgresSearchDriver: invalid table name ${JSON.stringify(table)} — ` +
        'must be a SQL identifier matching /^[A-Za-z_][A-Za-z0-9_]*$/ ' +
        '(optionally schema-qualified as "schema.table").',
    )
  }
  return table
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
  private readonly configs = new Map<string, IndexDefinition>()

  constructor(options: PostgresSearchOptions) {
    this.client = options.client
    this.table = assertValidTableName(options.table ?? 'basalt_search')
    this.language = options.language ?? 'english'
  }

  async register(index: IndexDefinition): Promise<void> {
    this.configs.set(index.name, index)
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (` +
        `idx text NOT NULL, tenant_id text NOT NULL, id text NOT NULL, ` +
        `document jsonb NOT NULL, tsv tsvector, PRIMARY KEY (idx, tenant_id, id))`,
    )
    await this.client.query(`CREATE INDEX IF NOT EXISTS ${this.table}_tsv_idx ON ${this.table} USING gin(tsv)`)
  }

  async index(indexName: string, document: SearchDocument): Promise<void> {
    const text = this.searchableFields(indexName, document)
      .map((field) => String(document[field] ?? ''))
      .join(' ')
    await this.client.query(
      `INSERT INTO ${this.table} (idx, tenant_id, id, document, tsv) ` +
        `VALUES ($1, $2, $3, $4::jsonb, to_tsvector($5, $6)) ` +
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
    const params: unknown[] = [indexName, query.tenantId]
    let score = '0'
    let where = 'idx = $1 AND tenant_id = $2'

    const q = (query.q ?? '').trim()
    if (q) {
      const langIdx = params.push(this.language)
      const qIdx = params.push(q)
      const tsquery = `plainto_tsquery($${langIdx}, $${qIdx})`
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

  private searchableFields(indexName: string, document: SearchDocument): string[] {
    const config = this.configs.get(indexName)
    if (config) return config.fields
    return Object.keys(document).filter((k) => k !== 'id' && k !== 'tenantId' && typeof document[k] === 'string')
  }
}
