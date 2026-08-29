# BasaltKit Ecosystem Review — 2026-08 (Pass B)

_Principal-architect second pass. **Report only** — no code changed, nothing committed._
_Umbrella: Basalt 1.5+ (core 1.2.0). Current `main`, commit c6f661c3._

## Executive summary

The first-review backlog is implemented and **holds** (verification below). This pass
closes my earlier coverage gaps — I actually scaffolded, installed, booted and hit a real
app; traced MCP tool authorization end-to-end; swept every payment/storage/queue/UI package;
and assessed the bench harness. The **crypto and isolation cores are strong** (payment-webhook
HMAC + `timingSafeEqual` everywhere, outbound SSRF DNS-pinning, storage path-traversal choke
point, realtime tenant-keying, MCP header propagation with real parity). The new findings
cluster in **shipped-but-dangerous defaults and state machines**, not primitives: `billingRoutes`
serves card-management URLs with no auth; `checkout()` overwrites the subscription record and
lets a legitimately-signed webhook escalate a plan; `HookBus` doesn't isolate handlers so a
realtime push can fail a domain write; several queue drivers have silent job-loss / process-crash
paths; and the scaffolded app fails `pnpm typecheck` out of the box (one line). None re-litigate
closed items. The DX north-star is close but not green-on-first-run.

## Findings by severity

- 🔴 Critical: 2
- 🟠 Important: 6
- 🟡 Recommended: 8
- 🟢 Nice to have: 1 (a cluster)

## Verification of Pass-A fixes (mandate 2) — ALL HOLD

- **Neutral 404** — confirmed live: the booted scaffold returned `404 {"error":{"code":"NOT_FOUND",…}}` on an unknown route (real HTTP, Fastify).
- **Boundary tests gate CI** — `.github/workflows/ci.yml` runs `pnpm test` → `turbo run test`, which includes `packages/http/tests/adapter-boundary.test.ts` (adapter + dev-only-CLI rules) and the `testing` conformance suite; a violation fails the job. Coverage gate also enforced (`pnpm test:coverage`).
- **Conformance suite** — covers routing/params/query, body-validation 400 shape, `reply.code`, guard reject/allow, impersonation enrichers, `HttpError` mapping, and (upgraded) full-body neutral 404, `describe.each` × fastify/express/hono.
- **Captive guard** — `grep` shows zero `CaptiveDependencyError`/`DI_CAPTIVE` in any non-core `src/`; it fires on no legitimate path in the repo (full suite green).
- **MCP authorization** — parity is **real**: `packages/mcp/src/tools.ts` `makeInvoke` calls `runRoute(route, request, reply, { container, enrichers, guards })` — the *same* neutral pipeline as HTTP — and `mcpRoutes()` propagates `request.headers` into every tool call (`server.ts` → `tools.ts`). `packages/mcp/tests/adapters.test.ts:50-61` proves `x-tenant-id` reaches `ctx().tenant` inside a tool, and `meta.auth` guards run identically. No bypass found. (One residual: finding AI-1.)

---

## 1. Architecture

### 🟡 A-1 — Per-driver tenant scoping relies on service-layer threading; the driver signatures are fail-open by shape
- **Problem.** After S1 fixed `activity`, I swept every `*-prisma`/`*-sqlite` driver. The drivers take `tenantId?: string` **optional** and drop the filter when it's `undefined` (e.g. `packages/webhooks-prisma/src/index.ts:75` `remove(id, tenantId?)` → `where: tenantId === undefined ? { id } : { id, tenantId }`; `:81` `list(tenantId?)`; `packages/events-prisma/src/index.ts:68`). They are safe **only** because the service layer threads the ambient tenant (`packages/webhooks/src/index.ts:45` `currentTenantId()`, `events/src/outbox.ts`). The fail-open branch is one careless caller away from a cross-tenant read/delete.
- **Impact.** Latent cross-tenant exposure; the S1 helpers (`requireTenantId`/`tenantScoped`) exist precisely to remove this shape but aren't adopted here.
- **Proposal.** Adopt `requireTenantId()` in the service methods that currently pass `tenantId?` through (webhooks `list/remove/dispatch`, events outbox queries), so "no tenant" fails closed instead of widening. Keep the driver signature but make the service the fail-closed gate. Migration list, not a rewrite.
- **Trade-offs.** Touches service methods; each needs a test for the throw path.
- **Compatibility.** Behavior change only in the previously-fail-open branch (arguably a bugfix); minor per package.

### 🟡 A-2 — `/mcp` bundles N tool calls into one HTTP request, so per-request rate limiting counts them as one
- **Problem.** `securityPlugin`'s rate limiter keys on the HTTP request (`packages/http/src/security.ts`). The MCP transport (`packages/mcp/src/server.ts` `mcpRoutes`) accepts a JSON-RPC message and dispatches tool calls; a client can drive many `tools/call` operations through requests the limiter sees as single hits, and tool handlers themselves aren't rate-limited.
- **Impact.** An agent can amplify work/DB load past the intended per-client budget via the MCP surface. Auth still holds per tool (parity), so this is throttling, not authz.
- **Proposal.** Document that `/mcp` should carry a stricter `meta.rateLimit`, and/or add an optional per-tool-call counter in the MCP server. Do **not** build a bespoke limiter — reuse the existing `RateLimitStore`.
- **Trade-offs.** Small; opt-in.
- **Compatibility.** Additive.

---

## 2. Developer Experience — the north star, walked for real

**E2E run (workspace `create-basalt` build → registry install → boot → requests):** scaffold **0.05s**; `pnpm install` from the public registry **9.7s**; boot to `ready` **~1s**; `GET /health` **9ms**, returning `requestId` + `tenant`. Auth flow works end-to-end (`register` → `login` → `me` 200 with bearer; unauthenticated `me` → `401 AUTH_REQUIRED`); neutral 404 live; scaffolded `vitest` suite passes (1/1). `.env.example` is emitted (docs' `cp .env.example .env` holds). D1 defaults behaved correctly: non-TTY run **skipped install with the clear message**. Genuinely close to the north star — with one blocker:

### 🟠 D-1 — The scaffolded app fails `pnpm typecheck` out of the box (one line)
- **Problem.** `packages/create-app/src/templates.ts:126` emits `LOG_LEVEL: z.string().default('info')`, but `loggerPlugin({ level })` wants the `LogLevel` union (`packages/logger` exports `LOG_LEVELS` for exactly this). The generated `src/app.ts:20` therefore errors: `TS2322: Type 'string' is not assignable to '"info" | "fatal" | … '`. Confirmed by running `pnpm typecheck` in a real scaffold — exactly one error, this one.
- **Impact.** The first thing a diligent user runs (`typecheck`) is red on generated code — a bad first impression on the DX metric the framework optimizes for. `pnpm dev` still works (tsx doesn't type-check), so it's silent until CI.
- **Proposal.** Emit `import { LOG_LEVELS } from '@basaltkit/logger'` and `LOG_LEVEL: z.enum(LOG_LEVELS).default('info')`. One-line template fix. Add a create-app test that type-checks a generated app (would have caught this).
- **Trade-offs.** None.
- **Compatibility.** create-basalt patch.

---

## 3. Performance

### 🟡 P-1 — `@basaltkit/bench` exists and is well-built, but runs nowhere; there is no perf regression net
- **Problem.** `apps/bench` (autocannon; Basalt-fastify/express/hono vs plain fastify; warmup + median-of-3; the honest "cost of the neutral core" question) is a solid harness — but `grep` shows it's in **no** CI workflow and no `turbo` pipeline. Nothing catches a resolution/pipeline regression; I had to hand-bench the captive fix.
- **Impact.** Perf claims in the docs (`guide/benchmarks`) can silently rot; a regression in `runRoute`/Container ships unnoticed.
- **Proposal (measured, guardrail applied).** Do **not** gate PRs on throughput (noisy on shared runners → flaky). Instead add a tiny, deterministic **micro-bench of the hot path** (Container resolution + `runRoute` with a fixed payload, ops/sec, N iterations) as an opt-in `bench:micro` job that posts numbers to the PR, and run the full autocannon suite on a schedule/manual dispatch. Value is real (the framework's whole pitch is "neutral core, negligible overhead"); a hard gate would be over-engineering.
- **Trade-offs.** A little CI time; numbers-as-signal not pass/fail.
- **Compatibility.** CI/tooling only.

_No perf regression found; Container/pipeline remain lean (captive guard adds one O(1) compare, benchmarked at no measurable cost)._

---

## 4. Quality & Robustness

### 🟠 Q-1 — `HookBus.emit` doesn't isolate handlers, and the realtime bridge awaits into it — a UI push can fail a domain write
- **Problem.** `packages/core/src/hooks.ts:61-71` awaits each handler with no try/catch; the first throw aborts the chain and skips all remaining handlers **and every `onAny` handler** (audit/devtools/metrics), propagating into the emitting business code. `packages/realtime/src/plugin.ts:77-82` registers a hook handler that **returns** the broadcast promise, so `emit` awaits it — if Redis pub/sub is briefly down, a `note:created` write fails because a cosmetic fan-out failed. `EventBus.emit` (`packages/events/src/index.ts:98-111`) does this correctly (aggregates, never swallows) — `HookBus` should match.
- **Impact.** Availability + correctness: infra hiccups in a listener corrupt unrelated writes; audit trail silently skipped on any earlier hook throw.
- **Proposal.** Isolate handlers in `HookBus.emit` (collect errors, run all, then optionally `AggregateError`) mirroring `EventBus`; make the realtime bridge fire-and-log rather than block the emitter.
- **Trade-offs.** Changes error semantics of hooks (today one throw aborts) — but the current semantics are the bug.
- **Compatibility.** core minor; realtime patch.

### 🟠 Q-2 — BullMQ worker has no `error`/`failed` listener: an emitted `'error'` crashes the process; job failures are invisible
- **Problem.** `packages/queue/src/drivers/bullmq.ts:56-61` constructs `new Worker(...)` with no listeners. A BullMQ `Worker` is an `EventEmitter`; an emitted `'error'` (Redis fault) with no listener **throws and crashes Node**. No `'failed'` listener means a job exhausting retries produces zero framework log output.
- **Impact.** Production crash on a transient Redis blip; silent failure of exhausted jobs (only visible via `basalt queue:stats`). Largest observability gap in the queue stack.
- **Proposal.** Attach `worker.on('error', …)` (log, don't throw) and `worker.on('failed', …)` (surface via logger/hook).
- **Trade-offs.** None.
- **Compatibility.** queue patch.

### 🟠 Q-3 — realtime `deliverLocal` isn't crash-safe: one dead socket blackholes a broadcast and can crash the process
- **Problem.** `packages/realtime/src/hub.ts:161-166` iterates subscribers calling `connection.send(...)` with no try/catch. SSE `send` (`transport.ts:26`, `res.write`) throws on an aborted response; `ws.send` throws on a CLOSING socket. The throw aborts the loop — **subscribers after the dead one get nothing** — and via `RedisBackplane` the callback runs inside ioredis's `'message'` emitter (`drivers/redis.ts:37-40`), so the exception escapes and **crashes the process**. `JSON.parse(raw)` there (`:39`) is likewise unguarded.
- **Impact.** One stale connection (or one malformed backplane message) drops a broadcast for everyone / crashes a node in a multi-tenant SaaS.
- **Proposal.** try/catch per `send` (evict on failure); guard `JSON.parse` and validate `tenantId` on backplane input.
- **Trade-offs.** None.
- **Compatibility.** realtime patch. _(Realtime is opt-in and less mature — hence 🟠 not 🔴 — but the crash path is real.)_

### 🟡 Q-4 — Scheduler has no distributed lock: every replica runs every scheduled job
- **Problem.** `packages/scheduler/src/index.ts` overlap protection is a per-instance flag (`this.running`); there's no Redis/DB lease. On a horizontally-scaled SaaS (the kit's target), `schedule.job(ReconcileBilling).daily().at('03:00')` fires on all N pods. Nothing in the package or docs warns.
- **Impact.** N× duplicate execution of billing/reconciliation/email jobs.
- **Proposal.** Offer an optional lease (`withoutOverlapping({ store })` backed by the existing cache/Redis) and, minimally, document the multi-replica caveat loudly.
- **Trade-offs.** New optional surface; keep single-process default free.
- **Compatibility.** scheduler minor + docs.

### 🟡 Q-5 — Event outbox contradicts its own at-least-once guarantee (fire-and-forget capture, no overlap guard, no backoff)
- **Problem.** `packages/events/src/outbox.ts:161-165` captures events with `void outbox.enqueue(...)` — a transient store-write failure drops the event silently while the file header promises "nothing is lost." The flush timer (`:167-170`) has no overlap guard, so a slow dispatch lets the next tick re-select the in-flight batch → **double delivery**. `markFailed` sets no `nextAttemptAt` → immediate retry hammering; after `maxAttempts` the entry is filtered out forever with no dead-letter.
- **Impact.** Both lost events and duplicated deliveries, against the package's stated contract.
- **Proposal.** `await` the capture write (surface failures), add an in-flight flush guard (the scheduler next door has `withoutOverlapping`), add `nextAttemptAt` backoff + a dead-letter/counter.
- **Trade-offs.** Slightly more bookkeeping.
- **Compatibility.** events minor.

### 🟡 Q-6 — Sync (memory) queue driver is at-most-once, throws into the dispatcher, and leaks memory — and it's the default when `REDIS_URL` is unset
- **Problem.** `packages/queue/src/drivers/sync.ts:21-34` runs the handler inline, and on failure **loses the job and rethrows from `job.dispatch()`**; it's the default when `connection` is unset (`packages/queue/src/index.ts:66-70`). `executed[]` (`:15`) is never trimmed. So `POST /orders` dispatching `SendEmail` returns 500 + rolls back in dev, but 201 + background-retry in prod — a dev/prod semantic inversion — and a long-running process on the default driver leaks unboundedly.
- **Impact.** Surprising failure coupling and a memory leak on a misconfigured (no-Redis) production deploy.
- **Proposal.** Cap `executed[]`; document the sync driver as test/dev-only and fail loud (or warn) when it's selected outside `NODE_ENV=test`; consider not rethrowing handler errors into the dispatcher.
- **Trade-offs.** Behavior nuance around error propagation — decide deliberately.
- **Compatibility.** queue minor.

### 🟡 Q-7 — RabbitMQ driver: acks after an unconfirmed publish (job-loss window) and drops/crashes on shutdown
- **Problem.** `packages/queue-rabbitmq/src/index.ts:155-166` `sendToQueue(...)` (plain channel, unconfirmed, return value discarded) then `channel.ack(message)` — if the retry publish is lost, the ack already destroyed the only durable copy → **silent job loss** (SQS gets this right: send before delete). Shutdown (`:130-140`) tears the channel down under fire-and-forget handlers; an ack on the closed channel throws in `catch`, which `sendToQueue`s on the dead channel and throws again as an **unhandled rejection** (fatal). `startWorker` (`:126-134`, and Kafka `:130-142`) is fire-and-forget: a broker-connect failure at boot is invisible (app reports healthy with zero workers).
- **Impact.** Data-loss window + noisy/fatal shutdown + hidden boot failures — on opt-in drivers.
- **Proposal.** Use a confirm channel (await confirm before ack); track in-flight handlers and await on close with a deadline; make `startWorker` able to report failure.
- **Trade-offs.** Driver rework; contained.
- **Compatibility.** queue-rabbitmq/-kafka minor.

### 🟢 Q-8 (cluster) — Correctness papercuts to pin, not necessarily fix now
- Cron `parseCron` validates only field **count**: names/steps-on-range/typos become `NaN` and the job **never fires**, silently echoed by `schedule list` (`packages/scheduler/src/cron.ts:17-46`). · Cron day-of-month/day-of-week are AND-ed; POSIX cron OR-s them (`cron.ts:93-99`) — bites the `cron()` escape hatch only. · DST: spring-forward skips, fall-back double-runs (undocumented despite `timezone()` being advertised). · No drain deadline anywhere (`app.ts` shutdown); SQS shutdown stalls up to `waitTimeSeconds`; SQS poller hot-spins with zero logging on persistent errors (`queue-sqs/src/index.ts:151-154`); SQS 30s visibility with no heartbeat → long jobs run twice. · `Scheduler.safeTick` swallows every task failure (`scheduler/src/index.ts:218-225`). — Recommend fixing cron-accepts-invalid (easy, high-surprise) and the SQS hot-spin logging first.

---

## 5. Security

### 🔴 S-1 — `billingRoutes()` ships with no auth; identity is the unauthenticated tenant → anonymous card management
- **Problem.** `packages/subscriptions/src/plugin.ts:92-121` returns `POST /billing/checkout` and `POST /billing/portal` with **no `meta.auth`** (auth is opt-in: `packages/auth/src/plugin.ts:75`). The only identity is the ambient tenant (`plugin.ts:70-74` `billable()`), resolved from unauthenticated request data (Host/`x-tenant-id`). An anonymous `POST /billing/portal` with the right Host/header returns a live Customer Portal URL for that tenant — cancel subscription, change plan, view/replace card. Neither README nor `guide/billing.md` says to add `meta.auth`. (Verified.)
- **Impact.** Unauthenticated takeover of any tenant's billing. Critical.
- **Proposal.** Ship `billingRoutes()` with `meta: { auth: true }` on checkout/portal by default (opt-out for public flows), and document the requirement prominently. Consider requiring an authenticated user, not just a tenant, for portal/checkout.
- **Trade-offs.** Changes a default from open→closed (correct direction); apps relying on anonymous checkout must opt out.
- **Compatibility.** subscriptions minor, flagged as a security default change.

### 🔴 S-2 — `checkout()` overwrites the subscription record → plan escalation via a legitimately-signed webhook
- **Problem.** `packages/subscriptions/src/subscriptions.ts:160-161` unconditionally `store.save({ billableId, plan, period, status:'incomplete' })`, dropping the existing `gatewayRef`/`status`/`trialEndsAt`. A tenant on `basic` calls checkout for `enterprise`, **abandons** the gateway page; the local record now reads `enterprise/incomplete`. The next genuine, correctly-signed `payment.succeeded` for the *basic* subscription flips `status:'active'` (`:331-334`) with no plan/price cross-check, so `subscribed(id,'enterprise')` passes. Signature verification never sees anything wrong. Losing `gatewayRef` also silently breaks `cancel()` at the gateway. (The one-off `payment.ts:324` path *does* cross-check amount — the subscription path doesn't.) (Verified.)
- **Impact.** Plan escalation (paid-tier bypass) using only valid webhooks; and "cancelled" customers keep being charged.
- **Proposal.** `checkout()` should **merge**, not overwrite (preserve `gatewayRef`/current status until the gateway confirms the new plan); `handleWebhook` should cross-check the event's plan/price/subscription id against the record before activating.
- **Trade-offs.** State-machine care; add tests for abandon-then-renew.
- **Compatibility.** subscriptions patch/minor (bugfix).

### 🟠 S-3 — Files/storage: default-open upload validation + client-controlled Content-Type served via signed URL = stored XSS on a CDN origin
- **Problem.** `Files` validation is opt-in with an empty default (`packages/files/src/files.ts:93`), and the documented `filesPlugin` examples pass no `validate` → **unbounded size, any MIME**, no magic-byte sniffing. The client's declared MIME is trusted end-to-end and written as the object's real Content-Type (`packages/storage/src/drivers/s3.ts:48`, azure `:44`, gcs `:43`); the presign calls (`s3.ts:103-109` et al.) set **no** `ResponseContentDisposition`/`ResponseContentType`. Upload `text/html`, get a signed URL → the bucket serves HTML inline. On a CDN CNAME'd to the app domain (common), that's **stored XSS on the app origin**; the framework's `nosniff` doesn't apply to S3/Azure/GCS responses. (Path traversal + tenant prefixing are, separately, **done right** — single pre-scope choke point `storage/src/index.ts:52-61,154-161`, second guard on local disk, tests assert the negatives; file keys are server UUIDs, not user filenames.)
- **Impact.** Stored XSS + unbounded uploads by default.
- **Proposal.** Drivers set `ResponseContentDisposition: 'attachment'` (+ GCS `responseDisposition`, Azure SAS `contentDisposition`) on signed URLs by default; ship a default `maxSize`; document a safe-serving helper. Optionally magic-byte sniff when an allowlist is set.
- **Trade-offs.** `attachment` changes inline-view behavior — make it the default with an opt-out.
- **Compatibility.** storage-*/files minor.

### 🟠 S-4 — Mailer ships no HTML-escape primitive and the docs teach interpolating user data into HTML mail bodies
- **Problem.** `escapeHtml` exists but is module-private (`packages/mailer/src/preview.ts:37`, not exported from `index.ts`). The canonical `defineMail` example in JSDoc and README interpolates schema data straight into HTML (`message.ts:150` `html: ({name}) => \`<h1>Hello ${name}</h1>\``). `validateMailData` only `safeParse`s. So a user `name` of `</h1><a href="evil">…</a>` yields attacker markup in mail from the app's own DKIM/SPF-aligned domain — phishing/content-spoofing, XSS in weak webmail. Header injection **is** correctly blocked (`assertHeaderSafe`, `message.ts:95`), so the body asymmetry is stark. (`Mailer.deliver()` also skips `assertHeaderSafe` — a queue-roundtrip re-injection gap.)
- **Impact.** Every downstream app inherits an injection-prone mail-templating pattern.
- **Proposal.** Export `escapeHtml`; change the docstring/README examples to use it; call `assertHeaderSafe` in `deliver` too.
- **Trade-offs.** None.
- **Compatibility.** mailer minor (new export) + docs.

### 🟡 S-5 — Server-rendered UI packages: inconsistent HTML escaping + `</script>`-breakable JSON + undocumented CSP breakage
- **Problem.** Three near-identical `esc()` helpers with **three different charsets**: `teams-ui` escapes `"` (`html.ts:70`, safe), but `api-keys-ui` (`html.ts:67`) and `billing-ui` (`html.ts:54`) omit `"` yet use `esc()` in double-quoted attributes (`api-keys-ui:81`, `billing-ui:89`) → attribute-breakout XSS. All four inject `JSON.stringify(apiBase/headers/roles)` into inline `<script>` without breaking `</script>` (JSON.stringify doesn't escape `/`). Today **latent** — builders run once at route construction over developer constants — but the inputs (`title`, `headers` carrying `x-tenant-id`, `roles`) look exactly like where someone will plug per-tenant data. Separately, every page ships inline `<style>`/`<script>` that the framework's own `DEFAULT_CSP` (`http/src/security.ts:78`) blocks, with **zero** CSP docs in the four packages → operators reach for `contentSecurityPolicy: false` (kills CSP app-wide) instead of a route-scoped policy/hashes. (`audit-viewer` renders only escaped text fields — payloads are **not** rendered — and `dashboard` branding CSS is the strongest guard in scope.)
- **Impact.** Latent XSS traps + a footgun that disables CSP globally.
- **Proposal.** One shared `escapeHtml` (`&<>"'`) across the UI packages; escape `title`/`roles`; append `.replace(/</g,'\\u003c')` to the script-embedded JSON; document the required route-scoped CSP (hashes over the static blocks) in each README — follow `dashboard`'s example.
- **Trade-offs.** Small, mechanical.
- **Compatibility.** UI packages patch + docs.

### 🟡 S-6 — `LogMailDriver` is the silent default and writes full mail bodies (reset links, tokens) to stdout
- **Problem.** `packages/mailer/src/index.ts:189-190` falls through to `new LogMailDriver(...)` for any unrecognized/absent `driver`; it `console.log`s the entire body (`drivers/log.ts:11-14`). An unconfigured or typo'd-driver production deploy emits every password-reset/magic link to stdout, retained by log aggregators. (Real driver secrets are **not** logged — confirmed.)
- **Impact.** Credential/link leakage to logs on misconfiguration.
- **Proposal.** Fail loud on an unknown driver; require an explicit opt-in (or `NODE_ENV!=production` guard) for the log driver.
- **Trade-offs.** None meaningful.
- **Compatibility.** mailer minor.

### 🟡 S-7 — i18n passes a user-controlled locale to `Intl` unvalidated → self-inflicted 500s
- **Problem.** `packages/i18n/src/i18n.ts:41-44` returns `ctx().user.locale` raw and `in(locale)` hands it to `new Intl.NumberFormat/DateTimeFormat(locale, …)` (`:55-59`). `catalogLocale` validates only the *catalog* key, not the `Intl` locale. A profile locale like `en_US` (underscore) or `!!` throws `RangeError` on every `n()/currency()/date()` → 500 on any page that formats. (`__proto__`/`constructor` also defeat the catalog fallback via `Object.prototype`.)
- **Impact.** A user setting a bad locale field DoSes their own formatted pages.
- **Proposal.** Validate via `Intl.getCanonicalLocales()` in try/catch, fall back to `defaultLocale`; use `Object.hasOwn` for catalog lookup.
- **Trade-offs.** None.
- **Compatibility.** i18n patch.

_Confirmed strong (no action): payment-webhook HMAC + `timingSafeEqual` + length pre-check in every driver, unsigned/forged POST can't mark paid (verify-before-mutate, fail-closed on missing secret), outbound webhook SSRF DNS-pinning with redirect refusal, dedupe-with-rollback, storage path traversal + tenant prefix, SDK token handling, realtime tenant-keying, MCP header-propagation parity._

---

## 6. AI & MCP boundaries

MCP tool authorization **has real parity** (see verification section) — the deferred security concern resolves as *safe*. The three-layer split remains crisp. Only residual is **A-2** (rate-limit granularity on `/mcp`). No duplication or over-capability found; `ai-mcp` write-confinement and the dev-only boundary test still hold.

---

## Deliberately NOT recommended (over-engineering)

- **A magic Prisma middleware that auto-injects `tenantId` on every query** (re: A-1) — invasive, adapter-specific, surprising for single-tenant apps. Keep the opt-in `requireTenantId`/`tenantScoped` gate at the service layer.
- **A throughput pass/fail perf gate in CI** (re: P-1) — noisy on shared runners → flaky. Numbers-as-signal + a deterministic micro-bench only.
- **A full ACL/policy engine for MCP tools** — the neutral guards already run per tool; adding a parallel authorization layer would duplicate `permissions`/`auth`. Just document `meta.rateLimit` on `/mcp`.
- **Rewriting the queue drivers onto a common base class** — the capability-negotiation design is a strength; fix the specific correctness bugs (Q-2/Q-6/Q-7) in place, don't refactor the abstraction.
- **A bespoke HTML templating engine for the UI packages** — one shared `escapeHtml` + `</script>` breaking is enough; don't introduce a template layer.

## Coverage & limits

- **E2E scaffold:** ran the **default** preset (auth+tenancy) fully (install from public registry, boot, HTTP incl. auth). Did **not** run `--ui` (pnpm-workspace web frontend), `--billing`, `--cli`, or `--mcp` scaffolds end-to-end — only the default app was booted. `pnpm install` reached the network here; if your sandbox can't, that step is where it would stop.
- **Payments:** analyzed signature/state logic across all gateway drivers via the sweep; did **not** run against a live Stripe/ProxyPay/AppyPay sandbox (AppyPay still unpublished/parked).
- **Queue/realtime drivers:** reviewed source for BullMQ/Kafka/RabbitMQ/SQS/Redis-backplane; did **not** exercise them against live brokers — findings are from code + contracts, not observed failures.
- **UI XSS findings are latent** (boot-time constant inputs today); labeled as traps, not live holes, except the default-CSP breakage which is live.
- **Not re-audited:** the auth/permissions internals and the http security edge (closed in the prior security audit + Pass A); admin-react/shadcn (React auto-escaping, `grep` clean for `dangerouslySetInnerHTML`/`eval`).
- **Depth:** this pass went deep on subscriptions, storage/files, queue/events/scheduler/realtime, mailer/i18n/UI, MCP, and the scaffold path; ranked by risk, not exhaustive.

---

## Implementation-status addendum — 🟡 batch (2026-08-29)

_All 🔴/🟠 items were closed in PRs #243–#247. This addendum records the disposition of the
remaining 🟡 findings (A-1, A-2, P-1, Q-4, Q-5, Q-6, Q-7, S-5, S-6, S-7) plus opportunistic
🟢 Q-8 pins. Every premise was re-verified on current `main` before acting; every implemented
bug-class item has failing-first test evidence; full `turbo typecheck` + `turbo test` green._

| Finding | Disposition | Shipped as |
| --- | --- | --- |
| A-1 driver signatures fail-open | **Implemented (scoped)** | webhooks minor |
| A-2 `/mcp` rate limiting | **Minimal** (premise partially stale) | mcp minor |
| P-1 bench in CI | **Deferred** | — |
| Q-4 scheduler distributed lock | **Implemented** | scheduler minor |
| Q-5 outbox at-least-once | **Implemented** | events minor |
| Q-6 sync queue driver | **Implemented (minimal)** | queue patch |
| Q-7 rabbit ack-before-confirm | **Implemented** | queue-rabbitmq minor |
| S-5 UI escaping/CSP | **Implemented** | http + 4 UI packages minor |
| S-6 LogMailDriver bodies | **Implemented** | mailer minor |
| S-7 i18n locale → Intl | **Implemented** | i18n patch |
| Q-8 cluster (🟢) | **2 pins implemented**, rest still pinned | scheduler minor, queue-sqs minor |

### Per-finding notes

- **A-1 — Implemented, scoped to the genuinely fail-open surface.** Premise re-verified:
  `WebhookManager.list(tenantId?)` and `dispatch(event, data, tenantId?)` trusted the caller's
  argument with no ambient-context check — inside a tenant request, `list()` returned every
  tenant's endpoints and `dispatch()` fanned a tenant's event data out to other tenants'
  endpoints. Both now follow the `Audit.trail()`/`requireTenantId` anti-widening rule (context
  tenant always wins; explicit args/system-wide behavior only with no ambient tenant, so
  single-tenant apps are untouched). **Declined** the follow-up of making `audit`/`comments`
  delegate to tenancy's helpers: both already fail closed with identical semantics locally, and
  adding a `@basaltkit/tenancy` dependency to deduplicate ~10 lines increases coupling for zero
  behavioral gain — the service-layer boundary stands, as leaned in the original finding.
- **A-2 — Minimal; original premise is stale on current main.** `handleMessage` processes exactly
  ONE JSON-RPC message per HTTP request (an array body fails `INVALID_REQUEST`), so the
  per-request limiter counts tool calls 1:1 — no bundling amplification. The real residual found
  during re-verification: a tool route's own `meta.rateLimit` applies only to its direct HTTP
  registration, not when invoked via `/mcp` (rate limiting lives in `securityPlugin`'s edge hook,
  not in `runRoute`). Shipped the review's own minimal proposal: `mcpRoutes({ rateLimit })`
  stamps `meta.rateLimit` on `/mcp` (reusing the existing per-route override mechanism, no
  bespoke limiter) + docs EN/PT stating the bypass explicitly.
- **P-1 — Deferred, guardrail applied.** The gap is real (bench harness runs in no workflow), but
  everything I could ship from here is speculative: a GitHub Actions workflow I cannot execute or
  validate, producing throughput numbers on shared runners that are noise even as "signal", plus
  a micro-bench script with no consumer. No perf regression exists today (hand-benched for the
  captive-guard fix). Recommendation stands for when it's picked up deliberately: deterministic
  micro-bench (Container resolution + `runRoute` ops/sec) as `workflow_dispatch` + weekly
  schedule, numbers-as-output, never a PR gate.
- **Q-4 — Implemented as a lock *contract*, not an implementation.** `ScheduleEntry.onOneServer()`
  + `ScheduleLock { acquire(key, ttlMs) }` + `schedulerPlugin({ lock, lockTtlMs })`. One replica
  acquires a per-entry-per-minute key and runs; others skip (counted in `skippedByLock`).
  Deliberately no `release` — the key covers the tick window so a fast first run can't be
  followed by a late replica re-running the same minute. Fail-loud at boot if `.onOneServer()` is
  used without a lock. No new dependency: the framework ships the contract and docs show the
  5-line ioredis `SET NX PX` implementation. Not built: leader election/Raft, a cache-contract
  `add()` extension (would ripple through every cache driver + conformance suite for one
  consumer).
- **Q-5 — Implemented within the existing outbox design.** Capture awaited (a failed outbox write
  now fails `emit()` — the transactional-outbox contract), concurrent flushes coalesce,
  process-local exponential backoff (no store/schema change — a deliberate trade-off: a relay
  restart permits one immediate retry, still at-least-once; avoids a breaking `OutboxStore`
  contract change and an events-prisma migration), `onDead` fired once per exhausted entry,
  `onFlushError` for store-level faults in the timer/shutdown paths. Found and fixed en route: a
  double-count where `MemoryOutboxStore.markFailed` mutates the shared entry object.
- **Q-6 — Implemented minimally, per the framework-norms constraint.** `executed[]` capped at
  1000; boot warning when the sync driver is selected implicitly in production (explicit
  `driver: new SyncQueueDriver()` stays silent); semantics documented (at-most-once, errors
  reject `dispatch()`). **Deliberately kept** the error-rethrow behavior — it's what makes the
  driver useful in tests/dev, and silently converting it to fire-and-forget would be its own
  dev/prod surprise; the warning + docs address the inversion.
- **Q-7 — Implemented.** Confirm channel preferred (`createConfirmChannel` when the connection
  offers it), `waitForConfirms` awaited after every publish and BEFORE ack in the failure path —
  a nacked/lost re-publish leaves the message unacked for broker redelivery (at-least-once,
  window closed). `close()` drains in-flight handlers with a `drainTimeoutMs` deadline;
  mid-shutdown deliveries stay unacked; `handle()` can no longer throw into the consume callback
  (ack/publish faults → `onError`); `startWorker` connect failures surface via `onError` instead
  of an invisible zero-worker boot. 6 failing-first tests, including the unconfirmed-publish
  no-ack case and the drain-before-teardown case.
- **S-5 — Implemented as a sweep + one shared primitive set.** New in `@basaltkit/http`:
  `escapeHtml` (single charset `& < > " '`), `scriptJson` (`</script>`-breakout-safe JSON, plus
  U+2028/9), `pageCsp`/`cspHash`. All four UI packages: server-side `title`/`roles` escaped,
  embedded state via `scriptJson`, client `esc()` unified to include quotes, and — beyond the
  review's docs-only proposal, because the CSP breakage was the one *live* item — each route now
  serves a **route-scoped CSP by default** with the page's inline script allowed only by sha256
  hash (`…PageCsp()` exports; `csp: string | false` opt-out). `style-src 'unsafe-inline'` is the
  accepted residual (hash sources can't cover `style=""` attributes). CSP + escaping documented
  in `admin-pages` guide (EN/PT) and each README. No template engine introduced.
- **S-6 — Implemented.** `LogMailDriver` redacts bodies when `NODE_ENV=production` (metadata
  still logged; `logBody: true` to opt back in — dev/test unchanged so magic links still print
  locally), and `mailerPlugin` throws on an unrecognized `driver` string instead of silently
  falling through to logging outbound mail.
- **S-7 — Implemented.** Resolved locale validated via `Intl.getCanonicalLocales` (fallback to
  `defaultLocale`); catalog negotiation uses `Object.hasOwn` (no `__proto__`/`constructor`
  prototype traversal). `Translator.locale` now reports the effective locale.
- **Q-8 (🟢) — two highest-surprise pins done while in those files:** cron field validation
  (`parseCron` rejects names/out-of-range/reversed-range/`*/0` with `CronParseError` instead of a
  job that silently never fires) and SQS receive-error visibility (`onError` + `errorPauseMs`
  pause instead of a silent hot spin). **Still pinned, not fixed:** cron DOM/DOW AND-vs-OR
  divergence from POSIX, DST skip/double-run documentation, app-level drain deadline, SQS
  visibility-timeout heartbeat for long jobs, `Scheduler.safeTick` swallowing (mitigated: tick
  aggregates; entries have `onFailure`).

### Newly flagged while implementing

- `MemoryOutboxStore.markFailed` mutates the entry object it previously returned from
  `pending()` — any relay-side read of `entry.attempts` after marking sees the post-increment
  value (memory store only; Prisma/SQLite return copies). Worked around in `Outbox.doFlush`;
  worth normalizing to return-copies if the store is ever touched again.
- The four UI pages embed `headers` values (e.g. `x-tenant-id`) in page source by design — now
  documented as "never put secrets in `headers`" in the admin-pages guide.

### Changesets in this batch

`i18n-locale-validation` (patch) · `mailer-log-driver-redaction` (minor) ·
`queue-sync-driver-bounds` (patch) · `queue-rabbitmq-confirms-drain` (minor) ·
`queue-sqs-receive-errors` (minor) · `events-outbox-at-least-once` (minor) ·
`scheduler-one-server-lock` (minor) · `webhooks-anti-widening-scope` (minor) ·
`http-html-helpers` (minor) · `ui-packages-escaping-csp` (4× minor) ·
`mcp-rate-limit-option` (minor). Docs EN+PT updated: scheduler, queues, persistence
(outbox), i18n, notifications (mailer), mcp, admin-pages, webhooks; READMEs for all
touched packages.
