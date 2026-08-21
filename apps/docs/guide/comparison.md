# Basalt vs other frameworks

A fair question when you arrive: *why Basalt and not NestJS, AdonisJS or plain
Fastify?* Here's an honest positioning — including where the others are stronger.

## Where Basalt fits

Basalt borrows its **mechanism** from NestJS / AdonisJS (a DI container, a plugin
lifecycle, a request context) and its **breadth of batteries** from the Laravel
ecosystem — aimed squarely at **multi-tenant SaaS**, and agnostic to the HTTP
server underneath.

The Laravel DNA is deliberate: `@basaltkit/subscriptions` echoes **Cashier**,
`@basaltkit/permissions` and `@basaltkit/activity` follow **Spatie**, and the
billing model draws on **Soulbscription** — but rebuilt for TypeScript.

## At a glance

| | **Basalt** | **NestJS** | **AdonisJS** | **Laravel** (PHP) | **Fastify / Hono** |
| --- | --- | --- | --- | --- | --- |
| Kind | Backend framework | Backend framework | Full-stack framework | Full-stack framework | HTTP micro-framework |
| Language | TypeScript (Zod-first) | TypeScript | TypeScript | PHP | JS/TS |
| IoC / DI | Token container, **no decorators** | Container, **decorators + reflection** | Container | Container | — |
| HTTP server | **Adapter-neutral** (Fastify/Express/Hono) | Express/Fastify | Own | Own | *is* the server |
| Multi-tenancy | **Built in** (resolvers, scoping, fail-closed) | Build it yourself | Build it yourself | Packages | Build it yourself |
| Auth · Teams · Billing · Permissions · Queues · Search · Realtime · Webhooks · … | **Included** (78 packages) | Minimal core + ecosystem | Several included | Huge ecosystem | — |
| Frontend | SDK + headless admin (backend-focused) | — | Edge / Inertia | Blade / Livewire | — |
| Maturity | New (1.x) | Battle-tested | Established | Very mature | Very mature |

## What makes Basalt distinctive

- **Multi-tenancy is first-class.** Pluggable resolvers (subdomain, domain,
  header, route), a Prisma extension that scopes every query to the active
  tenant and **fails closed** without one, and per-request tenant context. In
  most frameworks you build this yourself.
- **SaaS batteries that fit together.** Auth, teams + invitations, subscriptions
  + payment gateways, permissions, queues, search, realtime, webhooks,
  notifications, activity/audit, storage, mailer, i18n, flags, exports — the
  breadth of the Laravel ecosystem, integrated and typed.
- **Adapter-neutral.** The same typed routes, enrichers and guards run on
  Fastify, Express or Hono. Swapping the HTTP layer doesn't touch your app.
- **Zod-first, no decorators.** Schemas drive the types, the OpenAPI document and
  the type-safe SDK — no reflection metadata, no `@Decorators`.

## Where the others are stronger (honestly)

- **Maturity & community.** NestJS and Laravel have years of production
  hardening, thousands of third-party packages, tutorials and a hiring pool.
  Basalt is young.
- **Full-stack.** Laravel and AdonisJS ship views and frontend tooling; Basalt
  is backend + an SDK / headless admin — you bring your own frontend.
- **Decorator style.** If you like NestJS's `@Injectable()` / `@Get()`, Basalt's
  explicit functions-and-tokens approach is a different taste — better or worse
  depending on you.

## When Basalt is a great fit

- You're building a **multi-tenant SaaS** and don't want to reinvent tenancy,
  auth, teams, billing and permissions.
- You want **TypeScript end-to-end** with schema-driven types, OpenAPI and a
  generated client.
- You value **small, composable packages** and picking only what you need — it
  works just as well for a plain API (see [Beyond SaaS](./beyond-saas)).

## When to reach for something else

- You need a **mature, huge ecosystem** and lots of hiring/tutorial coverage
  today → NestJS or Laravel.
- You want an **integrated full-stack** experience with server-rendered views →
  Laravel or AdonisJS.
- You just need a **tiny HTTP service** with no framework at all → Fastify or
  Hono on their own.

## In one line

> **The Laravel of TypeScript, built for multi-tenant SaaS** — Laravel's breadth
> of batteries, a Nest-style plugin/DI core, HTTP-adapter-neutral, with
> multi-tenancy from the ground up.
