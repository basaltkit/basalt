import autocannon from 'autocannon'
import { startBasalt } from './basalt.js'
import { startExpress } from './express.js'
import { startHono } from './hono.js'
import { startFastify } from './fastify.js'

type Server = { close: () => unknown | Promise<unknown> }
type Row = { server: string; route: string; rps: number; p99: number; avg: number }

const DURATION = Number(process.env['BENCH_DURATION'] ?? 10)
const CONNECTIONS = Number(process.env['BENCH_CONNECTIONS'] ?? 50)

const targets = [
  { name: 'Basalt · fastify', start: startBasalt, port: 4001 },
  { name: 'Basalt · express', start: startExpress, port: 4002 },
  { name: 'Basalt · hono',    start: startHono,    port: 4003 },
  { name: 'plain fastify',    start: startFastify, port: 4004 },
]

const cannon = (opts: autocannon.Options) =>
  new Promise<autocannon.Result>((resolve, reject) =>
    autocannon(opts, (err, r) => (err ? reject(err) : resolve(r))),
  )

async function measure(name: string, port: number): Promise<Row[]> {
  const base = `http://127.0.0.1:${port}`
  const common = { connections: CONNECTIONS, duration: DURATION } as const
  // warm up
  await cannon({ url: `${base}/health`, connections: 10, duration: 2 })

  const health = await cannon({ url: `${base}/health`, ...common })
  const echo = await cannon({
    url: `${base}/echo`, ...common, method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'basalt', n: 21 }),
  })
  const row = (route: string, r: autocannon.Result): Row => ({
    server: name, route, rps: Math.round(r.requests.average), p99: r.latency.p99, avg: r.latency.average,
  })
  return [row('GET /health', health), row('POST /echo', echo)]
}

async function main() {
  const rows: Row[] = []
  for (const t of targets) {
    process.stdout.write(`\n▶ ${t.name} … `)
    let srv: Server | undefined
    try {
      srv = (await t.start(t.port)) as Server
      rows.push(...(await measure(t.name, t.port)))
      process.stdout.write('ok')
    } finally {
      if (srv) await srv.close()
    }
  }

  // pretty table grouped by route, with a "% of fastest" column
  const pad = (v: string | number, n: number) => String(v).padStart(n)
  for (const route of ['GET /health', 'POST /echo']) {
    const group = rows.filter((r) => r.route === route).sort((a, b) => b.rps - a.rps)
    const top = group[0]?.rps ?? 1
    console.log(`\n\n  ${route}   (${CONNECTIONS} conns · ${DURATION}s)`)
    console.log('  ┌──────────────────────┬───────────┬────────┬───────────┬──────────┐')
    console.log('  │ server               │   req/sec │  vs #1 │  avg (ms) │ p99 (ms) │')
    console.log('  ├──────────────────────┼───────────┼────────┼───────────┼──────────┤')
    for (const r of group) {
      const pct = `${Math.round((r.rps / top) * 100)}%`
      console.log(
        `  │ ${r.server.padEnd(20)} │ ${pad(r.rps, 9)} │ ${pad(pct, 6)} │ ${pad(r.avg.toFixed(2), 9)} │ ${pad(r.p99.toFixed(0), 8)} │`,
      )
    }
    console.log('  └──────────────────────┴───────────┴────────┴───────────┴──────────┘')
  }
  console.log('\n  Note: absolute numbers are machine-specific; read the *gaps* between rows.\n')
}

main().catch((e) => { console.error(e); process.exit(1) })
