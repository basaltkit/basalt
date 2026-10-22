# Built with Basalt

Basalt grew out of real products, not the other way round. Four applications in
four different domains run on it today. Each one found gaps that went back into
the framework as fixes and new packages.

| App | Domain | Tenancy | Basalt packages |
| --- | --- | --- | --- |
| [Mukanda](#mukanda) | Document management and process digitisation | Central + one PostgreSQL schema per company | 43 |
| [Corredor](#corredor) | B2B logistics | Central + one PostgreSQL schema per tenant | 28 |
| [lexfirma](#lexfirma) | Practice management for law firms | One PostgreSQL schema per firm | 47 |
| [producer-basalt](#producer-basalt) | Backend for an agricultural mobile app | Single tenant, MySQL | 21 |

The package count includes each app's web frontend (`web/`) and the dev-only
tools (`generator`, `testing`, `ai-mcp`, `deploy`).

[[toc]]

## Mukanda {#mukanda}

Document management and process digitisation for companies. A central schema
holds the companies, their plans and the staff; each company gets its own
PostgreSQL schema with its own Prisma client — the
[two planes](/guide/multi-tenant-pattern) pattern.

- **Documents:** `files` with `files-prisma`, S3 storage, and the cloud
  [drives](/guide/drives) (Dropbox, Google Drive, OneDrive).
- **Work around them:** `notifications`, `webhooks`, `realtime`, spreadsheet
  [exports](/guide/exports), and `audit` with its viewer.
- **Background work:** BullMQ [queues](/guide/queues) and the
  [scheduler](/guide/scheduler).
- **Billing and access:** `subscriptions`, `teams`, `permissions`, `auth`.
- **Operations:** an [MCP](/guide/mcp) server, and deploys with
  [`@basaltkit/deploy`](/guide/deploy).

Mukanda is the app that pushed Basalt the hardest. It kept a written list of
every framework gap it hit (BK-025 to BK-087), and the whole list shipped as
framework releases in [Basalt 1.13](/guide/whats-new).

## Corredor {#corredor}

A B2B logistics platform. It tracks the whole flow — order, load, carrier,
vehicle, driver, operation, delivery, proof of delivery — with live updates per
tenant over Server-Sent Events.

- **Tenancy:** a central database (the tenant registry, subscriptions, counters)
  and one PostgreSQL schema per tenant, with two Prisma clients.
- **Live updates:** [realtime](/guide/realtime), one stream per tenant.
- **Integration:** `webhooks`, `events`, `audit`, S3 storage, and an
  [MCP](/guide/mcp) server.
- **Billing:** `subscriptions` with Prisma.

## lexfirma {#lexfirma}

Practice management for law firms in Angola: contacts, clients, cases,
deadlines, hearings, documents, communications, fees and invoicing, and a portal
where clients follow their own cases.

- **Isolation:** each firm is a tenant with its own PostgreSQL schema, not a
  column that separates rows.
- **Payments:** [reference payments](/guide/reference-payments) through ProxyPay,
  on top of `subscriptions`.
- **Finding things:** PostgreSQL full-text [search](/guide/search).
- **Accountability:** `activity`, `audit`, `notifications`, and PostgreSQL
  [backups](/guide/backup).
- **Frontend:** the admin console is built from `admin`, `admin-react` and
  `admin-shadcn`, with `dashboard`, `realtime-client` and the typed
  [SDK](/guide/web-ui).

## producer-basalt {#producer-basalt}

The backend of an agricultural mobile app, rebuilt on Basalt. The old backend
had its own hand-rolled framework. The rebuild replaced it completely while
keeping the mobile app's offline sync (WatermelonDB) algorithm byte for byte and
the same `/v1` API contract. The mobile app did not have to change.

- **HTTP:** `createApp` with the security, metrics and OpenAPI plugins, on
  Fastify.
- **Data:** the existing MySQL schema through `prisma`, unchanged.
- **Auth:** `auth` over the existing users table, compatible with the old
  password hashes and the old `/v1/auth` routes.
- **Uploads:** `storage` on S3-compatible storage.
- **Background work:** [queues](/guide/queues) on BullMQ and RabbitMQ.
- **AI tooling:** an [MCP](/guide/mcp) server with data tools scoped by role and
  audited.

It shows a path the other three do not: moving an existing production backend
onto Basalt without breaking the clients that depend on it.

## What they have in common

- **The same building blocks, very different products.** `core`, `http`,
  `auth`, `prisma` and `fastify` are in all four. Everything else is chosen per
  app.
- **Domain code in the app, cross-cutting code in the framework.** When an app
  needed something generic, it went into Basalt as a package or a fix, not into
  a local patch.
- **One deploy path.** Three of the four deploy with `@basaltkit/deploy` to a
  plain Linux server.

## See also

- [Basalt vs other frameworks](/guide/comparison) — where Basalt fits, and where
  the others are stronger.
- [Build a notes SaaS](/cookbook/notes-saas) — the same journey these apps took,
  from an empty folder to a server.
