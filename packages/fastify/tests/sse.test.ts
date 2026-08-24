import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { sse } from '@basaltkit/http'
import { fastifyPlugin, FASTIFY, route } from '../src/index.js'

async function start() {
  const app = await createApp({
    plugins: [
      fastifyPlugin({
        routes: [
          route({
            method: 'GET',
            url: '/stream',
            async handler() {
              return sse((s) => {
                s.send({ event: 'tick', data: { n: 1 } })
                s.send('bye')
                s.close()
              })
            },
          }),
        ],
        fastify: { logger: false },
      }),
    ],
  }).boot()
  const server = app.container.get(FASTIFY)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const addr = server.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { url: `http://127.0.0.1:${port}`, close: () => app.shutdown() }
}

describe('SSE on Fastify', () => {
  it('streams text/event-stream frames', async () => {
    const live = await start()
    try {
      const res = await fetch(`${live.url}/stream`)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const body = await res.text()
      expect(body).toBe('event: tick\ndata: {"n":1}\n\ndata: bye\n\n')
    } finally {
      await live.close()
    }
  })
})
