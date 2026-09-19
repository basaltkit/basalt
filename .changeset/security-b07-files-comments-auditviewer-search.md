---
'@basaltkit/files': major
'@basaltkit/comments': major
'@basaltkit/audit-viewer': major
'@basaltkit/search': minor
---

Security hardening (deep audit 2026-09, batch B07).

- `@basaltkit/files`: `fileRoutes()` now enforces object-level authorization — owner-only (`uploadedBy === ctx().user.id`) by default, with `authorize(action, record, user)` and `shared: true` as explicit options; files the caller may not reach answer 404 (including `DELETE`). `POST /files/:id/url` validates `expiresIn` (positive, at most `maxUrlTtl`, default `1h`) and answers 400 otherwise. The `maxTotalBytes` quota is serialised per tenant and re-checked after insert, so concurrent uploads can no longer exceed it. `MemoryFileStore` uses tuple-safe keys.
- `@basaltkit/comments`: bodies are capped (`maxBodyLength`, default 10 000 characters) and mentions per comment are capped (`maxMentions`, default 50); new `resolveMentions(ids, tenantId)` option filters who can be mentioned. `commentRoutes({ authorize })` adds a per-resource authorization hook; by default resolve/reopen are restricted to the comment's author, like edit/delete. `MemoryCommentStore` uses tuple-safe keys.
- `@basaltkit/audit-viewer`: `auditViewerRoutes()` requires an authorization guard via `meta` (e.g. `{ can: 'audit:read' }`) merged into every route, and throws `AuditViewerUnguardedError` without one unless `allowAnyAuthenticated: true` is passed explicitly.
- `@basaltkit/files`, `@basaltkit/comments`, `@basaltkit/audit-viewer`, `@basaltkit/search`: inside a tenant context an explicit `tenantId` argument must match the context tenant (it can no longer widen a call to another tenant); a mismatch throws a `*_TENANT_MISMATCH` error (403). `search.reindex()` still trusts the tenant each sync rule maps.
