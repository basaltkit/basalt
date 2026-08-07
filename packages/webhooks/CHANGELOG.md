# @machize/webhooks

## 0.17.0

### Patch Changes

- @machize/core@0.17.0
- @machize/events@0.17.0

## 0.16.0

### Patch Changes

- @machize/core@0.16.0
- @machize/events@0.16.0

## 0.15.0

### Patch Changes

- @machize/core@0.15.0
- @machize/events@0.15.0

## 0.14.0

### Patch Changes

- @machize/core@0.14.0
- @machize/events@0.14.0

## 0.13.0

### Patch Changes

- @machize/core@0.13.0
- @machize/events@0.13.0

## 0.12.0

### Patch Changes

- @machize/core@0.12.0
- @machize/events@0.12.0

## 0.11.0

### Patch Changes

- @machize/core@0.11.0
- @machize/events@0.11.0

## 0.10.0

### Patch Changes

- @machize/core@0.10.0
- @machize/events@0.10.0

## 0.9.0

### Patch Changes

- @machize/core@0.9.0
- @machize/events@0.9.0

## 0.8.1

### Patch Changes

- @machize/core@0.8.1
- @machize/events@0.8.1

## 0.8.0

### Patch Changes

- @machize/core@0.8.0
- @machize/events@0.8.0

## 0.7.0

### Patch Changes

- @machize/core@0.7.0
- @machize/events@0.7.0

## 0.6.0

### Patch Changes

- @machize/core@0.6.0
- @machize/events@0.6.0

## 0.5.1

### Patch Changes

- @machize/core@0.5.1
- @machize/events@0.5.1

## 0.5.0

### Patch Changes

- @machize/core@0.5.0
- @machize/events@0.5.0

## 0.4.0

### Patch Changes

- @machize/core@0.4.0
- @machize/events@0.4.0

## 0.3.0

### Minor Changes

- 252b1f7: Two new packages:

  - `@machize/flags` — feature flags evaluated against a context (falling back to the request's tenant/user), with per-tenant and per-user overrides, deterministic percentage rollouts, and custom rules. `defineFlags`, `flagsPlugin`, `FLAGS`.
  - `@machize/webhooks` — outbound webhooks with HMAC-signed delivery (Stripe-style `t=…,v1=…`), retries with exponential backoff, per-tenant subscriptions, and automatic tenant-scoped dispatch from domain events. `webhooksPlugin`, `WEBHOOKS`, `WebhookDeliverer`, `verifySignature`.

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @machize/core@0.3.0
  - @machize/events@0.3.0
