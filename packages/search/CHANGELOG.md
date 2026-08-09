# @machize/search

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@machize/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.24.0

### Patch Changes

- @machize/core@0.24.0

## 0.23.0

### Patch Changes

- @machize/core@0.23.0

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
