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
  DEFAULT_MAX_LIMIT,
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
