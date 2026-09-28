---
'@basaltkit/webhooks': major
---

Framework audit residuals (FA-070 D8 and the SSRF/registration follow-ups).

- **`MemoryWebhookStore.add()` refuses an id held by another scope**, like the SQLite and Prisma stores: re-adding an id replaces it only within the same tenant (or global), and a cross-scope id throws the new `WebhookEndpointIdInUseError` (`WEBHOOK_ENDPOINT_ID_IN_USE`, 409). The check and write are atomic, so two concurrent `register()` calls with the same id from two tenants no longer let the second overwrite the first. `WebhookManager.register()` throws the same error from its pre-check (it used to be a plain `Error`).
- **`register()` validates the endpoint before storing it.** A `url` that is not an absolute URL, a scheme outside the deliverer's allowlist (`ssrf.allowedSchemes`, default `http:`/`https:` — new `WebhookDeliverer.allowedSchemes` getter), a `secret` shorter than `MIN_WEBHOOK_SECRET_LENGTH` (16), or an empty/invalid `events` list throws the new `WebhookEndpointInvalidError` (`WEBHOOK_ENDPOINT_INVALID`, 400). These endpoints used to be stored and then fail on every delivery. Host reachability is still checked at delivery time.
- **SSRF guard blocks more special-purpose ranges:** the documentation networks `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, the deprecated 6to4 relay anycast `192.88.99.0/24`, and the IPv6 documentation prefix `3fff::/20` (RFC 9637) — including when embedded in IPv4-mapped, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses. (`198.18.0.0/15`, `240.0.0.0/4`, `100.64.0.0/10` and `2001:db8::/32` were already blocked.)

**Why major:** `register()` now throws for endpoints it used to accept (bad URL, short secret, empty events), and `MemoryWebhookStore.add()` throws where it used to overwrite another tenant's endpoint. Migration: validate endpoint input before calling `register()` (or map `WEBHOOK_ENDPOINT_INVALID` to a 400); custom stores should refuse cross-scope ids in `add()` the same way.
