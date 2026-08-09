# Webhooks

`@basaltkit/webhooks` delivers **outbound** webhooks: signed payloads, retries with
backoff, per-tenant subscriptions, and automatic dispatch from your domain
events.

## Auto-dispatch from events

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'

webhooksPlugin({
  secret: env.WEBHOOK_SECRET,          // default signing secret
  events: ['invoice.*', 'user.created'], // domain events to fan out
})
```

When a matching event is emitted on the bus, every subscribed endpoint receives
a signed `POST` — tenant-scoped from the request context, and fire-and-forget so
the emitter never blocks on HTTP.

## Managing subscriptions

```ts
import { WEBHOOKS } from '@basaltkit/webhooks'

const hooks = container.get(WEBHOOKS)
await hooks.register({
  url: 'https://customer.example.com/hooks',
  events: ['invoice.paid'],
  tenantId: 'acme',        // omit to receive from all tenants
  secret: 'whsec_...',     // optional per-endpoint secret
})

await hooks.list('acme')
await hooks.dispatch('invoice.paid', { id: 'in_1' }, 'acme') // manual dispatch
```

The default store is in-memory; implement `WebhookStore` over your database for
persistence.

## Signing & verification

Each delivery carries `X-Basalt-Signature: t=<unix>,v1=<hmac-sha256(t.body)>` —
the same scheme Stripe uses. Receivers recompute the HMAC over `timestamp.body`
and compare in constant time, rejecting stale timestamps to prevent replay.

```ts
import { verifySignature } from '@basaltkit/webhooks'

// in your receiver
const valid = verifySignature(req.headers['x-basalt-signature'], rawBody, secret)
```

## Delivery semantics

- Transient failures (`5xx`, network errors, timeouts) retry with exponential
  backoff (`maxRetries`, default 3).
- Client errors (`4xx`) are **not** retried.
- `dispatch()` returns a `DeliveryResult[]` (status + attempts per endpoint) —
  persist it for an audit trail, or drive delivery from `@basaltkit/queue` for
  durable, distributed retries.
