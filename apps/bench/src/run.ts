import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import autocannon from 'autocannon'

// Each knob is overridable via env. Defaults are modest so a run finishes in ~5 min.
const DURATION = Number(process.env['BENCH_DURATION'] ?? 10) // measured seconds per route
const CONNECTIONS = Number(process.env['BENCH_CONNECTIONS'] ?? 50)
const ITERATIONS = Number(process.env['BENCH_ITERATIONS'] ?? 3) // measured runs; the median is reported
const WARMUP = Number(process.env['BENCH_WARMUP'] ?? 3) // discarded warmup seconds per process

const runnerPath = fileURLToPath(new URL('./server-runner.ts', import.meta.url))
const benchDir = fileURLToPath(new URL('..', import.meta.url))

type Target = { name: string; kind: string; port: number }
const targets: Target[] = [
  { name: 'Basalt · fastify', kind: 'basalt-fastify', port: 4001 },
  { name: 'Basalt · express', kind: 'basalt-express', port: 4002 },
  { name: 'Basalt · hono', kind: 'basalt-hono', port: 4003 },
  { name: 'plain fastify', kind: 'fastify', port: 4004 },
]

type Sample = { rps: number; p50: number; p99: number; bad: number }
type Row = { server: string; route: string; rps: number; p50: number; p99: number; bad: number }

const cannon = (opts: autocannon.Options) =>
  new Promise<autocannon.Result>((resolve, reject) =>
    autocannon(opts, (err, r) => (err ? reject(err) : resolve(r))),
  )
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Start one server in its own process and wait until it answers `/health`. */
async function spawnServer(t: Target): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', runnerPath, t.kind, String(t.port)], {
    cwd: benchDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const base = `http://127.0.0.1:${t.port}`
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${t.name} exited during startup (code ${child.exitCode})`)
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) {
        await r.arrayBuffer()
        return child
      }
    } catch {
      /* not listening yet */
    }
    await sleep(150)
  }
  child.kill('SIGKILL')
  throw new Error(`${t.name} did not become ready on port ${t.port}`)
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const hard = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(hard)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

/** Extract robust stats: throughput and p50/p99 latency (never the mean, which outliers skew). */
const sample = (r: autocannon.Result): Sample => {
  const latency = r.latency as unknown as { p50: number; p99: number }
  const requests = r.requests as unknown as { average: number }
  return {
    rps: Math.round(requests.average),
    p50: latency.p50,
    p99: latency.p99,
    bad: r.timeouts + r.errors + r.non2xx,
  }
}

async function benchOne(t: Target): Promise<Row[]> {
  const child = await spawnServer(t)
  const base = `http://127.0.0.1:${t.port}`
  try {
    // Warmup at the *measurement* concurrency, discarded — establishes all
    // connections and warms the JIT so the measured runs don't pay for it.
    await cannon({ url: `${base}/health`, connections: CONNECTIONS, duration: WARMUP })

    const health: Sample[] = []
    const echo: Sample[] = []
    for (let i = 0; i < ITERATIONS; i++) {
      health.push(sample(await cannon({ url: `${base}/health`, connections: CONNECTIONS, duration: DURATION })))
      await sleep(500) // let sockets drain between runs
      echo.push(
        sample(
          await cannon({
            url: `${base}/echo`,
            connections: CONNECTIONS,
            duration: DURATION,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'basalt', n: 21 }),
          }),
        ),
      )
      await sleep(500)
    }

    const fold = (route: string, ss: Sample[]): Row => ({
      server: t.name,
      route,
      rps: Math.round(median(ss.map((s) => s.rps))),
      p50: median(ss.map((s) => s.p50)),
      p99: median(ss.map((s) => s.p99)),
      bad: ss.reduce((n, s) => n + s.bad, 0),
    })
    return [fold('GET /health', health), fold('POST /echo', echo)]
  } finally {
    await stopServer(child)
    await sleep(1000) // cooldown before the next server
  }
}

async function main() {
  console.log(
    `\n  Benchmark — ${CONNECTIONS} conns · ${DURATION}s · median of ${ITERATIONS} iteration(s) · ${WARMUP}s warmup`,
  )
  console.log('  Each server runs in its own process (isolated sockets, GC and JIT).')

  const rows: Row[] = []
  for (const t of targets) {
    process.stdout.write(`\n▶ ${t.name} … `)
    rows.push(...(await benchOne(t)))
    process.stdout.write('ok')
  }

  const pad = (v: string | number, n: number) => String(v).padStart(n)
  for (const route of ['GET /health', 'POST /echo']) {
    const group = rows.filter((r) => r.route === route).sort((a, b) => b.rps - a.rps)
    const top = group[0]?.rps ?? 1
    console.log(`\n\n  ${route}`)
    console.log('  ┌──────────────────────┬───────────┬────────┬───────────┬───────────┬────────┐')
    console.log('  │ server               │   req/sec │  vs #1 │  p50 (ms) │  p99 (ms) │ errors │')
    console.log('  ├──────────────────────┼───────────┼────────┼───────────┼───────────┼────────┤')
    for (const r of group) {
      const pct = `${Math.round((r.rps / top) * 100)}%`
      console.log(
        `  │ ${r.server.padEnd(20)} │ ${pad(r.rps, 9)} │ ${pad(pct, 6)} │ ${pad(r.p50.toFixed(2), 9)} │ ${pad(r.p99.toFixed(0), 9)} │ ${pad(r.bad, 6)} │`,
      )
    }
    console.log('  └──────────────────────┴───────────┴────────┴───────────┴───────────┴────────┘')
  }
  console.log('\n  Latency is p50 (median) and p99 — robust to outliers; `errors` should be 0.')
  console.log('  Absolute numbers are machine-specific; read the *gaps* between rows.\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
