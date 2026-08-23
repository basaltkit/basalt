import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { routes } from './routes.js'
export async function startBasalt(port: number) {
  const app = await createApp({ plugins: [fastifyPlugin({ routes, fastify: { logger: false } })] }).boot()
  await app.container.get(FASTIFY).listen({ port, host: '127.0.0.1' })
  return { close: () => app.shutdown() }
}
