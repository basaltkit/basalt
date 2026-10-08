---
'@basaltkit/webhooks-prisma': patch
---

README: document the two schema-per-tenant layouts: central webhook tables (the simplest), or endpoints per tenant through `tenantClient()` with the outbox kept central and `webhookOutboxPlugin({ tenantOnly: true })`.
