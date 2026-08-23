import { serve } from '@hono/node-server'
import { createApp } from '@basaltkit/core'
import { honoPlugin, HONO } from '@basaltkit/hono'
import { routes } from './routes.js'
export async function startHono(port: number) {
  const app = await createApp({ plugins: [honoPlugin({ routes })] }).boot()
  const hono = app.container.get(HONO)
  const server = serve({ fetch: hono.fetch, port, hostname: '127.0.0.1' })
  return { close: () => new Promise<void>((r) => server.close(() => r())) }
}
