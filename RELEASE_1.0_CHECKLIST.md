# Road to 1.0

`1.0.0` is a promise, not a milestone number: it says the public API is stable
and will change only under semver. This checklist tracks what that promise needs.
It's honest about what's done and what isn't — items are only checked when they're
actually true in the tree.

Current: **0.31.0 · 69 packages · 102 test suites · CI green.**

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

## 2. API stability — the actual 1.0 gate — ☐ pending

Nothing here is hard; it's the deliberate work of committing to the surface.

- [ ] **Public-API review per package** — confirm every top-level export is
      intended as contract; hide internals (or mark `@internal`). What's exported
      at 1.0 is what we support.
- [ ] **Naming-consistency pass** across the store factories
      (`sqlite<Domain>Store(s)` / `prisma<Domain>Store(s)`) and the `Prisma*Client`
      surfaces — they follow a pattern today; verify no drift before freezing it.
- [ ] **Deprecation policy** written down (how a symbol gets retired post-1.0).
- [x] No `@experimental` / `@deprecated` / TODO debt in `src` (1 marker total).

## 3. Documentation — ☐ nearly there

- [x] Guides for every capability, driver, self-contained UI, persistence, and
      database-per-tenant; full 69-package reference catalog; docs deployed and
      refreshed to 0.31.0 (no stale counts, no Laravel framing).
- [x] READMEs for all store packages — the `subscriptions-`, `comments-`,
      `audit-`, `activity-`, `notifications-` × `{sqlite,prisma}` packages now
      have English READMEs (alongside `auth-*`, `teams-*`, `permissions-*`).
- [x] **Documentation is single-language (English).** All 53 formerly-Portuguese
      base package READMEs were translated to English — prose and code examples —
      so the docs site, guides, and every package README now read English.
      (`@machize/i18n` keeps its intentional `pt`-locale demo strings.)
- [ ] A short **"0.x → 1.0" upgrade note** — ideally "nothing to do", to be
      confirmed by the API review above.

## 4. Testing & CI — ☐ raise the bar

- [x] CI: build + typecheck + test on a Node matrix, lint, supply-chain audit
      (`pnpm audit --audit-level=high`), and a Postgres integration job.
- [x] Coverage gate enforced in CI.
- [ ] **Raise coverage thresholds** — the gate is 70% statements / 60% branches,
      but most packages already sit at 100%. Ratchet the floor up so it protects
      what we actually have.
- [ ] **Real Postgres integration tests for the `*-prisma` stores** — the
      `pg-integration` app already spins up Postgres and generates a client in CI;
      today it only exercises tenancy. Add store round-trips there so the Prisma
      backends are verified against a real database, not just the typed fake.

## 5. Versioning & release — ☐ one deliberate cut

- [x] Lockstep releases via changesets (`fixed: [["@machize/*"]]`); automated
      publish on merge (`release.yml`, npm provenance).
- [ ] **The 1.0 cut is a one-way door.** Note: with the `fixed` group on 0.x, a
      single `minor` changeset graduates the whole group `0.30.0 → 1.0.0`
      automatically (see `changesets-fixed-group-graduates-to-1.0` in project
      memory). So "going 1.0" is mechanically one changeset — do it only once §2
      is signed off, not by accident.
- [ ] Tag a **`1.0.0` announcement** (blog/README) stating the stability promise.

## 6. Runtime & compatibility — ☐ state the policy

- [x] ESM-only, documented.
- [x] `node:sqlite` packages declare `engines.node >= 22.5.0` (flag-free on 24).
- [ ] **Write the Node support policy** into the docs (minimum version, what's
      tested in CI, the `--experimental-sqlite` caveat on 22.x) so 1.0 users know
      the contract.

## 7. Security & governance — ✅ mostly there

- [x] `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE` present.
- [x] Secrets never persisted in clear — API keys stored as SHA-256 hash +
      prefix; MFA recovery codes hashed upstream; the durable stores preserve this.
- [x] Supply-chain audit in CI.
- [ ] Confirm `SECURITY.md`'s disclosure contact/process is current before 1.0.

---

## Definition of done for 1.0

1. §2 API review complete and the surface frozen.
2. §3 the "0.x → 1.0" upgrade note published (all READMEs and translation done).
3. §4 coverage floor raised; `*-prisma` stores covered by Postgres integration.
4. §6 Node policy documented.
5. Then, and only then, land the single `minor` changeset that cuts `1.0.0`.

Everything above §2 (persistence, the bulk of docs, CI, governance) is already
true today. What remains is the discipline of committing to the surface — not
more features.
