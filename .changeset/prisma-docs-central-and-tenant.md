---
'@basaltkit/prisma': patch
---

Document combining `client` with `schemaPerTenant`/`forTenant` so one app can
serve central and tenant routes from the same plugin registration.

The option table already said `client` doubles as "the client for the tenant-less
context", and one sentence noted the modes combine — but with no example, and
without the trade-off that makes it worth stating: dropping `client` means a
tenant route reached with no tenant throws `DB_UNAVAILABLE`, while setting it
means that same route quietly reads the **central** database instead. The README
now shows the pairing (`required: true` plus `meta: { tenant: false }` on the
routes that are genuinely central) that keeps the failure loud.

Docs only — no runtime change.
