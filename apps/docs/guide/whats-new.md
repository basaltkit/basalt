# What's new in Basalt 1.3

> *"Basalt 1.3" is the umbrella label for this wave of work; the `@basaltkit/*`
> packages ship independently (see [Versioning](/guide/versioning)). Below is what
> landed and the package version that carries it.*

Basalt 1.3 rounds out the framework's scaling, real-time and passwordless story —
and hardens all of it with a dedicated adversarial security pass.

## Highlights

### Real-time & transport
- **Server-Sent Events** — typed `sse()` producers wired identically into Fastify,
  Express and Hono. `send()` returns a backpressure signal; `id`/`event` are
  injection-safe. *(`@basaltkit/http` 1.8, adapters 1.5/1.2/1.2)*

### Scaling data
- **Read replicas** — `readReplica({ primary, replicas, extend })` routes reads
  across replicas and writes to the primary; `extend` guarantees every replica
  carries your tenant scoping. *(`@basaltkit/prisma` 1.4)*
- **Horizontal sharding** — `ShardRouter` maps each tenant to a fixed database with
  a deterministic hash; wire it with `prismaPlugin({ shards })`. *(`@basaltkit/prisma` 1.4)*

### Multi-tenancy
- **Custom domains** — register a tenant's own domain, prove ownership with a DNS
  TXT record, and resolve only **verified** domains via `findByVerifiedDomain`.
  *(`@basaltkit/tenancy` 1.3)*

### Auth
- **WebAuthn / passkeys** — the full registration & authentication ceremony
  (challenges, options, credential storage, clone detection) with a pluggable
  crypto verifier, so the framework carries no WebAuthn dependency.
  *(`@basaltkit/auth` 1.6)*

### Notifications
- **SMS & WhatsApp channels** over a provider-agnostic `SmsSender` — no provider
  SDK in the framework. *(`@basaltkit/notifications` 1.2)*

### Dashboard
- **Analytics** — the MRR movement bridge (new / expansion / contraction / churn /
  reactivation) plus period-over-period growth. *(`@basaltkit/dashboard` 1.4)*
- **White-label branding** — per-tenant product name, logo and colours rendered to
  CSS custom properties. *(`@basaltkit/dashboard` 1.4)*

### Developer experience
- **DI-graph devtools** — `container.describe()`, a passive dependency graph, and a
  Mermaid renderer. *(`@basaltkit/core` 1.1)*

## Security hardening

Every new component above went through an adversarial security audit before this
release. One critical and several high/medium issues were found and fixed with
regression tests:

- **Critical:** closed a tenant-controlled stored-XSS vector in white-label CSS.
- **High:** WebAuthn registration is bound to its subject (no cross-account passkey
  binding); read replicas can't route around tenant scoping; custom-domain
  operations are tenant-scoped with a shared IDNA-aware normalizer and revoke-on-
  re-check; SSE `id`/`event` are injection-safe.

See the [security audit notes](/guide/production#reliability) for the full picture.

## Upgrading

Packages are independent — bump only what you use; ranges are semver, so a `1.x`
minor is a drop-in. Two behaviour refinements from the security pass:

- `CustomDomains.verify` / `instructions` / `remove` now take the owning `tenantId`
  as their first argument.
- `readReplica` keeps `$queryRaw` on the primary by default — opt into replica raw
  reads with `rawReadsOnReplica: true`.
