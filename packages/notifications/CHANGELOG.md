# @basaltkit/notifications

## 1.2.3

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1
  - @basaltkit/mailer@1.4.1

## 1.2.1

### Patch Changes

- c305a67: Security hardening from a deep adversarial audit of this release's new components.

  - **dashboard (CRITICAL):** `brandingStyleSheet`/`brandingCssVars` now strictly validate custom-property names and values and drop anything that could break out of the `<style>` element — closes a tenant-controlled stored-XSS/CSS-injection vector in the white-label shell. Analytics `subscriptionMrr` uses `Number.isFinite` so `NaN`/`Infinity` prices can't poison MRR.
  - **auth:** the WebAuthn registration challenge is now bound to its subject — `finishRegistration` throws `WEBAUTHN_SUBJECT_MISMATCH` unless the `userId` matches the one `startRegistration` was called with (prevents binding a passkey to another account), rejects a duplicate credential id (`PASSKEY_EXISTS`) instead of overwriting, namespaces registration vs authentication challenges, validates the credential id type, and the in-memory challenge store now purges expired entries + caps size. **`WebAuthnChallengeStore` now stores/returns `StoredChallenge` objects** (was a bare string).
  - **tenancy:** custom-domain `verify`/`instructions`/`remove` are now tenant-scoped (`DomainForbiddenError`); a shared `normalizeDomain` (lowercase/port/trailing-dot/IDNA) is used by registration, lookup AND the Host resolver; `MemoryDomainStore.add` rejects duplicates atomically; `verify(tenantId, domain, { force })` re-checks DNS and **revokes** on failure (dangling-domain defence); new `findByVerifiedDomain` helper wires only verified domains into `TenantSource.findByDomain`.
  - **prisma:** `readReplica` gains `extend` (apply the same extension to primary AND every replica — prevents an un-scoped replica leaking all tenants) and routes `$queryRaw`/`$queryRawUnsafe` to the **primary by default** (opt back in with `rawReadsOnReplica`). `ShardRouter` defensively copies its shards.
  - **http:** SSE `encodeSseEvent` strips CR/LF/NUL from `id`/`event` (event-stream injection) and splits `data` on all line terminators; `send()` now returns a boolean backpressure signal.
  - **core:** `renderDependencyGraph` escapes token descriptions so a label can't break out of / inject HTML into the Mermaid node.

- Updated dependencies [c305a67]
  - @basaltkit/core@1.1.1

## 1.2.0

### Minor Changes

- e092674: SMS & WhatsApp channels. `SmsChannel` delivers notifications over a
  provider-agnostic `SmsSender` (implement it with Twilio, Vonage, MessageBird,
  AppyPay… — no provider SDK in the framework), and `whatsappChannel()` is the same
  channel named `whatsapp` reading `recipient.whatsapp ?? recipient.phone`. Both
  honour per-recipient opt-out via `channelPreferences` like every channel.
  `Notifiable` gains a named `phone?` field. Wire with
  `notificationsPlugin({ channels: [new SmsChannel(sender)] })`.

### Patch Changes

- Updated dependencies [fd5b55c]
  - @basaltkit/core@1.1.0

## 1.1.0

### Minor Changes

- a005096: Add per-user preferences and digest batching. `NotificationPreferences`
  (`optOut`/`optIn`/`allowed`, backed by a `PreferenceStore`) persists opt-outs per
  notification × channel with most-specific-wins resolution; the `Notifier` skips a
  channel a user opted out of. `Digest` (`collect`/`flush`, backed by a
  `DigestStore`) holds rendered notifications and flushes them grouped per
  recipient+channel as one batch — a daily summary instead of immediate sends.
  `notificationsPlugin({ preferences: true, digest: true })` wires both (in-memory
  by default) and exposes the `PREFERENCES` / `DIGEST` tokens.

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
- @basaltkit/mailer@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/mailer@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/mailer@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/mailer@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/mailer@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/mailer@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/mailer@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/mailer@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/mailer@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/mailer@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/mailer@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/mailer@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/mailer@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/mailer@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/mailer@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/mailer@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/mailer@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/mailer@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/mailer@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0
- @basaltkit/mailer@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1
- @basaltkit/mailer@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/mailer@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0
- @basaltkit/mailer@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0
  - @basaltkit/mailer@0.3.0

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
  - @basaltkit/mailer@0.1.0
