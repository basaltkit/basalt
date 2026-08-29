# BasaltKit Ecosystem Review — 2026-08 (Pass C)

_Principal-architect third pass. **Report only** — no code changed, nothing committed._
_Umbrella: Basalt 1.5+. Current `main`, HEAD `6ca10e2d` (teams membership-guard hardening, #251)._

## Executive summary

The two prior cycles hold. I re-verified the wave-3 fixes with **live executions**, not
reading: the scheduler `.onOneServer()` double-boot runs exactly once across two replicas and
fails **closed** when the lock store throws; the outbox rejects capture on a failing store,
honours per-process backoff, fires `onDead` once, excludes dead entries, and coalesces
concurrent flushes; a booted app serves the api-keys UI with a route-scoped CSP whose sha256
hash matches the page's inline script; the membership guard turns a forged `x-tenant-id` into
`403 TEAM_NOT_A_MEMBER` while genuine members pass and anonymous stays 401; the CodeQL backlog
is effectively clean (2 open = benign warning-level `implicit-operand-conversion` in a test
file). This pass went deep where neither predecessor did — **`@basaltkit/auth` internals**
(the priority), permissions, cache/cache-tiered, search, audit, exports, SDK, admin, plus a
package-hygiene sweep and EN/PT docs. Auth's crypto core is excellent. The new findings cluster
in **guards that are advisory rather than enforced** and **fail-open-by-shape defaults** in
cache and permissions — none in the primitives.

## Findings by severity (this pass)

- 🔴 Critical: 0
- 🟠 Important: 5
- 🟡 Recommended: 13
- 🟢 Nice to have: 8 (a cluster)

## Mandate 1 — do the wave-3 fixes hold? **VERDICT: YES, all hold.**

| Fix | How verified | Result |
| --- | --- | --- |
| Scheduler `.onOneServer()` | 2-replica `tick()` race + lock-store-throws probe | 1 run, 1 skip; next minute reruns; lock failure → `AggregateError` (fail-closed), task did NOT run |
| Outbox at-least-once | failing-store + failing-dispatch probe | capture rejects; backoff skips immediate retry; `onDead` once; dead excluded; concurrent flush coalesces (maxInflight=1); failing `markFailed` → flush rejects (visible) |
| UI route-scoped CSP | booted Fastify app, real inject | `content-security-policy` present on the UI route (script-src pinned to the exact sha256 of the page's inline script), absent on a plain route |
| Membership billing-isolation | `packages/teams/tests/billing-isolation.test.ts` (26 tests) + guard read | forged `x-tenant-id` → 403; member passes; unauth → 401; guard is existence-default, hook-invalidated, bounded-cache, `exempt`-escape, fail-closed |
| CodeQL backlog | `gh api …/code-scanning/alerts?state=open` | 2 open, both warning-level in `packages/mailer/tests/html.test.ts` (deliberate null/undefined interpolation test); 9 fixed / 17 dismissed; **no new security alerts** |

## Mandate 3 — meta-review of the process

- **CI wall-clock is flat.** The last ~12 `ci.yml` runs sit at **2m45s–3m06s** — the ~30
  findings' worth of added tests/tripwires cost no measurable CI time. Suite is now **226 test
  files / 1716 cases**; coverage gate enforced (92/90/94/84).
- **onError-family consistency is good, with one sibling gap** (see 🟠 E / F-13): rabbitmq, sqs,
  bullmq, outbox, realtime, scheduler all expose an observability hook; **queue-kafka does not**.
- **Advisory changesets are consistent** across the security waves (subscriptions 2.7.0, the four
  UI packages at 1.1.0, mailer 1.4.0 all carry "what was exposed / what changed / opt out"
  notes). Two cosmetic drifts: the four UI CHANGELOGs are non-monotonic (a legacy `@machize`-era
  `1.0.5` entry sits between `1.0.2` and `1.0.0`), and `.changeset/teams-membership-guard-
  hardening.md` (#251) is merged but not yet versioned — normal mid-cycle state.

---

## 🟠 Important

### 🟠 A — The permission guard fails **open** on a non-string `meta.can`
- **Problem.** `packages/permissions/src/index.ts:281-283`: the guard does
  `if (typeof required !== 'string') return`. `route.meta` is `Record<string, unknown>`
  (`packages/http/src/route.ts:58`), so a route declared `meta: { can: ['posts:read'] }` or
  `can: true` type-checks and receives **no permission check** — only the plain auth check. The
  sibling API-key guard uses `meta.scopes: string[]`, so an array is a very natural mistake.
- **Impact.** Any authenticated user reaches a handler the author believed was permission-gated.
  Silent authorization bypass; the guard is the last line.
- **Proposal.** When `meta.can` is present but not a string, **throw** (at guard time or, better,
  at route registration) instead of returning. Fail closed on a malformed declaration.
- **Trade-offs.** None; converts a silent bypass into a loud error.
- **Compatibility.** permissions minor (a currently-broken route starts 500-ing until fixed).

### 🟠 B — `meta.auth` / guard metadata is **advisory**: inert unless an enforcing plugin is registered
- **Problem.** Guards live in the `http:guards` metadata bucket; the auth guard only exists when
  `authPlugin` is registered (`packages/auth/src/plugin.ts:74-79`). Nothing at boot asserts that
  a route declaring `meta.auth` (or `meta.can`, `meta.teamRole`) is actually consumed by a guard.
  **Empirically confirmed:** booting `apiKeysUiRoutes()` (which declares `meta:{auth:true}`)
  **without** `authPlugin` serves the page `200` — no guard, no error. This is the general root
  of the prior S-1: the S-1 fix put `meta:{auth:true}` on billing routes, but that is inert in an
  app that mounts them and forgets `authPlugin`.
- **Impact.** A whole class of "I marked it protected" routes can ship wide open with zero signal.
- **Proposal.** At boot, collect the guard-consumed meta keys and the route-declared ones; if any
  route declares `auth`/`can`/`teamRole` with no guard registered for it, **fail loud** (or a
  loud `logger.warn` at minimum). This is the fail-closed analogue of the adapter-boundary test.
- **Trade-offs.** One boot-time cross-check; needs guards to advertise the keys they enforce.
- **Compatibility.** http + auth minor; additive, opt-in strictness.

### 🟠 C — Cache tenant scoping is **fail-open by default** (`onMissingScope: 'global'`)
- **Problem.** `packages/cache/src/index.ts:94` defaults `onMissingScope: 'global'`: a
  `remember()/set()` with no tenant context silently writes to one shared namespace. A background
  job for tenant B that caches `plan-limits` with no ambient tenant lands in `basalt:plan-limits`;
  the next run for tenant C reads B's value. `flush()` correctly always fails closed
  (`index.ts:136`) — but the read/write default does not.
- **Impact.** Latent cross-tenant cache disclosure the moment a caller runs outside request ctx.
- **Proposal.** Default `onMissingScope: 'error'` (fail closed); make `'global'` the deliberate
  opt-in for single-tenant apps. Mirrors the `flush()` stance and the tenancy `requireTenantId`
  posture the framework already took for repositories.
- **Trade-offs.** A behaviour change for apps relying on implicit global caching; correct direction.
- **Compatibility.** cache minor, flagged.

### 🟠 D — `cache-tiered` has **no cross-replica invalidation** — stale reads for a full TTL
- **Problem.** `packages/cache-tiered/src/index.ts:46-61`: `set/delete/flushTags` fan out only to
  *this process's* layers; there is no pub/sub bus. Verified empirically: A `set('plan','v1')` →
  B reads (backfills its L1) → A `delete('plan')` → **B still serves `v1`**. Worse, a direct
  `set()` writes the entry's *full* TTL into every replica-local L1 (line 47), so a later update
  is invisible to other replicas for hours (not the documented 60s `backfillTtlMs`).
- **Impact.** Multi-replica deployments (the kit's target) serve stale plan/permission/flag data
  well past any intended window — a correctness and (for authz-adjacent caches) security issue.
- **Proposal.** Add a Redis pub/sub invalidation channel keyed on `set/delete/flushTags`; at
  minimum clamp direct-`set` L1 writes to `backfillTtlMs` so staleness is bounded.
- **Trade-offs.** New optional backplane surface; keep single-process default free.
- **Compatibility.** cache-tiered minor.

### 🟠 E — `pnpm lint` is a no-op, so `no-floating-promises` is gone — and `queue-kafka` is exactly that bug
- **Problem.** `.github/workflows/ci.yml` keeps a `lint` job, but `pnpm lint` is a **documented
  no-op** (typescript-eslint rejects TS≥7). The most valuable rule it provided,
  `no-floating-promises`, is the exact class behind the prior outbox `void enqueue` bug — and it
  is now unguarded. Concretely, `packages/queue-kafka/src/index.ts:130-142`: `startWorker` is a
  `void (async () => {…})()` whose `connect()/subscribe()/run()` failures become **unhandled
  rejections** (process-fatal by Node default), with no `onError` hook and no consumer `'error'`
  listener — while its rabbitmq/sqs siblings surface exactly this via `onError` (the wave-3
  pattern). `close()` also swallows producer errors (`:145`).
- **Impact.** A broker-connect failure at boot crashes the process or leaves a silently
  worker-less app; and the lint gap means the next such regression also ships unseen.
- **Proposal.** (1) Give queue-kafka the sibling `onError` treatment (surface `startWorker` /
  consumer / send failures; don't float the promise). (2) For the lint gap, run a **narrow
  type-aware `no-floating-promises` check** via `tsc`-based tooling or a small AST script in CI
  until typescript-eslint supports TS7 — don't leave the security-relevant rule dark.
- **Trade-offs.** Kafka driver rework (contained); a small bespoke lint step.
- **Compatibility.** queue-kafka minor; CI/tooling.

---

## 🟡 Recommended

- **F-1 · Refresh reuse-detection is not atomic in the DB drivers.** `packages/auth/src/auth.ts:
  refresh()` reads `record.usedAt` then calls `markUsed`, but `auth-prisma`/`-sqlite` implement
  `markUsed` as `updateMany({ where:{ token } }, { usedAt })` with **no `usedAt: null` predicate**
  (`auth-prisma/src/index.ts:297-299`). It is therefore not a compare-and-swap: two concurrent
  refreshes of a stolen+legit token can both read `usedAt=null` and both succeed, defeating
  rotation-reuse detection. (The memory store serialised in my probe; the race is DB-driver
  specific.) _Fix:_ conditional update `where token AND usedAt IS NULL`; 0 rows affected ⇒ reuse.
- **F-2 · SAML `validateInResponseTo` defaults to `never`.** `packages/auth-saml/src/index.ts`
  `defaultCreateClient` sets `wantAssertionsSigned: true` (good, and node-saml 5.1.0 is signature-
  wrapping-hardened) but leaves `validateInResponseTo` at the library default `never` → no
  assertion-replay cache; a captured `SAMLResponse` is replayable within its `NotOnOrAfter`
  window, and `RelayState` isn't bound to a session. _Fix:_ default `ifPresent` + offer a
  `cacheProvider`; document the trade-off.
- **F-3 · Audit redaction stops at depth 6 — secrets pass verbatim.** `packages/audit/src/index.ts
  :81` returns the **raw** value past depth 6 (confirmed: a `password` nested 7 deep persists as
  cleartext). Event payloads are arbitrary and default `events:['**']`. _Fix:_ return
  `'[truncated]'` at max depth (same at `:114`).
- **F-4 · Permission gate silently degrades ABAC→RBAC on a policy-name typo.**
  `packages/permissions/src/index.ts:169-174`: `can(user,'doc:update',doc)` with no registered
  `doc` policy (or a typo'd resource/action) falls through to pure RBAC — the ownership check
  never runs. _Fix:_ when a resource is passed but no policy/check exists, deny (or warn).
- **F-5 · Audit list/stats load the whole tenant trail into memory.** `audit-prisma/src/index.ts:
  69-80`, `audit-sqlite/src/index.ts:100-120`, `audit-viewer/src/viewer.ts:66-71` apply `limit`
  and the event pattern **after** `findMany`/`SELECT *` (no `take`/`LIMIT`). An authenticated
  `GET /audit?limit=50` materialises the entire (unbounded) trail → repeatable OOM. _Fix:_ push
  `LIMIT` down; cursor pagination.
- **F-6 · Redis cache `flushPrefix` glob injection via tenant id.** `packages/cache/src/drivers/
  redis.ts:38` interpolates the scope (default = raw `tenant.id`) into `SCAN MATCH ${prefix}*`
  unescaped; a tenant id with `*`/`?`/`[` (user-chosen slugs) makes `flush()` delete other
  tenants' keys. _Fix:_ escape Redis glob metacharacters.
- **F-7 · `:`-delimiter ambiguity in compound keys.** cache (`index.ts:258-263`) and the ES
  driver pk (`search-elasticsearch/src/index.ts:119` `${tenantId}:${id}`) let free-form tenant/id
  segments collide across tenants (cache crossover; ES `_id` overwrite/data-loss — no read leak,
  the stored `tenantId` still gates search). Harmless with UUIDs. _Fix:_ encode segments (the
  Meilisearch driver already base64urls its pk).
- **F-8 · Memory cache driver is unbounded — and it is the default.** `packages/cache/src/drivers/
  memory.ts` has no LRU/max-entries and reaps only on `get`. High key cardinality → OOM. _Fix:_
  max-size LRU + periodic sweep.
- **F-9 · Redis tag sets leak forever.** `redis.ts:26-28` `SADD __tags__:tag key` members are
  never removed on `delete`/TTL-expiry. _Fix:_ `SREM` on delete + `EXPIRE` tag sets.
- **F-10 · Cached `undefined` ≡ miss.** `cache/src/index.ts:175` treats `undefined` as a miss, so
  a legitimately-`undefined` factory result is recomputed every call (verified). _Fix:_
  envelope-wrap values or reject `undefined` loudly.
- **F-11 · `search-postgres.register()` is broken for schema-qualified tables.**
  `search-postgres/src/index.ts:65` emits `CREATE INDEX IF NOT EXISTS schema.table_tsv_idx …` —
  index names can't be schema-qualified in Postgres (syntax error) though `assertValidTableName`
  allows `schema.table`. _Fix:_ `${table.replace('.', '_')}_tsv_idx`.
- **F-12 · `engines.node` only on the 11 `*-sqlite` packages.** The other 74 omit it entirely
  (`packages/auth-sqlite/package.json` has `>=22.5.0`; `packages/auth/package.json` has none).
  _Fix:_ one uniform `engines.node` across the monorepo.
- **F-13 · zod range divergence.** 30 packages pin `"^3.24.0 || ^4.0.0"`; `packages/ai` and
  `packages/create-app` pin `^4.0.0` only — the sole external-dep inconsistency. _Fix:_ align.
- **F-14 · queue-kafka observability** is folded into 🟠 E above (listed there, not double-counted).

## 🟢 Nice to have (cluster)

Audit append-only is **contract-only, not DB-enforced** — add SQLite `BEFORE UPDATE/DELETE …
RAISE(ABORT)` triggers + a Postgres note (`audit-sqlite/src/index.ts:26-45`). · The neutral
pipeline **skips all guards when `container` is absent** (`http/src/pipeline.ts:105-109`) — in
practice guards and container are absent together, but a defensive `if (guards.length &&
!scoped) throw` removes the fail-open shape. · **XLSX cells with XML control chars (0x00–0x08)**
produce invalid sheet XML (`exports-xlsx/src/xlsx.ts:6-7`) — strip/`_xHHHH_`-encode. ·
**`sideEffects` absent in all 85** packages — a uniform `"sideEffects": false` sweep aids
bundlers. · **UI CHANGELOGs are non-monotonic** (legacy `1.0.5` between `1.0.2`/`1.0.0`) — cosmetic
cleanup. · **Cache serialization diverges memory-vs-Redis** (live refs + Date/Map survive in
memory; JSON-roundtripped on Redis) — document or normalise. · **Search returns the full raw
document** (no read-side field allowlist) and **no `limit` cap** — a caller can dump their whole
tenant corpus; ES `bulk()` buffers the entire NDJSON body. · **OAuth has no PKCE** — defensible
for the confidential server-side flow (client_secret + HMAC-signed, expiring, provider-bound
`state`), but OAuth 2.1 recommends PKCE universally; note it.

---

## Deliberately NOT recommended (guardrail)

- **A global tenant-aware cache-key rewriter / ORM interceptor.** Same reasoning as the prior
  passes rejected for repositories: invasive, surprising for single-tenant apps. Fix C by flipping
  the **default** to fail-closed, not by forcing rewriting.
- **A parallel ACL/policy engine, or caching permission decisions.** `permissions` already
  fails closed and caches nothing (revocation is immediate — verified). Fix A/F-4 by tightening
  the two fail-open branches; do not add a layer.
- **Rewriting the queue drivers onto a common base class.** The capability-negotiation design is
  a strength; give kafka the sibling `onError` treatment in place (🟠 E), don't refactor.
- **A generated SDK client + drift-detection test.** `@basaltkit/sdk` is intentionally a *generic*
  typed-endpoint toolkit (`endpoint()`), not a codegen target; it already validates responses
  against the endpoint schema and throws on client/server drift (`client.ts:121`). No generator to
  keep in sync — do not build one.
- **Re-enabling full typescript-eslint now.** It genuinely doesn't support TS7. Ship the **narrow**
  `no-floating-promises` check (🟠 E), not the whole ruleset, until upstream lands.
- **Turning the two open CodeQL alerts into work.** They are warning-level, in test code,
  asserting intended `null`/`undefined` interpolation. Dismiss or `// codeql` them; not findings.

## Coverage & limits (what I did NOT deeply inspect)

- **Auth was the priority and went deep:** jwt (HMAC-verify-first, `timingSafeEqual`,
  alg-confusion-immune — the verify path ignores the header `alg`), scrypt hashing (N=2¹⁶, params
  embedded), OAuth (stateless HMAC-signed `state` + expiry + provider binding), WebAuthn (single-
  use challenges, subject-binding, clone detection, no-overwrite, existence-oracle guard), TOTP
  (constant-time window, step-replay prevention), secret-box (AES-256-GCM), API keys (SHA-256 of a
  high-entropy `mk_live_` key, prefix+hash lookup, scope-satisfy, tenant+user scoping), enumeration-
  safe register/reset/verify, dual (email+IP) throttle, `tv` token-version revocation. All solid;
  findings A/B/F-1/F-2 are the residue.
- **Cache/search/permissions/audit/exports/hygiene** were covered by parallel deep-reads with
  empirical probes (default-deny, wildcard semantics, formula injection, tsquery binding all
  verified SOLID — see the inline notes).
- **Not run against live infra:** kafka/redis/ES/pg were read, not exercised against real brokers.
- **Not re-audited:** the http security edge, storage path-traversal, MCP authorization, realtime
  crash-safety, subscriptions webhook crypto — all closed in the prior passes and spot-confirmed
  unchanged, not re-litigated.
- **SDK/admin/dashboard:** confirmed `sdk` is generic (no drift surface) and `admin`/`dashboard`/
  `admin-react`/`admin-shadcn` register **no HTTP routes** of their own (data layer, app-wired) —
  no shipped unguarded admin data route exists.
- **Docs:** EN teaches current signatures for every wave-3 API (billing auth-default, scheduler
  `.onOneServer()`, queue sync-driver semantics, storage attachment-default, tenancy
  `tenantScoped`); **PT is in parity** (line counts within ~1% and every new API present). No docs
  drift found — a positive, not a gap.
- **Depth:** ~30 of 85 packages read closely this pass; the rest via the dependency graph, the
  hygiene script, and the prior two passes. Ranked by risk, not exhaustiveness.

---

## Implementation status — 🟡 (13) and 🟢 (8)

_Appended after the batch landed. The 🟠 five shipped in #253; the four docs-surfaced
bugs in #256. Every 🟡/🟢 premise below was **re-verified against `main` at HEAD
`59cf29c6`** before deciding — none had gone stale, and two turned out to be bigger
than written._

### 🟡 Recommended

| # | Outcome | What landed |
| --- | --- | --- |
| **F-1** | **Implemented** | `markUsed` is now a compare-and-swap across `auth`/`auth-prisma`/`auth-sqlite`. Failing-first on the **real** sqlite store: `Promise.allSettled([refresh(t), refresh(t)])` returned **two** valid token pairs → now exactly one winner + one `RefreshReusedError`, family revoked. Contract widened to `Promise<boolean \| void>`; `void` keeps third-party stores compiling with the old (unprotected) semantics. Same fix applied to the verification/reset single-use tokens, which had the identical race. |
| **F-2** | **Implemented (minimal)** | `validateInResponseTo` defaults to `'ifPresent'` (node-saml defaults to `never`); `cacheProvider` and `SamlCacheProvider` exported. `samlClientConfig()` exported as a testable seam so the defaults are assertable without a live IdP. The multi-replica caveat is the load-bearing part and is documented in the changeset, the guide and the README: an in-process request-id cache breaks SP-initiated login across replicas, so a shared provider (or an explicit `'never'`) is required. |
| **F-3** | **Implemented** | Both redactors return `'[truncated]'` past depth 6 instead of the raw subtree. Failing-first: a `password` nested 8 deep serialised in cleartext. Primitives at the bound are untouched — their key was already checked one level up — so nothing within the limit changed. |
| **F-4** | **Implemented** | `can(user, perm, resource)` with no matching policy check now throws `MissingPolicyError` (`PERMISSION_POLICY_MISSING`) instead of answering from RBAC. Failing-first: with `doc:*` granted, `can(u, 'doc:updat', {ownerId:'someone-else'})` returned `true`. Default-`error` is defensible here because the **route guard never passes a resource** — only an explicit application call does, and that is an unambiguous ABAC intent. `onMissingPolicy: 'rbac'` is the documented opt-out. |
| **F-5** | **Implemented** | Exact filters *including a wildcard-free event name* now push into SQL with `take`/`LIMIT`; a wildcard pattern scans in bounded 500-row pages that stop at the limit. Sharpened premise: a pattern containing `.` is deliberately **not** pushed down, because `patternMatches` treats `.` and `:` as interchangeable and an equality would miss `a:b` for `a.b`. `audit-viewer` — which genuinely needs more than a page for its aggregates — gained `maxScan` (10 000) plus `truncated` on `AuditPage`/`AuditStats`, so `total` stops silently lying. |
| **F-6** | **Implemented** | Redis glob metacharacters escaped in `flushPrefix`. Failing-first: tenant `a*` flushed tenant `ab`'s keys. |
| **F-7** | **Implemented — and the premise was understated** | The ES driver had **two** id builders: `bulk()` used the raw `${tenantId}:${id}`, `index()`/`remove()` a percent-encoded form. So beyond the `:` collision the review found, the *same* document indexed singly vs in bulk landed under two different `_id`s, and `remove()` could not delete a bulk-indexed one, for any id containing a URL-special char. One definition now, the encoded form — which also closes F-7's `a:b`+`c` vs `a`+`b:c` collision. UUID/slug ids are byte-identical, so no re-index for the common case. |
| **F-8** | **Implemented** | `MemoryCacheDriver` is an LRU bounded at 10 000 entries (expired evicted first; `get` counts as a use), `maxEntries` configurable, `Infinity` to disable. No timer: eviction is amortised into `set`, so the library starts no background work. |
| **F-9** | **Implemented (redesigned)** | The obvious fix — `SREM` on delete + `EXPIRE … GT` on the tag set — doesn't work: `GT` treats "no TTL" as infinite, so a fresh tag set never gets one. Tag indexes are now **sorted sets** scored by member expiry (`__tagz__:`), pruned with `ZREMRANGEBYSCORE` on write, plus a reverse index so `delete` unregisters the key. Bounded by the live key set, and no Redis-7 dependency. Namespace change documented (old `__tags__:` sets are inert orphans). |
| **F-10** | **Implemented** | `undefined` is stored behind an internal marker, so a `remember()` factory returning `undefined` computes once instead of on every call, and `put(key, undefined)` no longer writes the invalid literal `undefined` to Redis. `get()` still reports the fallback — through `get` a cached `undefined` and a miss are legitimately indistinguishable. |
| **F-11** | **Implemented** | `${table.replace('.', '_')}_tsv_idx`. Failing-first: `register()` with `table: 'app.search'` emitted a schema-qualified index name, i.e. a syntax error — `register()` failed outright for anyone on a non-default schema. |
| **F-12** | **Implemented** | Uniform `engines.node: ">=22.5.0"` across all 85 packages (was on 11). `>=22.5.0` rather than the root's `>=22`: it is the floor the `*-sqlite` packages genuinely need and the floor CI exercises, so one honest number beats two. |
| **F-13** | **Implemented** | `ai` and `create-app` aligned to `"^3.24.0 \|\| ^4.0.0"`. |

### 🟢 Nice to have

| Item | Outcome | Reasoning |
| --- | --- | --- |
| Pipeline skips guards when `container` is absent | **Implemented** | `GuardsWithoutContainerError` (`HTTP_GUARDS_UNRUNNABLE`). Cheap, and it removes a fail-open *shape* from the one function every adapter routes through. |
| XLSX XML control chars | **Implemented** | `_xHHHH_` OOXML escaping (literal `_xHHHH_` escaped first so it round-trips); tab/LF/CR left verbatim. Failing-first: a `0x00` in a cell made the sheet unparseable. |
| `sideEffects` absent in all 85 | **Implemented** | `"sideEffects": false` everywhere. Verified safe first: there is not a single bare `import '@basaltkit/…'` in the tree. |
| Search: no read-side field allowlist, no `limit` cap | **Deferred, with reasoning** | `@basaltkit/search` ships **no HTTP routes** — nothing in the framework forwards `req.query.limit` into `search()`. A library-level clamp would be paternalistic and would silently truncate legitimate large reads; the allowlist belongs in the caller's response mapping. Revisit if search ever ships a route. |
| Audit append-only enforced by DB triggers | **Deferred, with reasoning** | `BEFORE UPDATE/DELETE … RAISE(ABORT)` would also block legitimate retention/pruning, and the package has no prune API to exempt — so the trigger would harden the contract by making a needed future capability impossible. Worth doing *together with* a retention API, not before it. |
| Cache serialization diverges memory-vs-Redis | **Deferred (already documented)** | The guide's Drivers warning and the failure-modes table already state it. Normalising (JSON round-trip in memory too) would slow the fast path to make dev match prod — the wrong trade for a documented difference. |
| OAuth has no PKCE | **Deferred, with reasoning** | Confidential server-side flow with a `client_secret`, and the `state` is HMAC-signed, expiring and provider-bound. PKCE adds no attack-surface reduction here; OAuth 2.1's "universal" recommendation targets public clients. Reconsider if a public-client/native flow is ever shipped. |
| UI CHANGELOGs non-monotonic | **Deferred (scheduling)** | Purely cosmetic, and a release publish was in flight touching exactly those files. Not worth a merge conflict. |

### Newly flagged (found while implementing, not in the original review)

- **`ElasticsearchDriver.index()` and `bulk()` wrote different `_id`s** for the same
  document (fixed above, under F-7). Silent duplicates + an undeletable document
  for any id containing a URL-special character. This was a live bug, not a
  theoretical collision.
- **`AuditViewer.stats()` cannot be fixed by limit-pushdown alone** — aggregates need
  more than one page. Bounded with `maxScan` + `truncated` rather than pretending
  `total` is exact.

### Verification

- `pnpm turbo run typecheck` — **133/133**.
- `pnpm turbo run test` — **132/132**.
- Uncached per-suite: cache 32, audit 21, audit-prisma 6, audit-sqlite 9, audit-viewer 12,
  auth 131, auth-prisma 16, auth-sqlite 17, auth-saml 12, permissions 26, http 147,
  search-postgres 10, search-elasticsearch 18, exports-xlsx 7.
- `pnpm --filter docs docs:build` — green.
- Failing-first evidence recorded for every bug-class item: 8 red (cache), 4 red (audit
  redaction), 3 red (audit-prisma), 3 red (audit-sqlite, via `git stash` of the source),
  4 red (auth CAS), 3 red (permissions), 1 red (search-postgres), 2 red (ES ids),
  3 red (xlsx), 2 red (http pipeline, via `git stash`).
- 14 changesets: 10 feature/fix (advisory house style where a default tightens) plus the
  84-package manifest-hygiene patch.
