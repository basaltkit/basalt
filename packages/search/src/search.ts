import { BasaltError, tryCtx } from '@basaltkit/core'
import { MemorySearchDriver } from './memory.js'
import type { SearchDocument, SearchDriver, SearchResult } from './types.js'

/** Search was asked for a tenant it couldn't determine. */
export class TenantRequiredError extends BasaltError {
  readonly status = 400
  constructor() {
    super('SEARCH_TENANT_REQUIRED', 'A tenant is required — pass tenantId or run inside a tenant context.')
  }
}

const currentTenant = (explicit?: string): string => {
  const id = explicit ?? (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
  if (!id) throw new TenantRequiredError()
  return id
}

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

  constructor(options: { driver?: SearchDriver } = {}) {
    this.driver = options.driver ?? new MemorySearchDriver()
  }

  index(indexName: string, document: SearchDocument): Promise<void> {
    return this.driver.index(indexName, document)
  }

  bulk(indexName: string, documents: SearchDocument[]): Promise<void> {
    return this.driver.bulk(indexName, documents)
  }

  async remove(indexName: string, id: string, tenantId?: string): Promise<void> {
    return this.driver.remove(indexName, currentTenant(tenantId), id)
  }

  async search(indexName: string, q: string, options: SearchOptions = {}): Promise<SearchResult> {
    return this.driver.search(indexName, {
      tenantId: currentTenant(options.tenantId),
      q,
      ...(options.filters ? { filters: options.filters } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    })
  }
}
