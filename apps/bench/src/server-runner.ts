import { startBasalt } from './basalt.js'
import { startExpress } from './express.js'
import { startHono } from './hono.js'
import { startFastify } from './fastify.js'

/**
 * One server, one process. The parent (run.ts) spawns this per target so each
 * benchmark runs against a fresh Node process — no sockets, GC, JIT or
 * event-loop state carried over from another server. Kept alive by the server's
 * own handles; shuts down cleanly on SIGTERM.
 */
const starters: Record<string, (port: number) => Promise<{ close: () => unknown | Promise<unknown> }>> = {
  'basalt-fastify': startBasalt,
  'basalt-express': startExpress,
  'basalt-hono': startHono,
  fastify: startFastify,
}

const kind = process.argv[2] ?? ''
const port = Number(process.argv[3])
const start = starters[kind]
if (!start || !Number.isFinite(port)) {
  console.error(`usage: server-runner <${Object.keys(starters).join('|')}> <port>`)
  process.exit(1)
}

const server = await start(port)

const shutdown = async () => {
  try {
    await server.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
