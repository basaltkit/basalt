import { BasaltError, tryCtx } from '@basaltkit/core'
import { MemorySearchDriver } from './memory.js'
import type { SearchDocument, SearchDriver, SearchInput, SearchResult } from './types.js'

/** Search was asked for a tenant it couldn't determine. */
export class TenantRequiredError extends BasaltError {
  readonly status = 400
  constructor() {
    super('SEARCH_TENANT_REQUIRED', 'A tenant is required — pass tenantId or run inside a tenant context.')
  }
}

/**
 * The scope every document lands in when the app has no tenancy at all. The
 * driver contract is tenant-keyed, so a single-tenant app still needs one
 * stable key — it just shouldn't have to invent (and remember) it.
 */
export const SINGLE_TENANT_SCOPE = 'default'

export interface SearchOptions {
  /** Defaults to the current tenant (`ctx().tenant.id`). */
  tenantId?: string
  filters?: Record<string, unknown>
  limit?: number
  offset?: number
}

/**
 * Tenant-scoped full-text search. Indexing takes the tenant from the document;
 * querying takes it from `options.tenantId` or the current request context.
 */
export class Search {
  private readonly driver: SearchDriver

  constructor(
    options: { driver?: SearchDriver } = {},
    /**
     * Whether the host app registered `@basaltkit/tenancy`. `searchPlugin`
     * wires this to the container's `'tenancy:active'` metadata marker — a
     * signal, not an import, so this generic package never depends on the
     * opt-in SaaS layer. Defaults to `false` (single-tenant).
     */
    private readonly tenancyActive: () => boolean = () => false,
  ) {
    this.driver = options.driver ?? new MemorySearchDriver()
  }

  index(indexName: string, document: SearchInput): Promise<void> {
    return this.driver.index(indexName, this.resolveDocument(document))
  }

  bulk(indexName: string, documents: SearchInput[]): Promise<void> {
    return this.driver.bulk(indexName, documents.map((document) => this.resolveDocument(document)))
  }

  async remove(indexName: string, id: string, tenantId?: string): Promise<void> {
    return this.driver.remove(indexName, this.tenant(tenantId), id)
  }

  async search(indexName: string, q: string, options: SearchOptions = {}): Promise<SearchResult> {
    return this.driver.search(indexName, {
      tenantId: this.tenant(options.tenantId),
      q,
      ...(options.filters ? { filters: options.filters } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    })
  }

  /**
   * The tenant a call is scoped to.
   *
   * With `@basaltkit/tenancy` registered an unresolvable tenant is an error:
   * indexing or querying unscoped would cross tenants. Without it there is no
   * tenant dimension, so every document shares {@link SINGLE_TENANT_SCOPE} and
   * index/query always agree.
   */
  private tenant(explicit?: string): string {
    const id = explicit ?? (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (id) return id
    if (this.tenancyActive()) throw new TenantRequiredError()
    return SINGLE_TENANT_SCOPE
  }

  /** Fills in the document's tenant with the same rule the read path uses. */
  private resolveDocument(document: SearchInput): SearchDocument {
    return { ...document, tenantId: this.tenant(document.tenantId) }
  }
}
