---
'@basaltkit/tenancy': major
---

Framework audit residual: stale verified custom-domain claims.

A verified custom-domain claim never expired, and only the operator's `verify(tenantId, domain, { force: true })` — which needs the stale owner's tenant id — could displace it; the new owner of a lapsed domain had no supported path.

- **`CustomDomains.reverify(domain)`** (system-only) re-checks whichever tenant holds the domain and un-verifies the claim when DNS definitively says the record is gone (NXDOMAIN, no TXT, no matching value). A timeout/SERVFAIL returns `dns-error` and changes nothing; the un-verify is conditional through `DomainStore.replace`, so a claim that changed hands meanwhile is left alone (`changed`). Returns `{ domain, tenantId, status }` (`DomainReverifyStatus`: `valid` | `revoked` | `dns-error` | `unverified` | `changed`), or `null` for an unknown domain.
- **`CustomDomains.reverifyAll({ domains? })`** runs it over every verified domain from the new optional `DomainStore.listVerified()` (implemented by `MemoryDomainStore`), or over the domains you pass; returns `{ checked, revoked, errors, results }`. Meant for a scheduled job.
- **A stale verified claim yields to a proven challenger.** With `challengeSecret` set, when the new owner publishes its `challenge()` record and calls `add()`, and the same lookup no longer shows the incumbent's record, the domain is handed over, verified. While the incumbent's record is still published, or the lookup fails, `add()` still throws `DomainTakenError`.

**Why major:** a verified domain is no longer permanent — another tenant can take it over once the incumbent's TXT record is gone and the challenger's is published. Migration: keep the `_basalt-verify.<domain>` TXT record published for as long as a domain should stay verified (the docs already required this for `force` re-checks); schedule `reverifyAll()`; durable `DomainStore`s should implement `replace()` and `listVerified()`.
