# Benchmarks

> *How much does Basalt's neutral core cost over the bare HTTP server?*

Short answer: **on Fastify, roughly 10–17% throughput overhead** for the
container, plugin boot, request context, route metadata and validation pipeline.
Meaningful but modest — you're trading it for the whole `@basaltkit/*` toolkit.
The reproducible harness lives in
[`apps/bench`](https://github.com/basaltkit/basalt/tree/main/apps/bench).

## Method

The **same two routes** are defined once with the adapter-agnostic `route()` from
`@basaltkit/http` and served four ways — three Basalt adapters plus a hand-written
Fastify baseline:

- `GET /health` — trivial handler, measures pure framework overhead
- `POST /echo` — a Zod-validated body, measures the validation path

```ts
// src/routes.ts — one definition, every adapter
export const routes = [
  route({ method: 'GET', url: '/health', async handler() { return { ok: true } } }),
  route({
    method: 'POST', url: '/echo',
    body: z.object({ name: z.string(), n: z.number() }),
    async handler({ body }) { return { hello: body.name, doubled: body.n * 2 } },
  }),
]
```

Fair comparison is easy to get wrong, so the harness:

- **Runs each server in its own process** — no sockets, GC, JIT or event-loop
  state carries over, so the server measured *last* isn't penalised by the ones
  before it. (Running everything in one process skews the mean and can even make
  a wrapper look *faster* than the server it wraps.)
- **Warms up** at the measurement concurrency and discards it.
- **Runs several iterations and reports the median**, with cooldowns and a clean
  shutdown between servers.
- **Reports p50 (median) and p99 latency, never the arithmetic mean** — the mean
  is skewed by a handful of outliers. An `errors` count flags any untrustworthy
  run.

## Results

`50 connections · 10s · median of 3 iterations` on Apple Silicon / Node 24.
**Absolute numbers are machine-specific — read the gaps between rows, not the
digits.** Zero errors across all runs.

### `GET /health`

| server               |  req/sec | vs #1 | p50 | p99 |
| -------------------- | -------: | ----: | --: | --: |
| plain fastify        |   59,943 |  100% | <1ms | 1ms |
| **Basalt · fastify** |   49,884 |   83% | <1ms | 2ms |
| Basalt · express     |   32,136 |   54% | 1ms | 3ms |
| Basalt · hono        |   26,665 |   44% | 1ms | 4ms |

### `POST /echo` (Zod-validated)

| server               |  req/sec | vs #1 | p50 | p99 |
| -------------------- | -------: | ----: | --: | --: |
| plain fastify        |   39,114 |  100% | 1ms | 5ms |
| **Basalt · fastify** |   34,474 |   88% | 1ms | 5ms |
| Basalt · express     |   27,228 |   70% | 1ms | 3ms |
| Basalt · hono        |   18,987 |   49% | 2ms | 5ms |

## Reading the numbers

- **Basalt on Fastify keeps ~83–88% of raw Fastify throughput** — a ~10–17%
  overhead for the container, DI, plugin lifecycle, request context and metadata
  routing. Plain Fastify is the fastest row, as it should be: Basalt wraps it, so
  it can never beat it.
- **Express and Hono are slower because those runtimes are slower** — not because
  Basalt costs more on them. The Basalt layer is *byte-for-byte identical* across
  all three adapters (same `route()` objects); the gap you see is each adapter's
  own per-request cost. Choose an adapter for its ecosystem, not for a number
  Basalt would change.
- Even the slowest row serves **~19k validated requests/second on a laptop** —
  comfortably above what a typical multi-tenant SaaS API needs. Your database and
  network are the ceiling long before the framework is.

## Run it yourself

```bash
pnpm --filter @basaltkit/bench bench
# knobs (with defaults):
BENCH_CONNECTIONS=50 BENCH_DURATION=10 BENCH_ITERATIONS=3 BENCH_WARMUP=3 \
  pnpm --filter @basaltkit/bench bench
```
