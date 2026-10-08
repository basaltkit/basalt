---
"@basaltkit/webhooks": minor
---

Operable webhooks (BK-084), all opt-in:

- **Sealed secrets at rest** — `secretBox` (on `webhooksPlugin` and `WebhookManagerOptions`): an app-supplied `{ seal, open, isSealed? }` that `register()` / `rotateSecret()` apply before the store write (the current and the previous secret) and the manager reverses before each delivery. The context `{ endpointId, tenantId }` can be bound into the ciphertext. Legacy plaintext rows keep delivering (via `isSealed()` or a `WebhookSecretNotSealedError` from `open()`) and are sealed on the next rotation. Both calls still return the plaintext secret. No crypto dependency is added.
- **Attempt telemetry** — `DeliveryResult.durationMs` (whole delivery) and an `onAttempt` deliverer option called after every attempt with `{ deliveryId, endpointId, tenantId?, event, attempt, ok, status?, durationMs, error?, at }`. Not awaited; a throwing hook is logged and swallowed. No delivery-log store and no response-body capture.
- **Header prefix** — `headerPrefix` deliverer option (default `x-basalt`, validated `[a-z][a-z0-9-]{0,31}`) and a `webhookHeaderNames(prefix)` helper for receivers.

Docs: sealing, telemetry, header prefix and a schema-per-tenant recipe (`prismaWebhookStore(tenantClient())`, and why the outbox relay does not fit that layout).
