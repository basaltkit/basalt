---
'@basaltkit/subscriptions': minor
---

Add invoicing (billing depth): an `Invoices` engine with a draft → open → paid
state machine, line items, discount/tax and totals in minor units, plus
`planLine`/`overageLine` builders, text/HTML renderers, a `MemoryInvoiceStore`
(and `InvoiceStore` interface) and an `INVOICES` DI token. `invoiceRoutes()`
exposes read-only per-tenant invoice endpoints built on the neutral `route()` —
verified on the Fastify, Express and Hono adapters.
