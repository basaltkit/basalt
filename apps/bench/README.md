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

## Methodology

Fair comparison is easy to get wrong. This harness:

- **Runs each server in its own process** (`src/server-runner.ts`, spawned by
  `run.ts`). No sockets, GC, JIT or event-loop state carries over from another
  server — so the server measured *last* isn't penalised by contention from the
  ones before it.
- **Warms up** at the measurement concurrency and **discards** it, so connection
  setup and JIT compilation aren't counted.
- **Runs N iterations and reports the median**, with a short cooldown between
  runs and a clean shutdown of each server.
- **Reports p50 (median) and p99 latency — never the arithmetic mean.** The mean
  is dominated by a handful of outliers and can read hundreds of ms while p99 is
  in single digits; p50/p99 describe the real distribution. An `errors` column
  (timeouts + socket errors + non-2xx) flags any run you shouldn't trust.

## Run

```bash
pnpm --filter @basaltkit/bench bench
# knobs (with defaults):
BENCH_CONNECTIONS=50 BENCH_DURATION=10 BENCH_ITERATIONS=3 BENCH_WARMUP=3 \
  pnpm --filter @basaltkit/bench bench
```

## Sample result

`50 connections · 10s · median of 3 iterations`, Apple Silicon, Node 24 —
**absolute numbers are machine-specific; read the gaps, not the digits:**

| server               | GET /health req/s | vs #1 | POST /echo req/s | vs #1 |
| -------------------- | ----------------: | ----: | ---------------: | ----: |
| plain fastify        |            59,943 |  100% |           39,114 |  100% |
| **Basalt · fastify** |            49,884 |   83% |           34,474 |   88% |
| Basalt · express     |            32,136 |   54% |           27,228 |   70% |
| Basalt · hono        |            26,665 |   44% |           18,987 |   49% |

p50 latency was sub-millisecond to ~2 ms and p99 ≤ 5 ms across the board, with
zero errors.

## How to read it

- **Basalt on Fastify keeps ~83–88% of raw Fastify throughput** — roughly a
  10–17% overhead for the container, route metadata, plugin boot, request
  context and validation pipeline. Meaningful but modest; you're trading it for
  the whole `@basaltkit/*` toolkit.
- **Express and Hono are slower because those runtimes are slower**, not because
  Basalt costs more on them: the Basalt layer is identical across all three (same
  `route()` objects). The gap you see is the adapter's own request cost. Pick the
  adapter for its ecosystem; Basalt doesn't lock the number in.
- Even the slowest row serves ~19k validated req/s on a laptop — far above what a
  typical SaaS API needs. Your database and network are the ceiling long before
  the framework is.
