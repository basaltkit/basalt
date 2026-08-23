# @basaltkit/bench

A small, honest load test that answers one question: **how much does Basalt's
neutral HTTP core cost over the bare adapter?**

It boots the *same two routes* — one trivial (`GET /health`) and one Zod-validated
(`POST /echo`) — four ways and hammers each with [autocannon](https://github.com/mcollina/autocannon):

- **Basalt · fastify** — `createApp({ plugins: [fastifyPlugin({ routes })] })`
- **Basalt · express** — same routes, `expressPlugin`
- **Basalt · hono** — same routes, `honoPlugin` (served with `@hono/node-server`)
- **plain fastify** — a hand-written Fastify server, no Basalt (the baseline)

The routes are declared **once** with the adapter-agnostic `route()` from
`@basaltkit/http` (`src/routes.ts`) and reused by all three adapters — which is the
whole point: one route definition, any runtime.

## Run

```bash
pnpm --filter @basaltkit/bench bench
# knobs:
BENCH_DURATION=20 BENCH_CONNECTIONS=100 pnpm --filter @basaltkit/bench bench
```

## Sample result

`50 connections · 10s`, Apple Silicon, Node 22 — **absolute numbers are
machine-specific; read the gaps, not the digits:**

| server            | GET /health req/s | vs #1 | POST /echo req/s | vs #1 |
| ----------------- | ----------------: | ----: | ---------------: | ----: |
| plain fastify     |            31,971 |  100% |           25,429 |  100% |
| **Basalt · fastify** |         30,337 |   95% |           22,990 |   90% |
| Basalt · express  |            21,656 |   68% |           16,434 |   65% |
| Basalt · hono     |            20,498 |   64% |           14,607 |   57% |

## How to read it

- **Basalt on Fastify keeps ~90–95% of raw Fastify throughput.** The container,
  route metadata, plugin boot and validation pipeline add single-digit percent
  overhead — the abstraction is close to free.
- **Express and Hono are slower because those runtimes are slower**, not because
  Basalt costs more on them: the Basalt layer is identical across all three (same
  `route()` objects). The gap you see is the adapter's own request cost. Pick the
  adapter for its ecosystem; Basalt doesn't lock the number in.
- Even the slowest row serves ~14k validated req/s on a laptop — far above what a
  typical SaaS API needs.
