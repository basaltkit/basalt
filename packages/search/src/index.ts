export {
  defineIndex,
  type SearchDocument,
  type IndexDefinition,
  type SearchQuery,
  type SearchHit,
  type SearchResult,
  type SearchDriver,
} from './types.js'
export { MemorySearchDriver } from './memory.js'
export { Search, TenantRequiredError, type SearchOptions } from './search.js'
export {
  MeilisearchDriver,
  MeilisearchError,
  SearchFilterFieldError,
  type MeilisearchDriverOptions,
} from './drivers/meilisearch.js'
export {
  searchPlugin,
  syncRule,
  SEARCH,
  type SearchPluginOptions,
  type SyncRule,
} from './plugin.js'
