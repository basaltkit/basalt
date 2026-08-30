/**
 * A document as the driver sees it: `tenantId` is always resolved by the time
 * it reaches the driver. Callers pass a {@link SearchInput}.
 */
export interface SearchDocument {
  id: string
  tenantId: string
  [field: string]: unknown
}

/**
 * A document as callers provide it. `tenantId` is optional: `Search` resolves
 * it from the ambient tenant, and in an app with no `tenancyPlugin` falls back
 * to {@link SINGLE_TENANT_SCOPE} — so a non-SaaS app indexes and queries the
 * same scope without inventing a tenant id.
 */
export interface SearchInput {
  id: string
  tenantId?: string
  [field: string]: unknown
}

/** Declares an index: which fields are searchable (full-text) and filterable. */
export interface IndexDefinition {
  name: string
  /** Text fields matched by the query. */
  fields: string[]
  /** Fields usable in `filters` (exact match). `tenantId` is always filterable. */
  filterable?: string[]
}

export function defineIndex(definition: IndexDefinition): IndexDefinition {
  return definition
}

export interface SearchQuery {
  tenantId: string
  q: string
  /** Exact-match filters. A value array means "any of". */
  filters?: Record<string, unknown>
  limit?: number
  offset?: number
}

export interface SearchHit {
  id: string
  score: number
  document: SearchDocument
}

export interface SearchResult {
  hits: SearchHit[]
  /** Total matches (before limit/offset). */
  total: number
}

/**
 * Search backend contract. The core talks to this; drivers talk to the engine.
 * Every operation is tenant-scoped: `search` must only ever return documents
 * whose `tenantId` matches the query.
 */
export interface SearchDriver {
  /** Optional: called once per index at boot with its config. */
  register?(index: IndexDefinition): Promise<void>
  index(indexName: string, document: SearchDocument): Promise<void>
  bulk(indexName: string, documents: SearchDocument[]): Promise<void>
  remove(indexName: string, tenantId: string, id: string): Promise<void>
  search(indexName: string, query: SearchQuery): Promise<SearchResult>
  /** Drops every document in the index (used by tests). */
  clear(indexName: string): Promise<void>
}
