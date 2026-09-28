---
'@basaltkit/webhooks-sqlite': patch
'@basaltkit/webhooks-prisma': patch
---

`WebhookEndpointIdInUseError` is now the `@basaltkit/webhooks` class.

Both stores defined their own error with the same `code`
(`WEBHOOK_ENDPOINT_ID_IN_USE`) and `status` (409), so an `instanceof` check
against the class `@basaltkit/webhooks` exports — which `MemoryWebhookStore`
and `WebhookManager.register()` throw — missed a refusal from the SQLite or
Prisma store. They now throw that class and re-export it under the same name,
so existing imports from the store packages keep working and one `instanceof`
covers every store. The message now starts with `@basaltkit/webhooks:`.
