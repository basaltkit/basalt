export {
  defineIndex,
  type SearchDocument,
  type SearchInput,
  type IndexDefinition,
  type SearchQuery,
  type SearchHit,
  type SearchResult,
  type SearchDriver,
} from './types.js'
export { MemorySearchDriver } from './memory.js'
export {
  Search,
  SINGLE_TENANT_SCOPE,
  TenantRequiredError,
  SearchTenantMismatchError,
  SearchTenantReservedError,
  SearchPaginationError,
  SearchFilterNotFilterableError,
  SearchFilterValueError,
  SearchReindexScopeError,
  SearchDriverCapabilityError,
  DEFAULT_MAX_LIMIT,
  DEFAULT_MAX_OFFSET,
  DEFAULT_MAX_SCAN,
  type ReindexOptions,
  type SearchOptions,
  type SearchServiceOptions,
} from './search.js'
export {
  MeilisearchDriver,
  MeilisearchError,
  SearchFilterFieldError,
  SearchIndexNameError,
  type MeilisearchDriverOptions,
} from './drivers/meilisearch.js'
export {
  searchPlugin,
  syncRule,
  SEARCH,
  type SearchPluginOptions,
  type SyncRule,
} from './plugin.js'
