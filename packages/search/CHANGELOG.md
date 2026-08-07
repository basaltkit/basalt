# @machize/search

## 0.22.0

### Patch Changes

- @machize/core@0.22.0

## 0.21.0

### Patch Changes

- @machize/core@0.21.0

## 0.20.0

### Patch Changes

- @machize/core@0.20.0

## 0.19.0

### Patch Changes

- @machize/core@0.19.0

## 0.18.0

### Patch Changes

- @machize/core@0.18.0

## 0.17.0

### Patch Changes

- @machize/core@0.17.0

## 0.16.0

### Patch Changes

- @machize/core@0.16.0

## 0.15.0

### Patch Changes

- @machize/core@0.15.0

## 0.14.0

### Patch Changes

- @machize/core@0.14.0

## 0.13.0

### Patch Changes

- @machize/core@0.13.0

## 0.12.0

### Patch Changes

- @machize/core@0.12.0

## 0.11.0

### Patch Changes

- @machize/core@0.11.0

## 0.10.0

### Minor Changes

- 49d9723: New package: `@machize/search` — tenant-scoped full-text search.

  A `Search` service indexes and queries documents through a pluggable `SearchDriver`, with every query forced to the caller's `tenantId` so results never leak between tenants. `MemorySearchDriver` gives real term-frequency + prefix relevance (AND semantics, field restriction, exact/array filters) for dev and tests with no external service; `MeilisearchDriver` targets the Meilisearch REST API for production (compound per-tenant primary keys, automatic `tenantId` filtering, injectable `fetch` for tests). `searchPlugin({ indexes, sync })` registers indexes and keeps them in sync with domain hooks via `syncRule({ hook, index, document | remove })`. The tenant is read from `options.tenantId` or the request context. Fully unit-tested — relevance, tenant isolation, filters, the sync bridge, and the Meilisearch request shapes — without any external engine.

### Patch Changes

- @machize/core@0.10.0
