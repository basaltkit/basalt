# Road to Basalt 1.1 — the security-hardened release

`1.1` isn't a rewrite — it's a **generation marker** (see [VERSIONING.md](./VERSIONING.md)):
the packages stay on their own independent semver, and "Basalt 1.1" is the umbrella
label for the wave of security hardening that followed the first stable release.
Like the [1.0 checklist](./RELEASE_1.0_CHECKLIST.md), this is honest — boxes are
checked only when they're actually true in the tree and on npm.

**🎉 Basalt 1.1 shipped.** The security campaign is complete and published. The
umbrella version lives in the private root `package.json` (`1.1.0`); the docs nav
reads it and renders "Basalt 1.1".

---

## 1. The audit — ✅ done

- [x] **Deep, adversarial security audit** across 7 domains (auth · authz/tenant ·
      HTTP · injection · crypto · dependencies · PII/logs), reading the real source.
- [x] Verdict: primitives are strong; the risk was **composition & defaults** plus a
      structural multi-tenant gap. Scorecard + prioritized remediation produced.
- [x] Every finding tracked to a fix (or a documented, reasoned deferral).

## 2. Critical fixes — tenant isolation (P0) — ✅ done · PR #97

- [x] **`tenantMembershipPlugin`** (`@basaltkit/teams`) — secure-by-default guard
      binding the authenticated user to the resolved tenant (403 for non-members);
      central routes opt out with `meta.central`. Closes the "resolver ≠ authz" gap.
- [x] **Raw-query guard** (`@basaltkit/prisma`) — `$queryRaw`/`$executeRaw` refuse to
      run inside a tenant context (`PRISMA_RAW_IN_TENANT`); opt-out `onRawInTenant`.
- [x] **Postgres RLS helpers** — `rlsPolicySql` / `setTenantConfigSql` /
      `tenantConfigParams`, verified against real Postgres (pglite): a query with no
      tenant predicate still only sees the active tenant, and fails closed when unset.
- [x] **Fail-closed scaffold secret** (`create-basalt`) — `APP_SECRET` via
      `secret({ minLength: 32 })`, no committed default.

## 3. Secure-by-default & auth hardening (P1) — ✅ done · PRs #98, #100, #101, #102

- [x] `securityPlugin()` shipped in the scaffold — secure headers from the first deploy.
- [x] `Auth` fails closed on a weak JWT signing secret (`WeakJwtSecretError`).
- [x] Deep, broad log redaction (accessToken/refreshToken/cookie/mfaCode/… nested).
- [x] Hono request body-size limit (413 before parsing).
- [x] **TOTP anti-replay** — an accepted code's step is recorded and can't be replayed.
- [x] **TOTP secret encryption at rest** — opt-in `mfaEncryptionKey` (AES-256-GCM).
- [x] **Access-token revocation** — opt-in `TokenVersionStore` (Memory/Prisma/SQLite);
      `resetPassword`/`revokeAllTokens` invalidate outstanding tokens.
- [x] **Per-IP login throttle** alongside the per-email one (spraying / lockout-DoS).
- [x] **Enumeration-safe registration** — `POST /auth/register` returns a uniform 202;
      collisions signalled out-of-band via `auth:register_existing_email`.

## 4. Medium & polish — ✅ done · PRs #100, #104, #105

- [x] Atomic idempotency reservation (Redis `SET … NX`) — no concurrent double-execution.
- [x] Mailer CRLF header-injection guard (`assertHeaderSafe`, all drivers).
- [x] Audit `trail()` forces the context tenant; `systemTrail()` for explicit
      cross-tenant reads; opt-in `piiMinimizingRedactor`.
- [x] Webhook SSRF: pin the validated IP to defeat DNS-rebinding.
- [x] Default restrictive CSP + per-route rate limits (`route.meta.rateLimit`).
- [x] Storage key validation (`STORAGE_INVALID_KEY`) + opt-in upload limits.
- [x] Search identifier validation (table/index) for postgres/ES/meilisearch.
- [x] MFA recovery codes raised 40 → 80 bits of entropy.

## 5. The continuous custodian — ✅ done · PR #99

- [x] `ai:doctor` rules encode the invariants: **`missing-tenant-membership`** (error)
      and **`missing-security-plugin`** (warning) — a regression turns the build red.
- [x] Cross-tenant regression tests (membership, raw-guard, RLS, weak-secret, redaction,
      body-limit) gate every PR via `pnpm test` in the CI verify/coverage jobs.

## 6. Supply chain — ✅ done · PR #100

- [x] CI audit gate green again — the two dev/build-only HIGH advisories (`nanoid`,
      `deepmerge-ts`) scope-ignored with written justification.
- [x] `@prisma/client` peer range capped in `@basaltkit/prisma` (`>=5.0.0 <8`).

## 7. Versioning model — ✅ done · PR #109

- [x] Formalized **two-tier versioning**: independent per-package semver + a single
      umbrella "Basalt 1.1" marker for comms/docs (root `package.json`, read by the docs).
- [x] Removed the misleading `fixed: [["@basaltkit/*"]]` changeset lockstep config
      (it never matched npm and forced a bogus 3.0.0 on `changeset version`).

## 8. Documentation — ✅ done · PRs #106–#111

- [x] Security guide covers every shipped feature (EN + PT).
- [x] Language switcher fixed — PT pages use English slugs; old URLs 301-redirect.
- [x] Nav version chip corrected (stale `1.0.4` → the umbrella "Basalt {version}").
- [x] `ARCHITECTURE.md` / `VERSIONING.md` / `README.md` / `SECURITY.md` /
      `CONTRIBUTING.md` refreshed — no more "lockstep" claims, package count 69 → 79,
      broken docs domain fixed.

## 9. Release — ✅ done · PRs #103, #105

Published per-package to npm (independent versioning):

- [x] `@basaltkit/auth` **1.3.1**, `auth-prisma`/`auth-sqlite`/`teams`/`fastify` **1.3.0**
- [x] `@basaltkit/prisma`/`logger`/`audit`/`webhooks` **1.2.0**, `search` **1.3.0**
- [x] `@basaltkit/http` **1.4.0**, `storage` **1.1.0**, `hono`/`mailer` **1.1.0**
- [x] `@basaltkit/search-elasticsearch` **1.1.1**, `search-postgres` **1.0.1**,
      `ai` **0.10.0**, `create-basalt` **1.1.1**
- [x] Each package's exact current version is on the
      [Ecosystem](https://basaltkit-docs.pages.dev/guide/ecosystem) page.

## 10. Verification gates — ✅ done

- [x] All affected package test suites green; builds (ESM + DTS) clean.
- [x] RLS proven against real Postgres (pglite); idempotency/webhook/CRLF covered.
- [x] `pnpm audit --audit-level=high` exits 0; CodeQL + Dependabot in CI.

---

## Deferred (documented, not silent)

Not blockers — reasoned deferrals, tracked for a later generation:

- [ ] Nested-write/`connect` app-layer tenant scoping — **mitigated** by the shipped
      RLS `WITH CHECK` at the database; a generic app-layer fix needs schema introspection.
- [ ] Request timeouts / slowloris limits on the HTTP adapters.
- [ ] Deeper audit PII field-policy (an opt-in `piiMinimizingRedactor` shipped).
- [ ] `pnpm.overrides` block (the audit gate is already green via scoped ignores).
- [ ] `@basaltkit/subscriptions-appypay` — deliberately **not published** (0.3.0),
      pending real AppyPay sandbox validation.

---

## Done

Basalt 1.1 is **published and documented**. The framework is secure by default, a
continuous custodian guards against regressions, and every finding from the audit is
either fixed or deferred with a written reason. This file stands as the record of the
road to 1.1.
