import { createApp } from '@basaltkit/core'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { routes } from './routes.js'
export async function startExpress(port: number) {
  const app = await createApp({ plugins: [expressPlugin({ routes })] }).boot()
  const server = app.container.get(EXPRESS).listen(port, '127.0.0.1')
  return { close: () => new Promise<void>((r) => server.close(() => r())) }
}
