---
'@basaltkit/tenancy': minor
---

Custom-domain management: register a tenant's own domain, prove ownership via a
DNS TXT record, and let only **verified** domains resolve. Adds `CustomDomains`
(add/verify/list/remove/tenantOf), `DomainStore` + `MemoryDomainStore`, and
`DnsVerification`. Wire `tenantOf` into `TenantSource.findByDomain` so the
existing `domainResolver` only maps verified domains. (TLS provisioning stays
infrastructure — out of scope.)
