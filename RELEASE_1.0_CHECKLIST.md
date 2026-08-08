# Road to 1.0

`1.0.0` is a promise, not a milestone number: it says the public API is stable
and will change only under semver. This checklist tracks what that promise needs.
It's honest about what's done and what isn't — items are only checked when they're
actually true in the tree.

**🎉 1.0.0 shipped.** All 69 packages are published at `1.0.0`. This checklist
is kept as the record of how we got here — every gate below is met.

---

## 1. Persistence — ✅ done

The headline 0.x limitation ("some stores ship in-memory") is resolved. Every
stateful domain has a durable backend; in-memory is now the *dev default*, not a
ceiling.

- [x] Auth — `@machize/auth-sqlite` / `@machize/auth-prisma` (6 stores)
- [x] Teams — `@machize/teams-sqlite` / `@machize/teams-prisma`
- [x] Subscriptions — `@machize/subscriptions-sqlite` / `-prisma` (atomic `consume`)
- [x] Permissions — `@machize/permissions-sqlite` / `-prisma`
- [x] Comments, Audit, Activity, Notifications — `*-sqlite` / `*-prisma`
- [x] Cache / usage metering / webhook idempotency — Redis backends
- [x] Queues, Search, Storage — production driver packages
- [x] Flags — stateless by design (declared in code); no backend needed
- [x] Database-per-tenant wiring documented end-to-end

## 2. API stability — the actual 1.0 gate — ✅ done

The mechanical work was done and the maintainer signed off the surface at 1.0.

- [x] **Mechanical API-surface pass** — every package's entry-point exports were
      scanned: no internal symbols leak (the only `_`-shaped exports are intended
      DI tokens/constants like `DB_POOL`, `IN_APP`, `API_KEYS`). Nothing marked
      `@internal` is exported.
- [x] **Final maintainer sign-off** — the public surface was accepted as the
      contract and frozen at 1.0. Changes now follow semver.
- [x] **Naming consistency** verified across the store factories
      (`sqlite<Domain>Store(s)` / `prisma<Domain>Store(s)`) and `Prisma<Domain>Client`
      surfaces. One deliberate variance to keep in mind: single-store domains are
      named after their contract (`sqliteInAppStore`, `sqliteAccessStore`) rather
      than the domain — consistent within itself, worth a glance at freeze time.
- [x] **Deprecation policy** written — see the
      [Versioning & compatibility guide](https://machize-docs.pages.dev/guide/versioning):
      `@deprecated` in a minor, works through the major, removed only in the next.
- [x] No `@experimental` / `@deprecated` / TODO debt in `src` (1 marker total).

## 3. Documentation — ✅ done

- [x] Guides for every capability, driver, self-contained UI, persistence, and
      database-per-tenant; full 69-package reference catalog; docs deployed and
      refreshed to 0.32.0 (no stale counts, no Laravel framing).
- [x] READMEs for all store packages — the `subscriptions-`, `comments-`,
      `audit-`, `activity-`, `notifications-` × `{sqlite,prisma}` packages now
      have English READMEs (alongside `auth-*`, `teams-*`, `permissions-*`).
- [x] **Documentation is single-language (English).** All 53 formerly-Portuguese
      base package READMEs were translated to English — prose and code examples —
      so the docs site, guides, and every package README now read English.
      (`@machize/i18n` keeps its intentional `pt`-locale demo strings.)
- [x] A short **"0.x → 1.0" upgrade note** — published in the
      [Versioning & compatibility guide](https://machize-docs.pages.dev/guide/versioning)
      ("1.0 is a stability commitment, not a rewrite"), to be confirmed final by
      the maintainer API sign-off above.

## 4. Testing & CI — ✅ done

- [x] CI: build + typecheck + test on a Node matrix, lint, supply-chain audit
      (`pnpm audit --audit-level=high`), and a Postgres integration job.
- [x] Coverage gate enforced in CI.
- [x] **Coverage thresholds raised** — the CI gate went from 70/60 to
      **90% statements · 90% lines · 87% functions · 85% branches**, set just under
      the actual aggregate (stmts/lines ~92%, branches ~88%, funcs ~90%) so it
      protects what we have without flaking.
- [x] **Real Postgres integration tests for the `*-prisma` stores** — added
      `apps/pg-integration/tests/stores.integration.test.ts`: every `*-prisma`
      store round-trips against a real PostgreSQL 16 (compound ids, `String[]`
      columns, `createMany({ skipDuplicates })`, and the atomic concurrent
      `consume`). Runs in the CI `integration (postgres)` job. **This found a real
      concurrency bug** — `subscriptions-prisma`'s `consume`/`increment` seeded the
      counter with `upsert`, which races to INSERT and fails with P2002 under
      concurrent first-touch; fixed by seeding with `createMany({ skipDuplicates })`
      (the typed in-memory fake couldn't surface it).

## 5. Versioning & release — ✅ done

- [x] Lockstep releases via changesets (`fixed: [["@machize/*"]]`); automated
      publish on merge (`release.yml`, npm provenance).
- [x] **The 1.0 cut landed.** The whole `@machize/*` group graduated
      `0.32.0 → 1.0.0` in lockstep and published to npm — functionally identical to
      0.32.0, marking the stability commitment.
- [x] **`1.0.0` announcement** — the README status and every package CHANGELOG
      state the stability promise; the [Versioning guide](https://machize-docs.pages.dev/guide/versioning) documents it.

## 6. Runtime & compatibility — ✅ done

- [x] ESM-only, documented.
- [x] `node:sqlite` packages declare `engines.node >= 22.5.0` (flag-free on 24).
- [x] **Node support policy documented** — the
      [Versioning & compatibility guide](https://machize-docs.pages.dev/guide/versioning)
      states Node 22+ (CI tests 22 & 24), the `*-sqlite` packages' 22.5+ /
      `--experimental-sqlite` caveat, ESM-only, and the lockstep versioning rule.

## 7. Security & governance — ✅ done

- [x] `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE` present.
- [x] Secrets never persisted in clear — API keys stored as SHA-256 hash +
      prefix; MFA recovery codes hashed upstream; the durable stores preserve this.
- [x] Supply-chain audit in CI.
- [x] `SECURITY.md` disclosure process confirmed current (GitHub private
      vulnerability reporting + `security@machize.dev`); refreshed the stale
      "currently 0.1.x" supported-versions line to `0.31.x`.

---

## Done

All gates are met and **1.0.0 is published**. Post-1.0, changes follow semantic
versioning: breaking changes only in a new major, features in a minor, fixes in a
patch. This file now stands as the record of the road to 1.0, not a to-do list.