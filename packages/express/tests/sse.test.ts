import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { sse, route } from '@basaltkit/http'
import { expressPlugin, EXPRESS } from '../src/index.js'

const routes = [
  route({
    method: 'GET', url: '/stream',
    async handler() {
      return sse((s) => { s.send({ event: 'tick', data: { n: 1 } }); s.send('bye'); s.close() })
    },
  }),
]

describe('SSE on Express', () => {
  it('streams text/event-stream frames', async () => {
    const app = await createApp({ plugins: [expressPlugin({ routes })] }).boot()
    const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      const res = await fetch(`http://127.0.0.1:${port}/stream`)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(await res.text()).toBe('event: tick\ndata: {"n":1}\n\ndata: bye\n\n')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      await app.shutdown()
    }
  })
})
