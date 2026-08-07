# @machize/flags

## 0.9.0

### Patch Changes

- @machize/core@0.9.0

## 0.8.1

### Patch Changes

- @machize/core@0.8.1

## 0.8.0

### Patch Changes

- @machize/core@0.8.0

## 0.7.0

### Patch Changes

- @machize/core@0.7.0

## 0.6.0

### Patch Changes

- @machize/core@0.6.0

## 0.5.1

### Patch Changes

- @machize/core@0.5.1

## 0.5.0

### Patch Changes

- @machize/core@0.5.0

## 0.4.0

### Patch Changes

- @machize/core@0.4.0

## 0.3.0

### Minor Changes

- 252b1f7: Two new packages:

  - `@machize/flags` — feature flags evaluated against a context (falling back to the request's tenant/user), with per-tenant and per-user overrides, deterministic percentage rollouts, and custom rules. `defineFlags`, `flagsPlugin`, `FLAGS`.
  - `@machize/webhooks` — outbound webhooks with HMAC-signed delivery (Stripe-style `t=…,v1=…`), retries with exponential backoff, per-tenant subscriptions, and automatic tenant-scoped dispatch from domain events. `webhooksPlugin`, `WEBHOOKS`, `WebhookDeliverer`, `verifySignature`.

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @machize/core@0.3.0
