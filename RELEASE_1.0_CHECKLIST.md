# Road to 1.0

`1.0.0` is a promise, not a milestone number: it says the public API is stable
and will change only under semver. This checklist tracks what that promise needs.
It's honest about what's done and what isn't — items are only checked when they're
actually true in the tree.

Current: **0.32.0 · 69 packages · 102 test suites · CI green.**

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

## 2. API stability — the actual 1.0 gate — ☐ maintainer sign-off left

The mechanical work is done; what remains is the maintainer's intent sign-off.

- [x] **Mechanical API-surface pass** — every package's entry-point exports were
      scanned: no internal symbols leak (the only `_`-shaped exports are intended
      DI tokens/constants like `DB_POOL`, `IN_APP`, `API_KEYS`). Nothing marked
      `@internal` is exported.
- [ ] **Final maintainer sign-off** — a human confirms every top-level export is
      *intended* as contract and freezes the surface. This is judgment, not
      mechanics; it's the last gate before cutting 1.0.
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

## 5. Versioning & release — ☐ one deliberate cut

- [x] Lockstep releases via changesets (`fixed: [["@machize/*"]]`); automated
      publish on merge (`release.yml`, npm provenance).
- [ ] **The 1.0 cut is a one-way door.** Note: with the `fixed` group on 0.x, a
      single `minor` changeset graduates the whole group `0.32.0 → 1.0.0`
      automatically (see `changesets-fixed-group-graduates-to-1.0` in project
      memory). So "going 1.0" is mechanically one changeset — do it only once §2
      is signed off, not by accident.
- [ ] Tag a **`1.0.0` announcement** (blog/README) stating the stability promise.

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

## Definition of done for 1.0

Only two things remain:

1. **§2 maintainer API sign-off** — a human confirms the public surface is the
   contract we commit to. Everything mechanical (naming consistency, no leaked
   internals, deprecation policy, coverage, Node policy, upgrade note, real-DB
   integration) is done.
2. **The cut itself** — land the single `minor` changeset that graduates the
   group to `1.0.0`, then tag the announcement.

Sections 1, 3, 4, 6 and 7 (persistence, docs, testing/CI, runtime policy,
security/governance) are complete as of 0.32.0. What's left is the deliberate act
of committing to the surface — not more features.
