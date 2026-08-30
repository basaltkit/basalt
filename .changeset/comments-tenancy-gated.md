---
'@basaltkit/comments': minor
---

Comments works in apps without tenancy.

`on()`, `get()`, `edit()`, `remove()`, `resolve()` and `reopen()` all threw `CommentTenantRequiredError` (`400 COMMENT_TENANT_REQUIRED`) when no tenant could be resolved — which, with no `tenancyPlugin` registered, was every call.

`commentsPlugin` now reads tenancy's `tenancy:active` metadata marker (a signal, not an import) and fails closed only when tenancy is registered. Without it, comments are filed under the exported `SINGLE_TENANT_SCOPE` (`'default'`). Multi-tenant behavior is unchanged. `new Comments(options, tenancyActive?)` takes an optional second argument.
