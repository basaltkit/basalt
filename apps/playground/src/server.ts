import { defineEnv } from '@basaltkit/env'
import { LOG_LEVELS } from '@basaltkit/logger'
import { FASTIFY } from '@basaltkit/fastify'
import { EXPRESS } from '@basaltkit/express'
import { HONO } from '@basaltkit/hono'
import { z } from 'zod'
import { buildApp, type Adapter } from './app.js'

const env = defineEnv({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Swap the HTTP runtime without touching a route: ADAPTER=express pnpm dev
  ADAPTER: z.enum(['fastify', 'express', 'hono']).default('fastify'),
})

const adapter: Adapter = env.ADAPTER
const app = await buildApp({
  logLevel: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
  adapter,
}).boot()

/** Each adapter exposes its native server object; only the `listen` call differs. */
async function listen(): Promise<void> {
  if (adapter === 'express') {
    app.container.get(EXPRESS).listen(env.PORT, env.HOST)
    return
  }
  if (adapter === 'hono') {
    const { serve } = await import('@hono/node-server')
    serve({ fetch: app.container.get(HONO).fetch, port: env.PORT, hostname: env.HOST })
    return
  }
  await app.container.get(FASTIFY).listen({ port: env.PORT, host: env.HOST })
}

await listen()
console.log(`playground (${adapter}) ready at http://${env.HOST}:${env.PORT}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.shutdown()
    process.exit(0)
  })
}
