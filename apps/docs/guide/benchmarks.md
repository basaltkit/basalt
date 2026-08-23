# Benchmarks

> *How much does Basalt's neutral core cost over the bare HTTP server?*

Short answer: **on Fastify, about 5–10%.** The container, plugin boot, route
metadata and validation pipeline are close to free. The reproducible harness
lives in [`apps/bench`](https://github.com/Zebedeu/basalt/tree/main/apps/bench).

## Method

The **same two routes** are defined once with the adapter-agnostic `route()` from
`@basaltkit/http` and served four ways — three Basalt adapters plus a hand-written
Fastify baseline:

- `GET /health` — trivial handler, measures pure framework overhead
- `POST /echo` — a Zod-validated body, measures the validation path

Each server is warmed up, then hit with [autocannon](https://github.com/mcollina/autocannon)
at 50 concurrent connections for 10 seconds.

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

## Results

`50 connections · 10s` on Apple Silicon / Node 22. **Absolute numbers are
machine-specific — read the gaps between rows, not the digits.**

### `GET /health`

| server               |  req/sec | vs #1 | avg | p99 |
| -------------------- | -------: | ----: | --: | --: |
| plain fastify        |   31,971 |  100% | 1.06ms | 2ms |
| **Basalt · fastify** |   30,337 |   95% | 1.12ms | 3ms |
| Basalt · express     |   21,656 |   68% | 1.98ms | 4ms |
| Basalt · hono        |   20,498 |   64% | 2.07ms | 3ms |

### `POST /echo` (Zod-validated)

| server               |  req/sec | vs #1 | avg | p99 |
| -------------------- | -------: | ----: | --: | --: |
| plain fastify        |   25,429 |  100% | 1.29ms | 5ms |
| **Basalt · fastify** |   22,990 |   90% | 1.59ms | 5ms |
| Basalt · express     |   16,434 |   65% | 2.53ms | 9ms |
| Basalt · hono        |   14,607 |   57% | 3.03ms | 5ms |

## Reading the numbers

- **Basalt keeps ~90–95% of raw Fastify throughput.** The neutral core adds
  single-digit percent overhead — you don't pay meaningfully for the container,
  DI, plugin lifecycle or metadata routing.
- **Express and Hono are slower because those runtimes are slower** — not because
  Basalt costs more on them. The Basalt layer is *byte-for-byte identical* across
  all three adapters (same `route()` objects); the gap you see is each adapter's
  own per-request cost. Choose an adapter for its ecosystem, not for a number
  Basalt would change.
- Even the slowest row serves **~14k validated requests/second on a laptop** —
  comfortably above what a typical multi-tenant SaaS API needs. Your database and
  network are the ceiling long before the framework is.

## Run it yourself

```bash
pnpm --filter @basaltkit/bench bench
BENCH_DURATION=20 BENCH_CONNECTIONS=100 pnpm --filter @basaltkit/bench bench
```
