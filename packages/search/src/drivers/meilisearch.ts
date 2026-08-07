import { MachizeError } from '@machize/core'
import type { IndexDefinition, SearchDocument, SearchDriver, SearchQuery, SearchResult } from '../types.js'

export class MeilisearchError extends MachizeError {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super('SEARCH_ENGINE_ERROR', `Meilisearch request failed (${httpStatus}): ${message}`)
  }
}

export interface MeilisearchDriverOptions {
  host: string
  apiKey?: string
  /** Injected fetch (tests). Default: global fetch. */
  fetch?: typeof fetch
}

/** Stable Meilisearch primary key from (tenant, id) — always a valid doc id. */
const primaryKey = (tenantId: string, id: string): string =>
  Buffer.from(`${tenantId}::${id}`).toString('base64url')

const quote = (value: unknown): string => JSON.stringify(value)

/**
 * Meilisearch driver targeting the REST API directly (no SDK). Documents get a
 * compound `_pk` so ids never collide across tenants, and every search is
 * constrained with a `tenantId` filter so results never leak between tenants.
 */
export class MeilisearchDriver implements SearchDriver {
  private readonly fetch: typeof fetch

  constructor(private readonly options: MeilisearchDriverOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
  }

  async register(index: IndexDefinition): Promise<void> {
    // Create the index (ignore "already exists"), then declare attributes.
    try {
      await this.request('POST', '/indexes', { uid: index.name, primaryKey: '_pk' })
    } catch {
      // index_already_exists and similar are fine to ignore on register.
    }
    await this.request('PATCH', `/indexes/${index.name}/settings`, {
      searchableAttributes: index.fields,
      filterableAttributes: ['tenantId', ...(index.filterable ?? [])],
    })
  }

  async index(indexName: string, document: SearchDocument): Promise<void> {
    await this.bulk(indexName, [document])
  }

  async bulk(indexName: string, documents: SearchDocument[]): Promise<void> {
    const withPk = documents.map((d) => ({ ...d, _pk: primaryKey(d.tenantId, d.id) }))
    await this.request('PUT', `/indexes/${indexName}/documents`, withPk)
  }

  async remove(indexName: string, tenantId: string, id: string): Promise<void> {
    await this.request('DELETE', `/indexes/${indexName}/documents/${primaryKey(tenantId, id)}`)
  }

  async clear(indexName: string): Promise<void> {
    await this.request('DELETE', `/indexes/${indexName}/documents`)
  }

  async search(indexName: string, query: SearchQuery): Promise<SearchResult> {
    const result = (await this.request('POST', `/indexes/${indexName}/search`, {
      q: query.q,
      filter: this.buildFilter(query.tenantId, query.filters),
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
      showRankingScore: true,
    })) as { hits?: Record<string, unknown>[]; estimatedTotalHits?: number }

    const hits = (result.hits ?? []).map((hit) => {
      const { _pk, _rankingScore, ...document } = hit
      void _pk
      return {
        id: String(document['id']),
        score: typeof _rankingScore === 'number' ? _rankingScore : 0,
        document: document as unknown as SearchDocument,
      }
    })
    return { hits, total: result.estimatedTotalHits ?? hits.length }
  }

  private buildFilter(tenantId: string, filters: Record<string, unknown> | undefined): string {
    const parts = [`tenantId = ${quote(tenantId)}`]
    for (const [field, value] of Object.entries(filters ?? {})) {
      parts.push(Array.isArray(value) ? `${field} IN [${value.map(quote).join(', ')}]` : `${field} = ${quote(value)}`)
    }
    return parts.join(' AND ')
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetch(`${this.options.host}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    const json: unknown = text ? JSON.parse(text) : {}
    if (!response.ok) {
      const message = (json as { message?: string }).message ?? text ?? 'unknown error'
      throw new MeilisearchError(response.status, message)
    }
    return json
  }
}
