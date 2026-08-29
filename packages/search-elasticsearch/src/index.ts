import type {
  IndexDefinition,
  SearchDocument,
  SearchDriver,
  SearchQuery,
  SearchResult,
} from '@basaltkit/search'

/** Strip trailing '/' without a backtracking regex (avoids ReDoS on long runs). */
function stripTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

/**
 * Elasticsearch / OpenSearch driver for `@basaltkit/search`. Talks to the REST
 * API directly (no SDK), with an injectable `fetch` so the requests are
 * unit-tested without a cluster. Works against Elasticsearch 8.x and OpenSearch
 * 2.x, which share this query surface.
 *
 * **Tenant isolation is enforced on every operation:** documents are stored
 * under a compound id (`<tenantId>:<id>`) so ids never collide across tenants,
 * and every search is constrained with a `tenantId` term filter, so results can
 * never leak between tenants.
 */

/** Minimal fetch surface — the global `fetch` (Node 18+/browsers) is assignable. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface ElasticsearchDriverOptions {
  /** Cluster base URL, e.g. `http://localhost:9200`. */
  node: string
  /** API key → `Authorization: ApiKey <key>`. */
  apiKey?: string
  /** Basic auth (alternative to `apiKey`). */
  username?: string
  password?: string
  /** Prefix prepended to every index name (namespacing / env separation). */
  indexPrefix?: string
  /**
   * Make writes visible before the request resolves. `'wait_for'` (or `true`)
   * is handy in dev/tests; leave `false` in production for throughput and let
   * the refresh interval handle visibility.
   */
  refresh?: boolean | 'wait_for'
  /** Injected fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
}

/**
 * Index names (and the optional prefix) are interpolated into REST URL paths,
 * so they must be safe path segments. They are configuration-time identifiers,
 * not request input, but a developer building one from an external value would
 * otherwise be able to break out of the path. Elasticsearch/OpenSearch names
 * are already restricted (no uppercase, no `\/*?"<>| ,#:`), so this conservative
 * pattern is a strict subset of what the engine accepts.
 */
const SAFE_INDEX_NAME = /^[A-Za-z0-9_-]+$/

/** Throw on an index name that isn't a safe URL path segment; return it otherwise. */
export function assertValidIndexName(name: string): string {
  if (!SAFE_INDEX_NAME.test(name)) {
    throw new Error(
      `ElasticsearchDriver: invalid index name ${JSON.stringify(name)} — ` +
        'must match /^[A-Za-z0-9_-]+$/.',
    )
  }
  return name
}

export class ElasticsearchError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(`Elasticsearch request failed (${httpStatus}): ${message}`)
    this.name = 'ElasticsearchError'
  }
}

export class ElasticsearchDriver implements SearchDriver {
  private readonly node: string
  private readonly headers: Record<string, string>
  private readonly prefix: string
  private readonly refresh: boolean | 'wait_for'
  private readonly fetchImpl: FetchLike
  private readonly configs = new Map<string, IndexDefinition>()

  constructor(options: ElasticsearchDriverOptions) {
    this.node = stripTrailingSlashes(options.node)
    this.prefix = options.indexPrefix ?? ''
    // The prefix is prepended to every index name in the URL path — hold it to
    // the same safe-segment rule (empty means "no prefix", which is fine).
    if (this.prefix) assertValidIndexName(this.prefix)
    this.refresh = options.refresh ?? false
    const headers: Record<string, string> = {}
    if (options.apiKey) {
      headers.Authorization = `ApiKey ${options.apiKey}`
    } else if (options.username != null) {
      const basic = Buffer.from(`${options.username}:${options.password ?? ''}`).toString('base64')
      headers.Authorization = `Basic ${basic}`
    }
    this.headers = headers
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined)
    if (!f) throw new Error('ElasticsearchDriver: no fetch available — pass options.fetch')
    this.fetchImpl = f
  }

  private idx(name: string): string {
    return `${this.prefix}${assertValidIndexName(name)}`
  }

  /**
   * The document's `_id`: each segment percent-encoded, the `:` separator kept
   * literal. ONE definition for both the bulk body and the URL path — they used to
   * differ, so a document indexed singly and in bulk landed under two different ids
   * (and `remove()` could not delete a bulk-indexed one) whenever a segment carried
   * a URL-special character. Encoding the segments also removes the `:` ambiguity:
   * tenant `a:b` + id `c` no longer collides with tenant `a` + id `b:c`. Plain
   * UUID/slug ids are unaffected — `encodeURIComponent` leaves them untouched.
   */
  private pk(tenantId: string, id: string): string {
    return `${encodeURIComponent(tenantId)}:${encodeURIComponent(id)}`
  }

  private refreshQuery(): string {
    if (!this.refresh) return ''
    return `?refresh=${this.refresh === true ? 'true' : this.refresh}`
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(this.node + path, {
      method,
      headers: { ...this.headers, ...(body !== undefined ? { 'Content-Type': contentType } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    if (!res.ok) throw new ElasticsearchError(res.status, text)
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  }

  /** The field name to filter on — searchable (text) fields use their `.keyword` sub-field. */
  private filterField(field: string, config: IndexDefinition | undefined): string {
    return config?.fields.includes(field) ? `${field}.keyword` : field
  }

  async register(index: IndexDefinition): Promise<void> {
    this.configs.set(index.name, index)
    const properties: Record<string, unknown> = {
      id: { type: 'keyword' },
      tenantId: { type: 'keyword' },
    }
    // Searchable fields are `text` with a `.keyword` sub-field so they can also
    // be filtered/sorted; filterable-only fields are plain `keyword`.
    for (const field of index.fields) {
      properties[field] = { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } }
    }
    for (const field of index.filterable ?? []) {
      if (!(field in properties)) properties[field] = { type: 'keyword' }
    }
    try {
      await this.request('PUT', `/${this.idx(index.name)}`, { mappings: { properties } })
    } catch (error) {
      // Idempotent: an index that already exists is fine.
      if (error instanceof ElasticsearchError && error.httpStatus === 400 && /resource_already_exists/.test(error.message)) {
        return
      }
      throw error
    }
  }

  async index(indexName: string, document: SearchDocument): Promise<void> {
    const id = this.pk(document.tenantId, document.id)
    await this.request('PUT', `/${this.idx(indexName)}/_doc/${id}${this.refreshQuery()}`, document)
  }

  async bulk(indexName: string, documents: SearchDocument[]): Promise<void> {
    if (documents.length === 0) return
    const target = this.idx(indexName)
    const lines: string[] = []
    for (const doc of documents) {
      lines.push(JSON.stringify({ index: { _index: target, _id: this.pk(doc.tenantId, doc.id) } }))
      lines.push(JSON.stringify(doc))
    }
    await this.request('POST', `/_bulk${this.refreshQuery()}`, `${lines.join('\n')}\n`, 'application/x-ndjson')
  }

  async remove(indexName: string, tenantId: string, id: string): Promise<void> {
    const docId = this.pk(tenantId, id)
    try {
      await this.request('DELETE', `/${this.idx(indexName)}/_doc/${docId}${this.refreshQuery()}`)
    } catch (error) {
      if (error instanceof ElasticsearchError && error.httpStatus === 404) return // already gone
      throw error
    }
  }

  async clear(indexName: string): Promise<void> {
    try {
      await this.request('POST', `/${this.idx(indexName)}/_delete_by_query?refresh=true`, {
        query: { match_all: {} },
      })
    } catch (error) {
      if (error instanceof ElasticsearchError && error.httpStatus === 404) return
      throw error
    }
  }

  async search(indexName: string, query: SearchQuery): Promise<SearchResult> {
    const config = this.configs.get(indexName)
    const fields = config?.fields ?? []

    // Tenant scope first — never optional.
    const filter: Record<string, unknown>[] = [{ term: { tenantId: query.tenantId } }]
    for (const [key, value] of Object.entries(query.filters ?? {})) {
      const field = this.filterField(key, config)
      filter.push(Array.isArray(value) ? { terms: { [field]: value } } : { term: { [field]: value } })
    }

    const must: Record<string, unknown>[] = []
    if (query.q) {
      must.push(
        fields.length > 0
          ? { multi_match: { query: query.q, fields, type: 'best_fields' } }
          : // Fall back to `simple_query_string`, not `query_string`: the latter
            // exposes full Lucene syntax to raw user input — field probing
            // (`_index:*`), unbounded leading wildcards and regex that can pin a
            // node. `simple_query_string` never throws on bad syntax and can't
            // reach fields the user wasn't given.
            { simple_query_string: { query: query.q } },
      )
    }

    const body = {
      track_total_hits: true, // exact `total`, not the 10k cap
      from: query.offset ?? 0,
      ...(query.limit !== undefined ? { size: query.limit } : {}),
      query: { bool: { ...(must.length ? { must } : {}), filter } },
    }

    const res = await this.request('POST', `/${this.idx(indexName)}/_search`, body)
    const hitsBlock = (res.hits ?? {}) as {
      hits?: { _id: string; _score: number | null; _source: SearchDocument }[]
      total?: number | { value: number }
    }
    const hits = (hitsBlock.hits ?? []).map((h) => ({
      id: h._source.id,
      score: h._score ?? 0,
      document: h._source,
    }))
    const total = typeof hitsBlock.total === 'object' ? hitsBlock.total.value : (hitsBlock.total ?? hits.length)
    return { hits, total }
  }
}
