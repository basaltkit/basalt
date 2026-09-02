# @basaltkit/mailer

## 2.0.0

### Major Changes

- 48579dd: ## ⚠️ BREAKING — the SMTP driver moved to `@basaltkit/mailer-smtp`
  
  `@basaltkit/mailer` hard-depended on `nodemailer` — about **688 KB** — because
  of the `driver: 'smtp'` shorthand. Every app paid for it, including those sending
  through Resend, SES or Mailgun, which are plain HTTP APIs that never open an SMTP
  socket.
  
  ### Migration
  
  ```bash
  pnpm add @basaltkit/mailer-smtp nodemailer
  ```
  
  ```diff
  +import { smtpMailer } from '@basaltkit/mailer-smtp'
  
  -mailerPlugin({ driver: 'smtp', smtp: { url: process.env.SMTP_URL! }, from })
  +mailerPlugin({ driver: smtpMailer({ url: process.env.SMTP_URL! }), from })
  ```
  
  Passing `'smtp'` now throws with that instruction rather than "unknown driver" —
  TypeScript rejects it too, since it left the union.
  
  **Unaffected:** `log`, `memory`, `resend`, `ses` and `mailgun` all stay in the
  core. None of them needs a client library.
  
  ### `driver` now accepts an instance
  
  ```ts
  mailerPlugin({ driver: myCustomDriver })
  ```
  
  Previously `createDriver` was a `switch` over strings with no instance branch, so
  **a custom `MailDriver` could not be used at all**. Extracting SMTP required
  adding that, and it is useful well beyond this change.
  
  ### What this leaves behind
  
  `@basaltkit/mailer` depends on nothing but `@basaltkit/core`. The repo-wide
  driver-boundary tripwire's allowlist is now **empty** — this was the last of the
  four KNOWN DEBT entries.

## 1.4.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1

## 1.4.0

### Minor Changes

- cc4786e: **Security (S-6): the log mail driver redacts message bodies in production, and an unknown driver name fails loud.** The silent default driver (`driver` unset) printed the FULL mail body — password-reset links, magic links, tokens — to stdout, where log aggregators retain it; and any typo'd `driver` string silently fell through to that same behavior. Now: `LogMailDriver` logs metadata (mail name, recipients, subject) but redacts the body when `NODE_ENV=production` — opt back in explicitly with the new `logBody: true` option (dev/test behavior is unchanged: bodies still print, which is what makes the driver useful locally). An unrecognized `driver` value throws at mailer resolution with the list of valid drivers instead of silently logging your outbound mail.

## 1.3.0

### Minor Changes

- 1050b3d: **Security: safe-by-default HTML mail bodies via the `html\`\`` tagged template.**
  
  **What was exposed.** Mail bodies are HTML built from schema data that is usually user-controlled (names, titles). The documented idiom interpolated it bare — `html: ({ name }) => \`<h1>Hello ${name}</h1>\`` — so a crafted value injected markup into mail sent from your own DKIM/SPF-aligned domain (phishing content, tracking pixels, XSS in permissive webmail). The only `escapeHtml` was module-private.
  
  **What changed.** New `html\`\`` tagged template escapes **every** interpolation automatically — the safe path is now the default path, not a thing to remember. It returns a composable `SafeHtml` (nested `html\`\`` results and `raw()` fragments pass through un-re-escaped; arrays render item-by-item; `null`/`undefined` render empty), and stringifies straight into a mail definition's `html` field (its return type is widened to `string | SafeHtml`, backward-compatible). `escapeHtml`, `html`, `raw`, and `SafeHtml` are now exported. Docs (README + notifications/cookbook, EN+PT) updated to the safe idiom. Separately, `Mailer.deliver()` (the queue-worker path) now runs the same `assertHeaderSafe` header-injection guard as `send()`. Existing `html: (data) => string` definitions keep working unchanged — but plain template strings are not escaped, so prefer `html\`\``.

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
