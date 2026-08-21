# @basaltkit/mailer

## 1.2.0

### Minor Changes

- 0496844: Add the Mailgun driver and a shared HTML layout hook.

  - **`mailgun`** — delivers via the Mailgun HTTP API (no SDK), Basic auth (`api:<key>`) over a form-encoded body, `region: 'us' | 'eu'`: `mailerPlugin({ driver: 'mailgun', mailgun: { apiKey, domain } })`. Non-2xx responses surface as `MailDeliveryError`.
  - **`layout`** — `mailerPlugin({ layout: (html, { mail }) => `…${html}…` })` wraps every rendered HTML body once, for shared branding (header/footer, per-tenant colours). Runs per send, so it can read `ctx().tenant`. Any template engine (MJML, React Email, Handlebars) still works inside a mail's own `html()`.

- b4f7874: Add a mail preview dev server — the runtime behind `basalt mail:preview`.

  - **`createMailPreviewServer(previews, { from?, layout? })`** — a zero-dependency `node:http` server that renders every registered mail (HTML with the shared layout, plaintext, and metadata) in the browser, reusing the mailer's own `resolve` so the preview is faithful to what a driver would send. Invalid sample data renders an error card instead of crashing.
  - **`definePreview({ mail, data, label? })`** — type-checks sample data against a mail's schema.
  - **`mailerPlugin({ previews: [...] })`** registers a `mail:preview` command (`--port`, default 3737) into the CLI command bucket.
  - Exposes the pure `renderPreviewResponse` router for testing/embedding.

- 86121b5: Add two API-based mail drivers, both over HTTPS with no SDK:

  - **`resend`** — delivers via the Resend API (`mailerPlugin({ driver: 'resend', resend: { apiKey } })`).
  - **`ses`** — Amazon SES v2 `SendEmail`, signed with a hand-rolled SigV4 using `node:crypto` (`mailerPlugin({ driver: 'ses', ses: { region, accessKeyId, secretAccessKey } })`) — keeps the mailer free of the AWS SDK.

  Both share the existing envelope and the header-injection guard. New `MailDeliveryError` (`MAIL_DELIVERY_FAILED`) surfaces a provider's non-2xx response. Drivers accept an injectable `fetch` (and SES an injectable clock) for testing.

## 1.1.0

### Minor Changes

- Add an `assertHeaderSafe` choke point rejecting CRLF header injection in the subject and address fields across every driver.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @basaltkit/core@0.1.0
