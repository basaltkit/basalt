---
'@basaltkit/webhooks': major
'@basaltkit/webhooks-sqlite': minor
'@basaltkit/webhooks-prisma': minor
---

Webhook delivery limits and sender-side secret rotation (framework audit, "Melhorias" item 6).

- **Port policy.** Deliveries used to go to any port of a public host, so an endpoint could point the sender at someone's exposed Redis (`:6379`), memcached (`:11211`), Postgres (`:5432`) or SMTP (`:25`). The SSRF guard now allows `80`, `443` and every port from `1024` up except `DEFAULT_BLOCKED_PORTS` (databases, caches, message brokers, cluster control planes, proxies, remote admin). Privileged ports other than HTTP(S) are refused. Configure with `ssrf.allowedPorts` (an array allows exactly those ports; `'any'` turns the policy off). The policy is enforced by `resolveAndValidate()` (before any DNS lookup, with `allowPrivateHosts` too), by every delivery (`WebhookUrlBlockedError`, `attempts: 0`, `retryable: false`) and by `register()` (`WebhookEndpointInvalidError`). Redirects are still never followed. New exports: `DEFAULT_BLOCKED_PORTS`, `isPortAllowed`, `effectivePort`, `WebhookDeliverer#allowsPort`.
- **DNS resolution runs inside the per-attempt deadline.** `timeoutMs` now covers resolving the host and the request together. A resolver that hangs used to hold the delivery (and an outbox flush waiting on it) indefinitely. Now the attempt fails as a transient error (`host resolution timed out`, `retryable: true`) and the next attempt resolves again.
- **Dispatch fan-out cap and concurrency.** `dispatch()` refuses a scope (one tenant, or the tenant-agnostic set) whose active endpoints matching the event exceed `maxEndpointsPerDispatch` (default 100, `false` disables it). None of that scope's endpoints is sent to. Each one gets a failed result (`fan-out cap exceeded…`, `retryable: false`), and `onFanOutExceeded` is called once per scope (default `console.warn`). Other scopes are unaffected. Deliveries now run at most `dispatchConcurrency` at a time (default 16) instead of all at once. Both options can be set on `webhooksPlugin` and `WebhookManager`.
- **Sender-side secret rotation.** New `WebhookManager.rotateSecret(id, { graceSeconds?, secret?, tenantId?, system? })` rotates an endpoint's secret without breaking its receiver. For the grace window (default 24 h, at most 30 days, `0` for an immediate cut-over), every delivery is signed with both secrets (`t=…,v1=<new>,v1=<old>`), which `verifySignature` and other Stripe-style receivers accept. Before this, the README described rotation that only receivers supported. `WebhookEndpoint` gains the optional `previousSecret` and `previousSecretExpiresAt`. `list()` redacts both secrets. Re-registering an endpoint during a rotation ends the rotation. `signPayload()` accepts an array of secrets. New `WebhookEndpointNotFoundError` (404) and the `DEFAULT_SECRET_ROTATION_GRACE_SECONDS` / `MAX_SECRET_ROTATION_GRACE_SECONDS` constants.
- **webhooks-sqlite:** `migrate()` adds the nullable `previous_secret` and `previous_secret_expires_at` columns, including to an existing table (`ALTER TABLE`).
- **webhooks-prisma:** the reference schemas (`schema.prisma`, `schema.mysql.prisma`) add `previousSecret String?` (`@db.Text` on MySQL) and `previousSecretExpiresAt DateTime?`. The `'mysql'` column-limit preset covers `previousSecret`. The store writes these columns only when an endpoint carries rotation state, so a schema without them keeps working until you call `rotateSecret()`.

**Why major (`@basaltkit/webhooks`):** endpoints on a blocked port that used to receive deliveries are now refused, both at `register()` and at delivery. Dispatches over 100 endpoints per event per scope are refused. Deliveries per dispatch are bounded to 16 in flight.

Migration:
- An endpoint that legitimately listens on a blocked port needs `ssrf: { allowedPorts: [...] }`, or `'any'`.
- If a scope really has more than 100 endpoints for one event, raise `maxEndpointsPerDispatch`.
- If a custom store should support rotation, it must persist `previousSecret`/`previousSecretExpiresAt` and, when `add()` gets those keys set to `undefined`, clear them.
- Prisma users run `basalt prisma:sync` (or copy the two fields) and migrate before calling `rotateSecret()`.
- `@basaltkit/drives` validates its outbound fetches with `resolveAndValidate`, so it gets the same port policy on every hop.
