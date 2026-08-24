import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { sse, route } from '@basaltkit/http'
import { honoPlugin, HONO } from '../src/index.js'

describe('SSE on Hono', () => {
  it('streams text/event-stream frames via a ReadableStream Response', async () => {
    const app = await createApp({
      plugins: [
        honoPlugin({
          routes: [
            route({
              method: 'GET', url: '/stream',
              async handler() {
                return sse((s) => { s.send({ event: 'tick', data: { n: 1 } }); s.send('bye'); s.close() })
              },
            }),
          ],
        }),
      ],
    }).boot()

    // Hono is fetch-based — invoke it directly, no server needed.
    const res = await app.container.get(HONO).fetch(new Request('http://localhost/stream'))
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toBe('event: tick\ndata: {"n":1}\n\ndata: bye\n\n')
    await app.shutdown()
  })
})
