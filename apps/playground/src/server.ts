import { defineEnv } from '@machize/env'
import { FASTIFY } from '@machize/fastify'
import { z } from 'zod'
import { buildApp } from './app.js'

const env = defineEnv({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

const app = await buildApp({
  logLevel: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
}).boot()

const server = app.container.get(FASTIFY)
await server.listen({ port: env.PORT, host: env.HOST })
console.log(`playground pronto em http://${env.HOST}:${env.PORT}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.shutdown()
    process.exit(0)
  })
}
