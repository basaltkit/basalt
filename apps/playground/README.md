# playground

Basalt's reference app and living end-to-end of the core — config, env, logger,
events, multi-tenancy and HTTP — wired together in ~120 lines.

Its point is the **adapter-agnostic** design: one neutral `route()` list
(`src/routes.ts`, a small Projects CRUD + tenancy + health) and one set of
plugins (`src/app.ts`), served on **any** of the three HTTP adapters. Only the
last line of `buildApp()` differs per runtime — everything above it is identical.

## Run

```bash
pnpm --filter playground dev              # fastify (default)
ADAPTER=express pnpm --filter playground dev
ADAPTER=hono    pnpm --filter playground dev
```

Then:

```bash
curl -X POST localhost:3000/projects -H 'content-type: application/json' -d '{"name":"Basalt"}'
curl localhost:3000/projects
curl localhost:3000/projects -H 'x-tenant-id: acme'   # tenant-scoped
curl localhost:3000/health
```

## What it demonstrates

| Concern | Where |
| --- | --- |
| Neutral routes (Zod body/params, `HttpError`, `reply.code()`) | `src/routes.ts` |
| DI container + domain services | `src/domain.ts` |
| Plugin composition + adapter swap | `src/app.ts` |
| Events with a `project.**` wildcard audit listener | `src/app.ts` |
| Multi-tenancy (header + subdomain resolvers, ALS context) | `src/app.ts` |
| Typed env (`ADAPTER`, `LOG_LEVEL` validated against `LOG_LEVELS`) | `src/server.ts` |

## Tests

```bash
pnpm --filter playground test
```

- `tests/e2e.test.ts` — the full flow via Fastify's `inject()`.
- `tests/adapters.e2e.test.ts` — the **same** flow over a real socket on
  fastify, express **and** hono, proving the routes are runtime-neutral.
